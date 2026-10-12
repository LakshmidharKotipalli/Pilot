import { AUTO_PREVIEW_MS, MAX_CONSECUTIVE_FAILURES, SETTLE_MS } from '../shared/constants';
import { evaluateSite } from '../shared/domainPolicy';
import { SimpleContentResponseSchema } from '../shared/messages';
import { redactForLog, redactText, truncate } from '../shared/redaction';
import { describeTarget, isMutating } from '../shared/risk';
import {
  ExecResultSchema,
  MapResponseSchema,
  type DecisionView,
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
  type SessionSummary,
  type Settings,
} from '../shared/schemas';
import { canTransition, isActiveStatus } from '../shared/stateMachine';
import type { HistoryItem } from '../shared/types';
import { decide, literalTextOf, modelReason, summarizeAction } from './actionPolicy';
import { appendLog, upsertLog } from './activityLog';
import { debugLog, recordError, setDebug } from './debug';
import { LlmError, buildChatPayload, requestAction, type PlanContext } from './llmClient';
import { LoopGuard, stepSignature } from './loopGuard';
import { emitRunLog } from './runLogSink';
import { isInScope, originOf, scopeViolation } from './scope';
import { getApiKey, getSettings, isDisclosureAcknowledged } from './settings';
import {
  UserError,
  ensureContentScript,
  isPortClosedError,
  sendToContent,
  sendToTab,
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

/** What a session needs from whoever owns it (the SessionManager, or a test double). */
export interface SessionDeps {
  /** Something visible changed: persist all sessions and broadcast this one. */
  onChange(session: Session): void;
  onLog(entry: LogEntry): void;
  /** The origin the user approved for this tab's session, or null when there is no approval. */
  approvedOrigin(tabId: number): string | null;
  /** Drop the approval for this tab (it navigated somewhere the user has not approved). */
  revokeApproval(tabId: number): void;
}

export const RESTART_MESSAGE =
  'The extension’s background worker restarted, so the previous run was stopped. Start it again if you still need it.';

/**
 * One agent run, bound for its whole life to the tab it started on. It never looks at "the active
 * tab": everything it reads, highlights or executes goes to `tabId`.
 */
export class Session {
  private run: RunCtx | null = null;
  private status: RunStatus = 'idle';
  private statusDetail: string | null = null;
  private runId: string | null = null;
  private host: string | null = null;
  /** The origin this run is confined to; set when the run starts. */
  private startOrigin: string | null = null;
  /** Steps in a row that did not work; reset by any action that ran. */
  private failures = 0;
  private prompt = '';
  private baseGoal = '';
  private step = 0;
  private proposal: Proposal | null = null;
  private proposalTarget: { id: string; fingerprint: string } | null = null;
  private pageChanged = false;
  private extracted: ExtractedData[] = [];
  private lastExtraction: string | null = null;
  private lastError: string | null = null;
  private finalResult: string | null = null;
  private question: string | null = null;
  private loopSummary: string | null = null;
  private dryRunPayload: string | null = null;
  /** Identity of the document the last page map came from; every action is pinned to it. */
  private docId: string | null = null;
  private history: HistoryItem[] = [];
  private lastQuestion: { question: string; goal: string } | null = null;
  private pending: { actionId: string; resolve: (d: Decision) => void } | null = null;
  private loopPending: ((d: Decision) => void) | null = null;
  private readonly loopGuard = new LoopGuard();

  constructor(
    readonly id: string,
    readonly tabId: number,
    private readonly deps: SessionDeps,
  ) {}

  /** Rebuild a finished view of a session after a service-worker restart. Never restores DOM refs or proposals. */
  static restore(p: PersistedRun, deps: SessionDeps): Session {
    const s = new Session(p.sessionId, p.tabId, deps);
    s.runId = p.runId;
    s.prompt = p.prompt;
    s.step = p.step;
    if (isActiveStatus(p.status)) {
      s.status = 'stopped';
      s.statusDetail = RESTART_MESSAGE;
    } else {
      s.status = p.status;
      s.lastError = p.lastError;
    }
    return s;
  }

  /* ---------------------------------------------------------------- */
  /* read side                                                         */
  /* ---------------------------------------------------------------- */

  isActive(): boolean {
    return isActiveStatus(this.status);
  }

  getStatus(): RunStatus {
    return this.status;
  }

  getHost(): string | null {
    return this.host;
  }

  /** Free-text the user typed, already redacted. Used only for the popup and the log. */
  getPrompt(): string {
    return this.prompt;
  }

  getProposal(): Proposal | null {
    return this.proposal;
  }

  /** The question to carry into the next run on this tab (the user's answer), if there is one. */
  takeLastQuestion(): { question: string; goal: string } | null {
    const q = this.lastQuestion;
    this.lastQuestion = null;
    return q;
  }

  /** What this session is waiting on the user for, if anything. */
  getDecision(): DecisionView | null {
    const base = {
      sessionId: this.id,
      tabId: this.tabId,
      host: this.host,
      prompt: truncate(this.prompt, 200),
      status: this.status,
      proposal: null,
      pageChanged: this.pageChanged,
      question: null,
      loopSummary: null,
    };
    if (this.status === 'awaiting_confirmation' && this.proposal) {
      return { ...base, kind: 'approval', proposal: this.proposal };
    }
    if (this.status === 'paused_loop') return { ...base, kind: 'loop', loopSummary: this.loopSummary };
    if (this.status === 'completed' && this.question) return { ...base, kind: 'question', question: this.question };
    return null;
  }

  summary(): SessionSummary {
    return {
      sessionId: this.id,
      tabId: this.tabId,
      host: this.host,
      prompt: truncate(this.prompt, 120),
      status: this.status,
      step: this.step,
      needsYou: this.getDecision()?.kind ?? null,
    };
  }

  /** State of this session, read against its own tab (never the active one). */
  async getSnapshot(): Promise<Omit<PanelState, 'sessions'>> {
    const [settings, apiKey, ack, tab] = await Promise.all([
      getSettings(),
      getApiKey(),
      isDisclosureAcknowledged(),
      chrome.tabs.get(this.tabId).catch(() => null),
    ]);
    return {
      sessionId: this.id,
      tabId: this.tabId,
      scopeOrigin: this.startOrigin,
      status: this.status,
      runId: this.runId,
      prompt: this.prompt,
      step: this.step,
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
      binding: null, // filled in by the SessionManager, which owns the tab binding
    };
  }

  toPersisted(): PersistedRun {
    return {
      sessionId: this.id,
      status: this.status,
      runId: this.runId,
      tabId: this.tabId,
      prompt: truncate(this.prompt, 500),
      step: this.step,
      lastError: this.lastError,
    };
  }

  /** The content script noticed a material DOM change. While waiting for approval, warn the user. */
  markMapStale(): void {
    debugLog('map_stale');
    if (this.status === 'awaiting_confirmation' && !this.pageChanged) {
      this.pageChanged = true;
      this.changed();
    }
  }

  /* ---------------------------------------------------------------- */
  /* internal state helpers                                            */
  /* ---------------------------------------------------------------- */

  private changed(): void {
    this.deps.onChange(this);
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
      Partial<Pick<LogEntry, 'id' | 'target' | 'risk' | 'detail'>>,
  ): Promise<void> {
    if (this.run !== ctx) return; // superseded loops do not write to the log
    const base = {
      runId: ctx.id,
      prompt: this.prompt || null,
      target: null,
      risk: null,
      detail: null,
      ...e,
    };
    /* An id means "this step's row": update it in place instead of adding a second one. */
    const entry = e.id ? await upsertLog({ ...base, id: e.id }) : await appendLog(base);
    this.deps.onLog(entry);
    emitRunLog(entry, this.host);
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
    this.changed();
  }

  private fail(ctx: RunCtx, message: string): void {
    if (!this.isCurrent(ctx)) return;
    this.lastError = truncate(redactText(message), 600);
    void recordError(this.lastError);
    if (this.status !== 'error' && canTransition(this.status, 'error')) this.status = 'error';
    this.statusDetail = null;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run failed', outcome: 'failed', detail: this.lastError });
    this.changed();
  }

  private finishStopped(ctx: RunCtx, message: string): void {
    if (!this.isCurrent(ctx)) return;
    if (this.status !== 'stopped' && canTransition(this.status, 'stopped')) this.status = 'stopped';
    this.statusDetail = message;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run stopped', outcome: 'stopped', detail: message });
    this.changed();
  }

  /* ---------------------------------------------------------------- */
  /* commands                                                          */
  /* ---------------------------------------------------------------- */

  /** Broadcast the current state (e.g. after settings changed). */
  refresh(): void {
    this.changed();
  }

  async start(rawPrompt: string, answering: { question: string; goal: string } | null): Promise<void> {
    const settings = await getSettings();
    setDebug(settings.debug);
    const apiKey = await getApiKey();

    const ctx: RunCtx = { id: crypto.randomUUID(), controller: new AbortController() };
    this.run = ctx;
    this.runId = ctx.id;
    // Prompts are redacted before they can reach the model, the log, or session storage.
    this.prompt = redactText(rawPrompt.trim());
    this.baseGoal = answering ? answering.goal : this.prompt;
    const goal = answering
      ? `${answering.goal}\n\nYou previously asked the user: "${answering.question}"\nThe user answered: "${this.prompt}"`
      : this.prompt;

    const abortWith = (msg: string, outcome: 'blocked' | 'failed' = 'failed') => {
      this.lastError = msg;
      this.status = 'error';
      void this.log(ctx, { actionType: 'run', actionSummary: 'Run could not start', outcome, detail: msg });
      this.changed();
    };

    if (!(await isDisclosureAcknowledged())) {
      return abortWith('Please read and accept the privacy disclosure in the side panel before running.');
    }
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    if (!tab?.id) return abortWith('The tab for this run was not found.');
    const approved = this.deps.approvedOrigin(this.tabId);
    if (!approved) return abortWith('Allow Pilot on this page first. Nothing was read or sent.', 'blocked');
    if (tab.url === undefined || originOf(tab.url) !== approved) {
      return abortWith('This tab is no longer on the page you approved. Allow Pilot on the current page first.', 'blocked');
    }
    const verdict = evaluateSite(tab.url, settings, tab.incognito, true);
    this.host = verdict.host;
    this.startOrigin = approved;
    this.failures = 0;
    if (!verdict.allowed) return abortWith(verdict.message, 'blocked');
    if (!settings.dryRun) {
      if (!apiKey) return abortWith('No API key is configured. Open Settings and add one.');
      if (!settings.modelId) return abortWith('No model ID is configured. Open Settings and add one.');
    }

    await this.log(ctx, { actionType: 'run', actionSummary: 'Run started', outcome: 'run_started', detail: verdict.host });
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

  /** The user chose to keep going after a loop warning. */
  continueRun(): boolean {
    if (this.status !== 'paused_loop' || !this.loopPending) return false;
    const resolve = this.loopPending;
    this.loopPending = null;
    resolve('approve');
    return true;
  }

  /** Re-highlight the currently proposed target on the page. */
  async preview(actionId: string): Promise<boolean> {
    if (this.proposal?.actionId !== actionId || !this.proposalTarget) return false;
    try {
      if (!this.docId) return false;
      const r = await sendToContent(
        this.tabId,
        {
          type: 'cs/highlight',
          docId: this.docId,
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
    this.loopPending?.('stop');
    this.loopPending = null;
    this.proposal = null;
    this.status = 'stopped';
    this.statusDetail = reason;
    void this.log(ctx, { actionType: 'run', actionSummary: 'Run stopped', outcome: 'stopped', detail: reason });
    void this.clearHighlight();
    this.changed();
  }

  /** Abort without touching state: this session has been replaced by a newer one on the same tab. */
  dispose(): void {
    this.run?.controller.abort();
    this.pending?.resolve('stop');
    this.pending = null;
    this.loopPending?.('stop');
    this.loopPending = null;
  }

  /* ---------------------------------------------------------------- */
  /* the loop                                                          */
  /* ---------------------------------------------------------------- */

  private async clearHighlight(): Promise<void> {
    try {
      await sendToTab(this.tabId, { type: 'cs/clear_highlight' });
    } catch {
      /* page gone or script not injected */
    }
  }

  private async collect(tabId: number): Promise<PageMap> {
    await ensureContentScript(tabId);
    const r = await sendToContent(tabId, { type: 'cs/collect_map' }, MapResponseSchema);
    if (!r.ok) throw new UserError(r.message);
    this.docId = r.docId;
    return r.map;
  }

  /** The docId the current actions are pinned to. Throws when nothing has been read yet. */
  private pinned(): string {
    if (!this.docId) throw new UserError('The page has not been read yet.');
    return this.docId;
  }

  private async assertTabStillAllowed(tabId: number, settings: Settings): Promise<string | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return 'The tab was closed.';
    const approved = this.deps.approvedOrigin(tabId);
    if (!approved) return 'Approval for this tab was withdrawn, so Pilot stopped. Allow Pilot on the page to continue.';
    if (tab.url !== undefined && originOf(tab.url) !== approved) {
      return `This tab moved to another site, so approval for ${approved} no longer applies. Allow Pilot on the new page to continue.`;
    }
    const v = evaluateSite(tab.url, settings, tab.incognito, true);
    return v.allowed ? null : v.message;
  }

  /**
   * Record this step with the loop guard. When the same step has repeated too often, park the run
   * until the user says continue or stop. Returns normally on continue and throws RunStopped on stop.
   */
  private async guardLoop(ctx: RunCtx, signature: string, summary: string): Promise<void> {
    if (!this.loopGuard.record(signature)) return;
    this.loopSummary = `The agent keeps repeating the same step and the page is not changing: ${truncate(summary, 160)}`;
    await this.log(ctx, { actionType: 'run', actionSummary: 'Paused: repeating the same step', outcome: 'info', detail: this.loopSummary });
    this.setStatus(ctx, 'paused_loop', 'Repeating the same step. Continue or stop?');
    const d = await new Promise<Decision>((resolve) => {
      this.loopPending = resolve;
    });
    this.assertCurrent(ctx);
    if (d === 'stop') throw new RunStopped();
    this.loopGuard.reset();
    this.loopSummary = null;
    this.setStatus(ctx, 'validating_action', 'Continuing…');
  }

  /**
   * A step did not work (unknown element, blocked by policy, left the site, failed in the page, unusable
   * model reply). Count it, tell the model what happened so its next plan takes another route, and log it.
   * Returns false when too many failed in a row: the run has been failed and the caller must return.
   */
  private async recover(
    ctx: RunCtx,
    what: Pick<LogEntry, 'actionType' | 'actionSummary'> & Partial<Pick<LogEntry, 'id' | 'target' | 'risk'>>,
    outcome: 'failed' | 'blocked',
    reason: string,
  ): Promise<boolean> {
    this.failures++;
    const label = outcome === 'blocked' ? 'BLOCKED' : 'FAILED';
    this.history.push({
      step: this.step,
      action: truncate(what.actionSummary, 160),
      outcome: truncate(`${label}: ${reason}. Try a different approach.`, 200),
    });
    await this.log(ctx, { ...what, outcome, detail: reason });
    if (this.failures < MAX_CONSECUTIVE_FAILURES) return true;
    this.fail(ctx, `Could not make progress after ${MAX_CONSECUTIVE_FAILURES} attempts in a row. Last problem: ${reason}`);
    return false;
  }

  /**
   * The run stays on the origin it started on. If the tab has left it (a form submit, a redirect, or the
   * user), go back; give up only if going back does not help. Returns false when the run has been failed.
   */
  private async ensureInScope(ctx: RunCtx, tabId: number): Promise<boolean> {
    const origin = this.startOrigin;
    if (!origin) return true;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    this.assertCurrent(ctx);
    if (!tab) return true; // a closed tab is reported by the caller
    if (tab.url !== undefined && isInScope(origin, tab.url)) return true;
    // The tab left the approved origin (or its address can no longer be read). Pause: nothing is clicked on a
    // page the user has not approved, and nothing navigates the tab back on its own.
    this.deps.revokeApproval(tabId);
    const left = tab.url === undefined ? null : originOf(tab.url);
    this.finishStopped(
      ctx,
      left
        ? `The tab moved from ${origin} to ${left}, so Pilot stopped. Allow Pilot on the new page to continue.`
        : 'Page access needed: Pilot can no longer see this tab. Click the toolbar icon on this tab, then allow Pilot again.',
    );
    return false;
  }

  private async runLoop(ctx: RunCtx, settings: Settings, apiKey: string, goal: string): Promise<void> {
    const tabId = this.tabId;
    const mode: Mode = settings.mode;
    const userGoal = `${this.baseGoal} ${this.prompt}`; // only what the user typed, never model output

    try {
      // No step limit: the run ends when the model completes, the user stops it, or something fatal happens.
      // Steps that merely fail are fed back to the model so it tries another way; MAX_CONSECUTIVE_FAILURES
      // in a row ends the run, and the loop guard catches an agent going in circles.
      for (;;) {
        try {
          this.assertCurrent(ctx);
          this.step++;
          this.setStatus(ctx, 'collecting_page_context', 'Reading the page…');

          /* Scope first: a page that left the site is sent back before the allow-list judges it. */
          if (!(await this.ensureInScope(ctx, tabId))) return;
          const blocked = await this.assertTabStillAllowed(tabId, settings);
          this.assertCurrent(ctx);
          if (blocked) {
            await this.log(ctx, { actionType: 'run', actionSummary: 'Blocked page', outcome: 'blocked', detail: blocked });
            return this.fail(ctx, blocked);
          }

          let map = await this.collect(tabId);
          this.assertCurrent(ctx);

          const planCtx: PlanContext = {
            mode,
            goal,
            map,
            history: this.history,
            step: this.step,
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
            plan = await requestAction({ settings, apiKey, signal: ctx.controller.signal }, planCtx);
          } catch (e) {
            if (e instanceof LlmError) {
              if (e.code === 'aborted') throw new RunStopped();
              if (e.code === 'invalid_output' || e.code === 'timeout' || e.code === 'empty') {
                this.assertCurrent(ctx);
                this.setStatus(ctx, 'validating_action', 'The model reply was unusable; asking again…');
                if (!(await this.recover(ctx, { actionType: 'model', actionSummary: 'The model’s reply could not be used' }, 'failed', e.message))) return;
                continue;
              }
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
            if (mode === 'autonomous') {
              // Nobody is there to answer: tell the model to decide, and only end the run if it keeps asking.
              this.failures++;
              this.history.push({ step: this.step, action: 'ask_user', outcome: 'REJECTED: nobody can answer. Decide yourself and continue' });
              await this.log(ctx, { actionType: 'ask_user', actionSummary: 'Model asked a question; told to decide itself', outcome: 'info', detail: redactText(action.question) });
              if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
                this.finalResult = redactText(`Stopped without finishing. Open question: ${action.question}`);
                this.setStatus(ctx, 'completed', 'Done');
                return;
              }
              continue;
            }
            this.question = redactText(action.question);
            this.lastQuestion = { question: this.question, goal: this.baseGoal };
            await this.log(ctx, { actionType: 'ask_user', actionSummary: 'Asked a question', outcome: 'info', detail: this.question });
            this.setStatus(ctx, 'completed', 'The assistant needs more information from you.');
            return;
          }
          if (action.type === 'observe') {
            await this.guardLoop(ctx, stepSignature(action, null, map), summarizeAction(action, null));
            this.history.push({ step: this.step, action: 'observe', outcome: truncate(redactText(action.reason), 120) });
            await this.log(ctx, { actionType: 'observe', actionSummary: 'Re-read the page', outcome: 'info', detail: action.reason });
            continue;
          }
          if (action.type === 'go_back') {
            await this.guardLoop(ctx, stepSignature(action, null, map), summarizeAction(action, null));
            this.setStatus(ctx, 'executing', 'Going back…');
            const entryId = crypto.randomUUID();
            try {
              await chrome.tabs.goBack(tabId);
            } catch {
              this.setStatus(ctx, 'observing_result', 'There is no previous page.');
              if (!(await this.recover(ctx, { id: entryId, actionType: 'go_back', actionSummary: summarizeAction(action, null) }, 'failed', 'There is no previous page to go back to'))) return;
              continue;
            }
            await this.log(ctx, { id: entryId, actionType: 'go_back', actionSummary: summarizeAction(action, null), outcome: 'executed', detail: action.reason });
            this.history.push({ step: this.step, action: 'go_back', outcome: 'Went back to the previous page' });
            this.failures = 0;
            this.setStatus(ctx, 'observing_result', 'Checking the result…');
            await this.settle(tabId, true);
            this.assertCurrent(ctx);
            continue;
          }

          // ---- target verification against the map we just collected ----
          let target: ElementDescriptor | null = null;
          if ('targetId' in action) {
            target = map.elements.find((e) => e.id === action.targetId) ?? null;
            if (!target) {
              if (!(await this.recover(ctx, { actionType: action.type, actionSummary: `Model referenced unknown element ${action.targetId}` }, 'failed', 'That id is not in page.elements'))) return;
              continue;
            }

            // Stay on this site: a link that leaves the origin is never followed.
            const leaves = this.startOrigin ? scopeViolation(action, target, this.startOrigin) : null;
            if (leaves) {
              if (!(await this.recover(ctx, { actionType: action.type, actionSummary: summarizeAction(action, target), target: describeTarget(target) }, 'blocked', leaves))) return;
              continue;
            }

            // Off-screen targets: the extension scrolls them into view, then regenerates the map.
            if (isMutating(action) && !target.inViewport) {
              const r = await sendToContent(
                tabId,
                { type: 'cs/scroll_to_target', docId: this.pinned(), targetId: target.id, fingerprint: target.fingerprint },
                SimpleContentResponseSchema,
              );
              this.assertCurrent(ctx);
              if (!r.ok) {
                if (!(await this.recover(ctx, { actionType: action.type, actionSummary: summarizeAction(action, target), target: describeTarget(target) }, 'failed', r.message))) return;
                continue;
              }
              await sleep(150);
              this.assertCurrent(ctx);
              map = await this.collect(tabId);
              this.assertCurrent(ctx);
              const again = map.elements.find((e) => e.id === target!.id);
              if (!again || again.fingerprint !== target.fingerprint) {
                if (!(await this.recover(ctx, { actionType: action.type, actionSummary: summarizeAction(action, target), target: describeTarget(target) }, 'failed', 'The element was not found after the page changed'))) return;
                continue;
              }
              target = again;
            }
          }

          // ---- local risk classification + policy (the model has no say) ----
          const { assessment, decision } = decide(action, target, map.url, mode, userGoal);
          if (decision === 'block') {
            const why = assessment.reasons.join('; ');
            if (!(await this.recover(ctx, { actionType: action.type, actionSummary: summarizeAction(action, target), target: target ? describeTarget(target) : null, risk: assessment.risk }, 'blocked', why))) return;
            continue;
          }
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

          // Loop check: before anything is shown or run, so the user is asked instead of the page changing again.
          await this.guardLoop(ctx, stepSignature(action, target, map), proposal.summary);

          this.proposal = proposal;
          this.proposalTarget = target ? { id: target.id, fingerprint: target.fingerprint } : null;
          this.pageChanged = false;

          // One activity-log row per step: its outcome advances in place (proposed, approved, executed...).
          const entryId = crypto.randomUUID();
          const stepLog = (outcome: LogEntry['outcome'], detail: string | null) =>
            this.log(ctx, {
              id: entryId,
              actionType: action.type,
              actionSummary: proposal.summary,
              target: proposal.targetDescription,
              risk: assessment.risk,
              outcome,
              detail,
            });
          await stepLog('proposed', assessment.reasons.join('; '));
          this.assertCurrent(ctx);

          // ---- visible highlight before anything happens ----
          if (target) {
            const h = await sendToContent(
              tabId,
              { type: 'cs/highlight', docId: this.pinned(), targetId: target.id, fingerprint: target.fingerprint, label: truncate(proposal.summary, 80) },
              SimpleContentResponseSchema,
            );
            this.assertCurrent(ctx);
            if (!h.ok) {
              this.proposal = null;
              this.proposalTarget = null;
              if (!(await this.recover(ctx, { id: entryId, actionType: action.type, actionSummary: proposal.summary, target: proposal.targetDescription, risk: assessment.risk }, 'failed', h.message))) return;
              continue;
            }
          }

          if (decision === 'confirm') {
            this.setStatus(ctx, 'awaiting_confirmation', 'Waiting for your approval…');
            const d = await new Promise<Decision>((resolve) => {
              this.pending = { actionId: proposal.actionId, resolve };
            });
            this.assertCurrent(ctx);
            if (d === 'stop') throw new RunStopped();
            if (d === 'reject') {
              await stepLog('rejected', 'Rejected by user');
              await this.clearHighlight();
              this.proposal = null;
              return this.finishStopped(ctx, 'You rejected the proposed action, so the run was stopped.');
            }
            await stepLog('approved', 'Approved by you');
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
              { type: 'cs/execute', docId: this.pinned(), action, fingerprint: target?.fingerprint },
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
            // The page refused (stale, covered, disabled, sensitive...): not fatal, try another way.
            this.setStatus(ctx, 'observing_result', 'That did not work; trying another way…');
            await this.clearHighlight();
            const what = { id: entryId, actionType: action.type, actionSummary: proposal.summary, target: proposal.targetDescription, risk: assessment.risk };
            if (!(await this.recover(ctx, what, 'failed', `${result.code}: ${result.message}`))) return;
            continue;
          }

          this.failures = 0;
          await stepLog(decision === 'auto' ? 'auto_executed' : 'executed', `${decision === 'confirm' ? 'Approved by you. ' : ''}${result.message}`);
          this.history.push({ step: this.step, action: truncate(proposal.summary, 160), outcome: truncate(result.message, 160) });
          if (result.extracted) {
            this.extracted = [...this.extracted, result.extracted].slice(-10);
            this.lastExtraction = extractionToText(result.extracted);
          }

          this.setStatus(ctx, 'observing_result', 'Checking the result…');
          await this.settle(tabId, !!result.navigating);
          this.assertCurrent(ctx);
        } catch (e) {
          if (e instanceof RunStopped) throw e;
          /* Anything that goes wrong inside one step (the page changed, a script was unreachable, a highlight
             or execute failed...) is a reason to look again and choose another way, not to give up. */
          this.assertCurrent(ctx);
          if (!(await chrome.tabs.get(tabId).catch(() => null))) return this.fail(ctx, 'The tab was closed.');
          this.proposal = null;
          this.proposalTarget = null;
          this.status = 'observing_result'; // a step can fail from any stage; the next pass re-reads the page
          await this.clearHighlight();
          const reason = redactText(e instanceof Error ? e.message : String(e));
          if (!(await this.recover(ctx, { actionType: 'run', actionSummary: 'That step could not be completed' }, 'failed', reason))) return;
          await sleep(300); // give a page that is still loading a moment before re-reading it
        }
      }
    } catch (e) {
      if (e instanceof RunStopped) return;
      const msg = e instanceof UserError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      this.fail(ctx, msg);
    } finally {
      // Only the current run may clean up; a superseded loop must not disturb its successor.
      if (this.run === ctx) {
        this.proposal = null;
        this.pending = null;
        this.loopPending = null;
        void this.clearHighlight();
        this.changed();
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
