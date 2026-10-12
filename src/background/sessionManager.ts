import { KEEPALIVE_MS, MAX_CONCURRENT_SESSIONS, STORAGE_KEYS } from '../shared/constants';
import { evaluateSite, hostFromUrl } from '../shared/domainPolicy';
import type { BgToUiMessage } from '../shared/messages';
import {
  PersistedRunSchema,
  TabBindingSchema,
  type DecisionView,
  type LogEntry,
  type PanelState,
  type PersistedRun,
  type SessionSummary,
  type TabBinding,
} from '../shared/schemas';
import { isActiveStatus } from '../shared/stateMachine';
import { originOf } from './scope';
import { getApiKey, getSettings, isDisclosureAcknowledged } from './settings';
import { Session, type SessionDeps } from './session';
import { UserError } from './tabs';

export type SessionListener = (session: Session) => void;

/** What the toolbar click hands us about the tab the user invoked Pilot on. */
export interface TabInfo {
  id: number;
  windowId?: number;
  url?: string;
  title?: string;
}

/**
 * Owns every binding and session. A binding pairs one panel with the tab it was opened on and never
 * changes owner; a session is one run on that tab. Nothing here ever asks "which tab is active":
 * every command arrives with a tab that the worker resolved from a validated binding.
 */
export class SessionManager implements SessionDeps {
  /** Keyed by tab id: a tab has at most one session, and a finished one stays until it is replaced. */
  private readonly sessions = new Map<number, Session>();
  private readonly bindings = new Map<string, TabBinding>();
  private readonly bindingByTab = new Map<number, string>();
  private readonly listeners = new Set<SessionListener>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Rehydrate safe state after a service-worker restart. Never restores DOM refs or proposals, and an
   * active run comes back as "stopped": automation never resumes by itself.
   */
  async init(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get([STORAGE_KEYS.runs, STORAGE_KEYS.bindings]);
      const runs = stored[STORAGE_KEYS.runs] as unknown;
      let anyActive = false;
      if (runs && typeof runs === 'object') {
        for (const value of Object.values(runs as Record<string, unknown>)) {
          const parsed = PersistedRunSchema.safeParse(value);
          if (!parsed.success) continue;
          anyActive ||= isActiveStatus(parsed.data.status);
          this.sessions.set(parsed.data.tabId, Session.restore(parsed.data, this));
        }
      }
      const bound = stored[STORAGE_KEYS.bindings] as unknown;
      if (bound && typeof bound === 'object') {
        for (const value of Object.values(bound as Record<string, unknown>)) {
          const parsed = TabBindingSchema.safeParse(value);
          if (!parsed.success) continue;
          const b = parsed.data;
          const tab = await chrome.tabs.get(b.ownerTabId).catch(() => null);
          if (!tab) continue; // the owning tab is gone: forget the binding, never hand it to another tab
          // Re-validate: approval only survives while the tab is still on the approved origin.
          if (b.approvedOrigin && (tab.url === undefined || originOf(tab.url) !== b.approvedOrigin)) b.approvedOrigin = null;
          this.bindings.set(b.bindingId, b);
          this.bindingByTab.set(b.ownerTabId, b.bindingId);
        }
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
  /* bindings: which panel belongs to which tab                        */
  /* ---------------------------------------------------------------- */

  bindingById(bindingId: string): TabBinding | undefined {
    return this.bindings.get(bindingId);
  }

  bindingForTab(tabId: number): TabBinding | undefined {
    const id = this.bindingByTab.get(tabId);
    return id ? this.bindings.get(id) : undefined;
  }

  /**
   * The user clicked the toolbar icon on `tab`. Creates the tab's binding, or re-attaches to the one it
   * already has (keeping its session, approval and task). Synchronous on purpose: the caller must open
   * the side panel in the same tick to keep the user gesture.
   */
  openForTab(tab: TabInfo): TabBinding {
    const existing = this.bindingForTab(tab.id);
    const url = tab.url ?? null;
    if (existing) {
      // Refresh what the invocation can see; the owner never changes.
      if (url !== null) {
        existing.url = url;
        if (existing.approvedOrigin && originOf(url) !== existing.approvedOrigin) existing.approvedOrigin = null;
      }
      existing.title = tab.title ?? existing.title;
      existing.ownerWindowId = tab.windowId ?? existing.ownerWindowId;
      this.persistBindings();
      return existing;
    }
    const b: TabBinding = {
      bindingId: crypto.randomUUID(),
      ownerTabId: tab.id,
      ownerWindowId: tab.windowId ?? null,
      url,
      title: tab.title ?? null,
      approvedOrigin: null,
      generation: 0,
      createdAt: Date.now(),
    };
    this.bindings.set(b.bindingId, b);
    this.bindingByTab.set(tab.id, b.bindingId);
    this.persistBindings();
    return b;
  }

  /** The user allows Pilot on the page this binding's tab is showing now. Browser access is a separate matter. */
  async approveSession(bindingId: string): Promise<void> {
    const b = this.bindings.get(bindingId);
    if (!b) throw new UserError('This Pilot session has ended. Click the toolbar icon to start again.');
    const tab = await chrome.tabs.get(b.ownerTabId).catch(() => null);
    if (!tab) throw new UserError('The tab for this session was closed.');
    if (tab.url === undefined) {
      throw new UserError('Page access needed: click the Pilot toolbar icon on this tab, then allow Pilot again.');
    }
    const verdict = evaluateSite(tab.url, await getSettings(), tab.incognito, true);
    if (!verdict.allowed) throw new UserError(verdict.message);
    b.approvedOrigin = originOf(tab.url);
    b.url = tab.url;
    b.title = tab.title ?? b.title;
    this.persistBindings();
    this.publish();
  }

  /** Close this tab's session for good: cancel work, forget the binding. The caller closes the panel. */
  endSession(bindingId: string): void {
    const b = this.bindings.get(bindingId);
    if (!b) return;
    const s = this.sessions.get(b.ownerTabId);
    s?.stop('Session ended.');
    s?.dispose();
    this.sessions.delete(b.ownerTabId);
    this.bindings.delete(bindingId);
    this.bindingByTab.delete(b.ownerTabId);
    this.persist();
    this.persistBindings();
    this.updateKeepAlive();
    this.broadcast({ type: 'bg/refresh' });
    if (s) for (const fn of this.listeners) fn(s);
  }

  /* ---------------------------------------------------------------- */
  /* SessionDeps                                                       */
  /* ---------------------------------------------------------------- */

  approvedOrigin(tabId: number): string | null {
    return this.bindingForTab(tabId)?.approvedOrigin ?? null;
  }

  revokeApproval(tabId: number): void {
    const b = this.bindingForTab(tabId);
    if (!b || b.approvedOrigin === null) return;
    b.approvedOrigin = null;
    this.persistBindings();
    this.broadcast({ type: 'bg/refresh' });
  }

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

  /** Start a run on `tabId`, which the caller resolved from a validated binding (never from "the active tab"). */
  async start(rawPrompt: string, tabId: number): Promise<void> {
    if (!this.bindingForTab(tabId)) throw new UserError('This tab has no Pilot session. Click the toolbar icon on it.');
    if (!this.approvedOrigin(tabId)) throw new UserError('Allow Pilot on this page first. Nothing was read or sent.');

    // Check and register with no await in between, so two quick Run clicks cannot both get in.
    const existing = this.sessions.get(tabId);
    if (existing?.isActive()) throw new UserError('A run is already in progress on this tab. Stop it first.');
    if (this.activeCount() >= MAX_CONCURRENT_SESSIONS) {
      throw new UserError(
        `${MAX_CONCURRENT_SESSIONS} runs are already active. Stop one or wait for one to finish before starting another.`,
      );
    }
    const answering = existing?.takeLastQuestion() ?? null;
    existing?.dispose();
    const session = new Session(crypto.randomUUID(), tabId, this);
    this.sessions.set(tabId, session);
    await session.start(rawPrompt, answering);
  }

  /** Answer a session's question. The session names the tab; the caller's own tab is irrelevant. */
  async answer(sessionId: string, answer: string): Promise<void> {
    const s = this.sessionById(sessionId);
    if (!s) throw new UserError('That session no longer exists.');
    await this.start(answer, s.tabId);
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

  /** The tab closed: stop and forget only that tab's session and binding. Nothing moves to another tab. */
  handleTabClosed(tabId: number): void {
    const s = this.sessions.get(tabId);
    const bindingId = this.bindingByTab.get(tabId);
    if (!s && !bindingId) return;
    if (s) {
      s.stop('The tab was closed, so the run was stopped.');
      s.dispose();
      this.sessions.delete(tabId);
    }
    if (bindingId) {
      this.bindings.delete(bindingId);
      this.bindingByTab.delete(tabId);
    }
    this.persist();
    this.persistBindings();
    this.updateKeepAlive();
    this.broadcast({ type: 'bg/refresh' });
    if (s) for (const fn of this.listeners) fn(s);
  }

  /** A tab was swapped for another id (prerender/discard). The old owner is gone: end it, never rebind. */
  handleTabReplaced(removedTabId: number): void {
    this.handleTabClosed(removedTabId);
  }

  handleTabAttached(tabId: number, windowId: number): void {
    const b = this.bindingForTab(tabId);
    if (!b) return;
    b.ownerWindowId = windowId;
    this.persistBindings();
  }

  /**
   * A bound tab loaded or navigated. Same origin: keep the binding, bump the generation (old documents'
   * actions are refused by their docId). Another origin, or an address we can no longer read: withdraw
   * the approval and stop the run. Switching tabs never reaches this: it only fires for the owner tab.
   */
  handleTabUpdated(tabId: number, info: { url?: string; status?: string; title?: string }, tab: { url?: string; title?: string }): void {
    const b = this.bindingForTab(tabId);
    if (!b) return;
    const navigated = info.url !== undefined || info.status === 'complete';
    if (!navigated) {
      if (info.title !== undefined && tab.title) {
        b.title = tab.title;
        this.broadcast({ type: 'bg/refresh' });
      }
      return;
    }
    const nowOrigin = originOf(tab.url);
    if (tab.url !== undefined) b.url = tab.url;
    b.title = tab.title ?? b.title;
    if (b.approvedOrigin !== null && nowOrigin !== b.approvedOrigin) {
      const wasAt = b.approvedOrigin;
      b.approvedOrigin = null;
      b.generation++;
      this.sessions
        .get(tabId)
        ?.stop(
          nowOrigin
            ? `The tab moved from ${wasAt} to ${nowOrigin}, so Pilot stopped. Allow Pilot on the new page to continue.`
            : 'Page access needed: Pilot can no longer see this tab. Click the toolbar icon on this tab, then allow Pilot again.',
        );
    } else if (info.url !== undefined) {
      b.generation++;
    }
    this.persistBindings();
    this.broadcast({ type: 'bg/refresh' });
  }

  /** The content script in `tabId` noticed a material DOM change. */
  markMapStale(tabId: number): void {
    this.sessions.get(tabId)?.markMapStale();
  }

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  /** State for one tab: its session (or an idle one) plus the tab's binding and site verdict. */
  async getSnapshot(tabId: number | null): Promise<PanelState> {
    const session = tabId === null ? undefined : this.sessions.get(tabId);
    const binding = tabId === null ? undefined : this.bindingForTab(tabId);
    const sessions = this.summaries();
    const [settings, apiKey, ack, tab] = await Promise.all([
      getSettings(),
      getApiKey(),
      isDisclosureAcknowledged(),
      tabId === null ? Promise.resolve(null) : chrome.tabs.get(tabId).catch(() => null),
    ]);

    const approved = !!binding?.approvedOrigin && tab?.url !== undefined && originOf(tab.url) === binding.approvedOrigin;
    const site = evaluateSite(tab?.url, settings, tab?.incognito ?? false, approved);
    const bindingView = binding
      ? {
          bindingId: binding.bindingId,
          ownerTabId: binding.ownerTabId,
          ownerWindowId: binding.ownerWindowId,
          approved,
          title: tab?.title ?? binding.title,
          lastKnownHost: hostFromUrl(tab?.url ?? binding.url),
        }
      : null;

    if (session) {
      return { ...(await session.getSnapshot()), sessions, site, binding: bindingView };
    }
    return {
      sessionId: null,
      tabId,
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
      site,
      proposal: null,
      pageChanged: false,
      extracted: [],
      statusDetail: null,
      lastError: null,
      finalResult: null,
      question: null,
      dryRunPayload: null,
      binding: bindingView,
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

  /** Bindings hold only tab metadata (url, title, approved origin), never page content. */
  private persistBindings(): void {
    const all: Record<string, TabBinding> = {};
    for (const b of this.bindings.values()) all[b.bindingId] = b;
    void chrome.storage.session.set({ [STORAGE_KEYS.bindings]: all }).catch(() => undefined);
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
