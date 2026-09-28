import {
  AUTO_PREVIEW_MS,
  DEFAULT_MAX_STEPS,
  KEEPALIVE_MS,
  SETTLE_MS,
  STORAGE_KEYS,
} from '../shared/constants';
import { evaluateSite } from '../shared/domainPolicy';
import { SimpleContentResponseSchema, type BgToUiMessage } from '../shared/messages';
import { redactForLog, redactText, truncate } from '../shared/redaction';
import { describeTarget, isMutating } from '../shared/risk';
import {
  ExecResultSchema,
  MapResponseSchema,
  PersistedRunSchema,
  type ElementDescriptor,
  type ExecResult,
  type ExtractedData,
  type LogEntry,
  type Mode,
  type PageMap,
  type PanelState,
  type PersistedRun,
  type Proposal,
  type RunStatus,
  type Settings,
} from '../shared/schemas';
import { canTransition, isActiveStatus } from '../shared/stateMachine';
import type { HistoryItem } from '../shared/types';
import { decide, literalTextOf, modelReason, summarizeAction } from './actionPolicy';
import { appendLog } from './activityLog';
import { debugLog, recordError, setDebug } from './debug';
import { LlmError, buildChatPayload, requestAction, type PlanContext } from './llmClient';
import { getApiKey, getSettings, isDisclosureAcknowledged } from './settings';
import {
  UserError,
  ensureContentScript,
  getActiveTab,
  isPortClosedError,
  sendToContent,
  sleep,
  waitForTabComplete,
} from './tabs';

class RunStopped extends Error {
  constructor() {
    super('Run stopped');
    this.name = 'RunStopped';
  }
}

type Decision = 'approve' | 'reject' | 'stop';

/**
 * Identity of one run. Every state-changing method takes the ctx of the loop that calls it, so a
 * superseded loop (e.g. one still parked in an un-abortable await after Stop → Run) can never touch
 * the state of a newer run.
 */
interface RunCtx {
  readonly id: string;
  readonly controller: AbortController;
}

const RESTART_MESSAGE =
  'The extension’s background worker restarted, so the previous run was stopped. Start it again if you still need it.';

export class AgentOrchestrator {
  private run: RunCtx | null = null;
  private status: RunStatus = 'idle';
  private statusDetail: string | null = null;
  private runId: string | null = null;
  private tabId: number | null = null;
  private prompt = '';
  private baseGoal = '';
  private step = 0;
  private maxSteps = DEFAULT_MAX_STEPS;
  private proposal: Proposal | null = null;
  private proposalTarget: { id: string; fingerprint: string } | null = null;
  private pageChanged = false;
  private extracted: ExtractedData[] = [];
  private lastExtraction: string | null = null;
  private lastError: string | null = null;
  private finalResult: string | null = null;
  private question: string | null = null;
  private dryRunPayload: string | null = null;
  private history: HistoryItem[] = [];
  private lastQuestion: { question: string; goal: string } | null = null;
  private pending: { actionId: string; resolve: (d: Decision) => void } | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Rehydrate safe state after a service-worker restart. Never restores DOM refs or proposals. */
  async init(): Promise<void> {
    try {
      const raw = (await chrome.storage.session.get(STORAGE_KEYS.run))[STORAGE_KEYS.run] as unknown;
      const parsed = PersistedRunSchema.safeParse(raw);
      if (!parsed.success) return;
      const p = parsed.data;
      this.runId = p.runId;
      this.tabId = p.tabId;
      this.prompt = p.prompt;
      this.step = p.step;
      this.maxSteps = p.maxSteps;
      if (isActiveStatus(p.status)) {
        this.status = 'stopped';
        this.statusDetail = RESTART_MESSAGE;
        this.persist();
      } else {
        this.status = p.status;
        this.lastError = p.lastError;
      }
    } catch {
      /* session storage unavailable: start clean */
    }
  }

  isActive(): boolean {
    return isActiveStatus(this.status);
  }

  /** The run's tab was closed: stop rather than act on nothing. */
  handleTabClosed(tabId: number): void {
    if (this.tabId === tabId) this.stop('The tab was closed, so the run was stopped.');
  }

  /** The content script noticed a material DOM change. While waiting for approval, warn the user. */
  markMapStale(): void {
    debugLog('map_stale');
    if (this.status === 'awaiting_confirmation' && !this.pageChanged) {
      this.pageChanged = true;
      this.publish();
    }
  }

  async getSnapshot(): Promise<PanelState> {
    const [settings, apiKey, ack, tab] = await Promise.all([
      getSettings(),
      getApiKey(),
      isDisclosureAcknowledged(),
      getActiveTab().catch(() => null),
    ]);
    return {
      status: this.status,
      runId: this.runId,
      prompt: this.prompt,
      step: this.step,
      maxSteps: this.maxSteps,
      mode: settings.mode,
      modelId: settings.modelId,
      dryRun: settings.dryRun,
      apiKeySet: apiKey.length > 0,
      disclosureAcknowledged: ack,
      site: evaluateSite(tab?.url, settings, tab?.incognito ?? false),
      proposal: this.proposal,
      pageChanged: this.pageChanged,
      extracted: this.extracted,
      statusDetail: this.statusDetail,
      lastError: this.lastError,
      finalResult: this.finalResult,
      question: this.question,
      dryRunPayload: this.dryRunPayload,
    };
  }

  /** Broadcast the current state to any open side panel. */
  publish(): void {
    void this.getSnapshot()
      .then((state) => this.broadcast({ type: 'bg/state', state }))
      .catch(() => undefined);
  }

  private broadcast(msg: BgToUiMessage): void {
    try {
      void chrome.runtime.sendMessage(msg).catch(() => undefined); // no receiver when the panel is closed
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    const p: PersistedRun = {
      status: this.status,
      runId: this.runId,
      tabId: this.tabId,
      prompt: truncate(this.prompt, 500),
      step: this.step,
      maxSteps: this.maxSteps,
      lastError: this.lastError,
    };
    void chrome.storage.session.set({ [STORAGE_KEYS.run]: p }).catch(() => undefined);
  }

  private isCurrent(ctx: RunCtx): boolean {
    return this.run === ctx && !ctx.controller.signal.aborted;
  }

  /** Throws RunStopped when `ctx` has been stopped or superseded by a newer run. */
  private assertCurrent(ctx: RunCtx): void {
    if (!this.isCurrent(ctx)) throw new RunStopped();
  }

  private async log(
    ctx: RunCtx,
    e: Pick<LogEntry, 'actionType' | 'actionSummary' | 'outcome'> &
      Partial<Pick<LogEntry, 'target' | 'risk' | 'detail'>>,
  ): Promise<void> {
    if (this.run !== ctx) return; // superseded loops do not write to the log
    const entry = await appendLog({
      runId: ctx.id,
      prompt: this.prompt || null,
      target: null,
      risk: null,
      detail: null,
      ...e,
    });
    this.broadcast({ type: 'bg/log', entry });
    debugLog('log', { outcome: entry.outcome, action: entry.actionType });
  }

  private setStatus(ctx: RunCtx, next: RunStatus, detail: string | null = null): void {
    this.assertCurrent(ctx);
    if (this.status !== next && !canTransition(this.status, next)) {
      throw new Error(`Invalid state transition ${this.status} → ${next}`);
    }
    this.status = next;
    this.statusDetail = detail;
    debugLog('state', { status: next, step: this.step });
    this.persist();
    this.publish();
  }

  private fail(ctx: RunCtx, message: string): void {
    if (!this.isCurrent(ctx)) return;
    this.lastError = truncate(redactText(message), 600);
    void recordError(this.lastError);
    if (this.status !== 'error' && canTransition(this.status, 'error')) this.status = 'error';
    this.statusDetail = null;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run failed', outcome: 'failed', detail: this.lastError });
    this.persist();
    this.publish();
  }

  private finishStopped(ctx: RunCtx, message: string): void {
    if (!this.isCurrent(ctx)) return;
    if (this.status !== 'stopped' && canTransition(this.status, 'stopped')) this.status = 'stopped';
    this.statusDetail = message;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run stopped', outcome: 'stopped', detail: message });
    this.persist();
    this.publish();
  }

  private resetRun(): void {
    this.status = 'idle';
    this.statusDetail = null;
    this.step = 0;
    this.proposal = null;
    this.proposalTarget = null;
    this.pageChanged = false;
    this.extracted = [];
    this.lastExtraction = null;
    this.lastError = null;
    this.finalResult = null;
    this.question = null;
    this.dryRunPayload = null;
    this.history = [];
    this.pending = null;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Any extension API call resets the MV3 idle timer, so a long wait for approval survives.
    this.keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  /* ---------------------------------------------------------------- */
  /* commands from the side panel                                      */
  /* ---------------------------------------------------------------- */

  async start(rawPrompt: string): Promise<void> {
    if (this.isActive()) throw new UserError('A run is already in progress. Stop it first.');
    const settings = await getSettings();
    setDebug(settings.debug);
    const apiKey = await getApiKey();
    if (this.isActive()) throw new UserError('A run is already in progress. Stop it first.');

    // A new identity for this run; any older loop still parked in an await is now superseded.
    this.run?.controller.abort();
    const ctx: RunCtx = { id: crypto.randomUUID(), controller: new AbortController() };
    this.run = ctx;
    this.resetRun();
    this.runId = ctx.id;
    this.maxSteps = settings.maxSteps;
    // Prompts are redacted before they can reach the model, the log, or session storage.
    this.prompt = redactText(rawPrompt.trim());
    const answering = this.lastQuestion;
    this.lastQuestion = null;
    this.baseGoal = answering ? answering.goal : this.prompt;
    const goal = answering
      ? `${answering.goal}\n\nYou previously asked the user: "${answering.question}"\nThe user answered: "${this.prompt}"`
      : this.prompt;

    const abortWith = (msg: string, outcome: 'blocked' | 'failed' = 'failed') => {
      this.lastError = msg;
      this.status = 'error';
      void this.log(ctx, { actionType: 'run', actionSummary: 'Run could not start', outcome, detail: msg });
      this.persist();
      this.publish();
    };

    if (!(await isDisclosureAcknowledged())) {
      return abortWith('Please read and accept the privacy disclosure in the side panel before running.');
    }
    const tab = await getActiveTab();
    if (!tab?.id) return abortWith('No active tab was found.');
    const verdict = evaluateSite(tab.url, settings, tab.incognito);
    if (!verdict.allowed) return abortWith(verdict.message, 'blocked');
    if (!settings.dryRun) {
      if (!apiKey) return abortWith('No API key is configured. Open Settings and add one.');
      if (!settings.modelId) return abortWith('No model ID is configured. Open Settings and add one.');
    }

    this.tabId = tab.id;
    await this.log(ctx, { actionType: 'run', actionSummary: 'Run started', outcome: 'run_started', detail: verdict.host });
    this.startKeepAlive();
    this.setStatus(ctx, 'collecting_page_context', 'Reading the page…');
    void this.runLoop(ctx, settings, apiKey, goal);
  }

  approve(actionId: string): boolean {
    if (this.status !== 'awaiting_confirmation' || this.pending?.actionId !== actionId) return false;
    const p = this.pending;
    this.pending = null;
    p.resolve('approve');
    return true;
  }

  reject(actionId: string): boolean {
    if (this.status !== 'awaiting_confirmation' || this.pending?.actionId !== actionId) return false;
    const p = this.pending;
    this.pending = null;
    p.resolve('reject');
    return true;
  }

  /** Re-highlight the currently proposed target on the page. */
  async preview(actionId: string): Promise<boolean> {
    if (this.proposal?.actionId !== actionId || !this.proposalTarget || this.tabId === null) return false;
    try {
      const r = await sendToContent(
        this.tabId,
        {
          type: 'cs/highlight',
          targetId: this.proposalTarget.id,
          fingerprint: this.proposalTarget.fingerprint,
          label: truncate(this.proposal.summary, 80),
        },
        SimpleContentResponseSchema,
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  stop(reason = 'Stopped by you.'): void {
    const ctx = this.run;
    if (!ctx || !this.isActive()) return;
    ctx.controller.abort();
    this.pending?.resolve('stop');
    this.pending = null;
    this.proposal = null;
    this.status = 'stopped';
    this.statusDetail = reason;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run stopped', outcome: 'stopped', detail: reason });
    void this.clearHighlight();
    this.stopKeepAlive();
    this.persist();
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* the loop                                                          */
  /* ---------------------------------------------------------------- */

  private async clearHighlight(): Promise<void> {
    if (this.tabId === null) return;
    try {
      await chrome.tabs.sendMessage(this.tabId, { type: 'cs/clear_highlight' });
    } catch {
      /* page gone or script not injected */
    }
  }

  private async collect(tabId: number): Promise<PageMap> {
    await ensureContentScript(tabId);
    const r = await sendToContent(tabId, { type: 'cs/collect_map' }, MapResponseSchema);
    if (!r.ok) throw new UserError(r.message);
    return r.map;
  }

  private async assertTabStillAllowed(tabId: number, settings: Settings): Promise<string | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return 'The tab was closed.';
    const v = evaluateSite(tab.url, settings, tab.incognito);
    return v.allowed ? null : v.message;
  }

  private async runLoop(ctx: RunCtx, settings: Settings, apiKey: string, goal: string): Promise<void> {
    const tabId = this.tabId!;
    const signal = ctx.controller.signal;
    const mode: Mode = settings.mode;
    const userGoal = `${this.baseGoal} ${this.prompt}`; // only what the user typed, never model output
    let badTargets = 0;

    try {
      while (this.step < this.maxSteps) {
        this.assertCurrent(ctx);
        this.step++;
        this.setStatus(ctx, 'collecting_page_context', 'Reading the page…');

        const blocked = await this.assertTabStillAllowed(tabId, settings);
        this.assertCurrent(ctx);
        if (blocked) {
          await this.log(ctx, { actionType: 'run', actionSummary: 'Blocked page', outcome: 'blocked', detail: blocked });
          return this.fail(ctx, blocked);
        }

        let map = await this.collect(tabId);
        this.assertCurrent(ctx);

        const planCtx: PlanContext = {
          goal,
          map,
          history: this.history,
          step: this.step,
          maxSteps: this.maxSteps,
          lastExtraction: this.lastExtraction,
        };

        if (settings.dryRun) {
          // Dry run: build the exact request, show it (no secrets exist in the body), send nothing.
          const payload = buildChatPayload(settings.modelId || '<model-id>', planCtx);
          this.dryRunPayload = JSON.stringify(redactForLog(payload), null, 2);
          this.finalResult = 'Dry run: the request below was built but NOT sent, and no action was executed.';
          this.setStatus(ctx, 'calling_model', 'Building request (dry run)…');
          this.setStatus(ctx, 'completed', 'Dry run complete');
          await this.log(ctx, { actionType: 'run', actionSummary: 'Dry run', outcome: 'completed', detail: 'No request sent' });
          return;
        }

        this.setStatus(ctx, 'calling_model', 'Asking the model for the next step…');
        let plan;
        try {
          plan = await requestAction({ settings, apiKey, signal }, planCtx);
        } catch (e) {
          if (e instanceof LlmError) {
            if (e.code === 'aborted') throw new RunStopped();
            return this.fail(ctx, e.message);
          }
          throw e;
        }
        this.assertCurrent(ctx);

        this.setStatus(ctx, 'validating_action', 'Checking the proposed action…');
        const action = plan.action;
        debugLog('action_validated', { type: action.type, repaired: plan.repaired });

        if (action.type === 'complete') {
          this.finalResult = redactText(action.result);
          await this.log(ctx, { actionType: 'complete', actionSummary: 'Finished', outcome: 'completed', detail: this.finalResult });
          this.setStatus(ctx, 'completed', 'Done');
          return;
        }
        if (action.type === 'ask_user') {
          this.question = redactText(action.question);
          this.lastQuestion = { question: this.question, goal: this.baseGoal };
          await this.log(ctx, { actionType: 'ask_user', actionSummary: 'Asked a question', outcome: 'info', detail: this.question });
          this.setStatus(ctx, 'completed', 'The assistant needs more information from you.');
          return;
        }
        if (action.type === 'observe') {
          this.history.push({ step: this.step, action: 'observe', outcome: truncate(redactText(action.reason), 120) });
          await this.log(ctx, { actionType: 'observe', actionSummary: 'Re-read the page', outcome: 'info', detail: action.reason });
          continue;
        }

        // ---- target verification against the map we just collected ----
        let target: ElementDescriptor | null = null;
        if ('targetId' in action) {
          target = map.elements.find((e) => e.id === action.targetId) ?? null;
          if (!target) {
            badTargets++;
            this.history.push({
              step: this.step,
              action: `${action.type} ${action.targetId}`,
              outcome: 'REJECTED: that id is not in page.elements',
            });
            await this.log(ctx, {
              actionType: action.type,
              actionSummary: `Model referenced unknown element ${action.targetId}`,
              outcome: 'failed',
              detail: 'Target id not in the current page map',
            });
            if (badTargets >= 2) {
              return this.fail(ctx, 'The model kept referring to elements that are not on the page, so the run was stopped.');
            }
            continue;
          }
          badTargets = 0;

          // Off-screen targets: the extension scrolls them into view, then regenerates the map.
          if (isMutating(action) && !target.inViewport) {
            const r = await sendToContent(
              tabId,
              { type: 'cs/scroll_to_target', targetId: target.id, fingerprint: target.fingerprint },
              SimpleContentResponseSchema,
            );
            this.assertCurrent(ctx);
            if (!r.ok) return this.fail(ctx, r.message);
            await sleep(150);
            this.assertCurrent(ctx);
            map = await this.collect(tabId);
            this.assertCurrent(ctx);
            const again = map.elements.find((e) => e.id === target!.id);
            if (!again || again.fingerprint !== target.fingerprint) {
              return this.fail(ctx, 'The button was not found after the page changed.');
            }
            target = again;
          }
        }

        // ---- local risk classification + policy (the model has no say) ----
        const { assessment, decision } = decide(action, target, map.url, mode, userGoal);
        const proposal: Proposal = {
          actionId: crypto.randomUUID(),
          action,
          summary: summarizeAction(action, target),
          targetDescription: target ? describeTarget(target) : null,
          modelReason: modelReason(action),
          literalText: literalTextOf(action, target),
          risk: assessment,
          autoExecute: decision === 'auto',
        };
        this.proposal = proposal;
        this.proposalTarget = target ? { id: target.id, fingerprint: target.fingerprint } : null;
        this.pageChanged = false;
        await this.log(ctx, {
          actionType: action.type,
          actionSummary: proposal.summary,
          target: proposal.targetDescription,
          risk: assessment.risk,
          outcome: 'proposed',
          detail: assessment.reasons.join('; '),
        });
        this.assertCurrent(ctx);

        // ---- visible highlight before anything happens ----
        if (target) {
          const h = await sendToContent(
            tabId,
            { type: 'cs/highlight', targetId: target.id, fingerprint: target.fingerprint, label: truncate(proposal.summary, 80) },
            SimpleContentResponseSchema,
          );
          this.assertCurrent(ctx);
          if (!h.ok) return this.fail(ctx, h.message);
        }

        if (decision === 'confirm') {
          this.setStatus(ctx, 'awaiting_confirmation', 'Waiting for your approval…');
          const d = await new Promise<Decision>((resolve) => {
            this.pending = { actionId: proposal.actionId, resolve };
          });
          this.assertCurrent(ctx);
          if (d === 'stop') throw new RunStopped();
          if (d === 'reject') {
            await this.log(ctx, {
              actionType: action.type,
              actionSummary: proposal.summary,
              target: proposal.targetDescription,
              risk: assessment.risk,
              outcome: 'rejected',
              detail: 'Rejected by user',
            });
            await this.clearHighlight();
            this.proposal = null;
            return this.finishStopped(ctx, 'You rejected the proposed action, so the run was stopped.');
          }
          await this.log(ctx, {
            actionType: action.type,
            actionSummary: proposal.summary,
            target: proposal.targetDescription,
            risk: assessment.risk,
            outcome: 'approved',
          });
        } else {
          if (target) await sleep(AUTO_PREVIEW_MS);
          this.assertCurrent(ctx);
        }

        const blockedNow = await this.assertTabStillAllowed(tabId, settings);
        this.assertCurrent(ctx);
        if (blockedNow) return this.fail(ctx, blockedNow);

        // ---- execute exactly this one action through the content script ----
        this.setStatus(ctx, 'executing', 'Running the approved action…');
        let result: ExecResult;
        try {
          result = await sendToContent(
            tabId,
            { type: 'cs/execute', action, fingerprint: target?.fingerprint },
            ExecResultSchema,
          );
        } catch (e) {
          if (action.type === 'click' && isPortClosedError(e)) {
            result = { ok: true, message: 'The page navigated after the click.', navigating: true };
          } else {
            throw e;
          }
        }
        this.assertCurrent(ctx);
        this.proposal = null;
        this.proposalTarget = null;

        if (!result.ok) {
          await this.log(ctx, {
            actionType: action.type,
            actionSummary: proposal.summary,
            target: proposal.targetDescription,
            risk: assessment.risk,
            outcome: 'failed',
            detail: `${result.code}: ${result.message}`,
          });
          return this.fail(ctx, result.message);
        }

        await this.log(ctx, {
          actionType: action.type,
          actionSummary: proposal.summary,
          target: proposal.targetDescription,
          risk: assessment.risk,
          outcome: decision === 'auto' ? 'auto_executed' : 'executed',
          detail: result.message,
        });
        this.history.push({ step: this.step, action: truncate(proposal.summary, 160), outcome: truncate(result.message, 160) });
        if (result.extracted) {
          this.extracted = [...this.extracted, result.extracted].slice(-10);
          this.lastExtraction = extractionToText(result.extracted);
        }

        this.setStatus(ctx, 'observing_result', 'Checking the result…');
        await this.settle(tabId, !!result.navigating);
        this.assertCurrent(ctx);
      }

      this.finishStopped(ctx, `Reached the step limit (${this.maxSteps}). Raise “Maximum agent steps” in Settings if needed.`);
    } catch (e) {
      if (e instanceof RunStopped) return;
      const msg = e instanceof UserError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      this.fail(ctx, msg);
    } finally {
      // Only the current run may clean up shared state; a superseded loop must not disturb its successor.
      if (this.run === ctx) {
        this.stopKeepAlive();
        this.proposal = null;
        this.pending = null;
        void this.clearHighlight();
        this.persist();
        this.publish();
      }
    }
  }

  private async settle(tabId: number, navigating: boolean): Promise<void> {
    await sleep(SETTLE_MS);
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (navigating || t?.status === 'loading') await waitForTabComplete(tabId);
  }
}

function extractionToText(x: ExtractedData): string {
  if (x.format === 'text') return x.text ?? '';
  if (x.format === 'table') return (x.rows ?? []).map((r) => r.join(' | ')).join('\n');
  return (x.links ?? []).map((l) => `${l.text} -> ${l.href}`).join('\n');
}
