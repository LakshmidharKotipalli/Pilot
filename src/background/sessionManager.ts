import { KEEPALIVE_MS, MAX_CONCURRENT_SESSIONS, STORAGE_KEYS } from '../shared/constants';
import { evaluateSite } from '../shared/domainPolicy';
import type { BgToUiMessage } from '../shared/messages';
import {
  PersistedRunSchema,
  type DecisionView,
  type LogEntry,
  type PanelState,
  type PersistedRun,
  type SessionSummary,
} from '../shared/schemas';
import { isActiveStatus } from '../shared/stateMachine';
import { getApiKey, getSettings, isDisclosureAcknowledged } from './settings';
import { Session, type SessionDeps } from './session';
import { UserError, getActiveTab } from './tabs';

export type SessionListener = (session: Session) => void;

/**
 * Owns every session: one per tab, at most MAX_CONCURRENT_SESSIONS active at once. Holds the things
 * that are shared across sessions (the storage map, the keep-alive timer, broadcasts) and routes
 * every command to the right session by id or tab.
 */
export class SessionManager implements SessionDeps {
  /** Keyed by tab id: a tab has at most one session, and a finished one stays until it is replaced. */
  private readonly sessions = new Map<number, Session>();
  private readonly listeners = new Set<SessionListener>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Rehydrate safe state after a service-worker restart. Never restores DOM refs or proposals. */
  async init(): Promise<void> {
    try {
      const raw = (await chrome.storage.session.get(STORAGE_KEYS.runs))[STORAGE_KEYS.runs] as unknown;
      if (!raw || typeof raw !== 'object') return;
      let anyActive = false;
      for (const value of Object.values(raw as Record<string, unknown>)) {
        const parsed = PersistedRunSchema.safeParse(value);
        if (!parsed.success) continue;
        anyActive ||= isActiveStatus(parsed.data.status);
        this.sessions.set(parsed.data.tabId, Session.restore(parsed.data, this));
      }
      if (anyActive) this.persist();
    } catch {
      /* session storage unavailable: start clean */
    }
  }

  /** Listen for changes to any session (used by the decision popup / notifications). */
  addListener(fn: SessionListener): void {
    this.listeners.add(fn);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  sessionForTab(tabId: number): Session | undefined {
    return this.sessions.get(tabId);
  }

  sessionById(sessionId: string): Session | undefined {
    return this.list().find((s) => s.id === sessionId);
  }

  activeCount(): number {
    return this.list().filter((s) => s.isActive()).length;
  }

  summaries(): SessionSummary[] {
    return this.list().map((s) => s.summary());
  }

  /** Everything that is waiting on the user right now. */
  decisions(): DecisionView[] {
    return this.list().flatMap((s) => {
      const d = s.getDecision();
      return d ? [d] : [];
    });
  }

  /* ---------------------------------------------------------------- */
  /* SessionDeps                                                       */
  /* ---------------------------------------------------------------- */

  onChange(session: Session): void {
    // A superseded or closed session must not write shared state.
    if (this.sessions.get(session.tabId) !== session) return;
    this.persist();
    this.updateKeepAlive();
    void this.getSnapshot(session.tabId)
      .then((state) => this.broadcast({ type: 'bg/state', state }))
      .catch(() => undefined);
    for (const fn of this.listeners) {
      try {
        fn(session);
      } catch {
        /* a listener must never break a run */
      }
    }
  }

  onLog(entry: LogEntry): void {
    this.broadcast({ type: 'bg/log', entry });
  }

  /* ---------------------------------------------------------------- */
  /* commands                                                          */
  /* ---------------------------------------------------------------- */

  async start(rawPrompt: string, tabId?: number): Promise<void> {
    const id = tabId ?? (await getActiveTab())?.id;
    if (id === undefined) throw new UserError('No active tab was found.');

    // Check and register with no await in between, so two quick Run clicks cannot both get in.
    const existing = this.sessions.get(id);
    if (existing?.isActive()) throw new UserError('A run is already in progress on this tab. Stop it first.');
    if (this.activeCount() >= MAX_CONCURRENT_SESSIONS) {
      throw new UserError(
        `${MAX_CONCURRENT_SESSIONS} runs are already active. Stop one or wait for one to finish before starting another.`,
      );
    }
    const answering = existing?.takeLastQuestion() ?? null;
    existing?.dispose();
    const session = new Session(crypto.randomUUID(), id, this);
    this.sessions.set(id, session);
    await session.start(rawPrompt, answering);
  }

  approve(sessionId: string, actionId: string): boolean {
    return this.sessionById(sessionId)?.approve(actionId) ?? false;
  }

  reject(sessionId: string, actionId: string): boolean {
    return this.sessionById(sessionId)?.reject(actionId) ?? false;
  }

  continueRun(sessionId: string): boolean {
    return this.sessionById(sessionId)?.continueRun() ?? false;
  }

  async preview(sessionId: string, actionId: string): Promise<boolean> {
    return (await this.sessionById(sessionId)?.preview(actionId)) ?? false;
  }

  stop(sessionId: string, reason?: string): void {
    this.sessionById(sessionId)?.stop(reason);
  }

  stopAll(reason = 'Stopped by you.'): void {
    for (const s of this.list()) s.stop(reason);
  }

  /** A site was paused: stop only the sessions that are on it. */
  stopOnHost(host: string, reason: string): void {
    for (const s of this.list()) if (s.getHost() === host) s.stop(reason);
  }

  /** The tab closed: stop and forget only that tab's session. */
  handleTabClosed(tabId: number): void {
    const s = this.sessions.get(tabId);
    if (!s) return;
    s.stop('The tab was closed, so the run was stopped.');
    s.dispose();
    this.sessions.delete(tabId);
    this.persist();
    this.updateKeepAlive();
    this.broadcast({ type: 'bg/refresh' });
    for (const fn of this.listeners) fn(s);
  }

  /** The content script in `tabId` noticed a material DOM change. */
  markMapStale(tabId: number): void {
    this.sessions.get(tabId)?.markMapStale();
  }

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  /** State for one tab: its session, or an idle state that still reports the tab's site verdict. */
  async getSnapshot(tabId?: number): Promise<PanelState> {
    const id = tabId ?? (await getActiveTab())?.id ?? null;
    const session = id === null ? undefined : this.sessions.get(id);
    const sessions = this.summaries();
    if (session) return { ...(await session.getSnapshot()), sessions };

    const [settings, apiKey, ack, tab] = await Promise.all([
      getSettings(),
      getApiKey(),
      isDisclosureAcknowledged(),
      id === null ? Promise.resolve(null) : chrome.tabs.get(id).catch(() => null),
    ]);
    return {
      sessionId: null,
      tabId: id,
      scopeOrigin: null,
      sessions,
      status: 'idle',
      runId: null,
      prompt: '',
      step: 0,
      mode: settings.mode,
      modelId: settings.modelId,
      dryRun: settings.dryRun,
      apiKeySet: apiKey.length > 0,
      disclosureAcknowledged: ack,
      site: evaluateSite(tab?.url, settings, tab?.incognito ?? false),
      proposal: null,
      pageChanged: false,
      extracted: [],
      statusDetail: null,
      lastError: null,
      finalResult: null,
      question: null,
      dryRunPayload: null,
    };
  }

  /** Tell every open panel to re-read its state (settings changed, disclosure accepted, ...). */
  publish(): void {
    this.broadcast({ type: 'bg/refresh' });
    for (const s of this.list()) s.refresh();
  }

  broadcast(msg: BgToUiMessage): void {
    try {
      void chrome.runtime.sendMessage(msg).catch(() => undefined); // no receiver when no page is open
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- */
  /* shared: storage map + one keep-alive                              */
  /* ---------------------------------------------------------------- */

  private persist(): void {
    const all: Record<string, PersistedRun> = {};
    for (const s of this.sessions.values()) all[s.id] = s.toPersisted();
    void chrome.storage.session.set({ [STORAGE_KEYS.runs]: all }).catch(() => undefined);
  }

  /** One timer for all sessions: running while at least one is active. */
  private updateKeepAlive(): void {
    const needed = this.activeCount() > 0;
    if (needed && !this.keepAlive) {
      // Any extension API call resets the MV3 idle timer, so a long wait for approval survives.
      this.keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
    } else if (!needed && this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}
