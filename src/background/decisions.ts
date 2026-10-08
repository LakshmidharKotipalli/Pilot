import { PANEL_PORT } from '../shared/constants';
import { truncate } from '../shared/redaction';
import type { DecisionView, Proposal } from '../shared/schemas';
import type { Session } from './session';
import type { SessionManager } from './sessionManager';

const DECISION_PAGE = 'decision/index.html';
const ICON = 'icons/webpilot-128.png';
const NOTICE_PREFIX = 'notice:';
const DECISION_PREFIX = 'decision:';

type ButtonAction = 'approve' | 'reject' | 'stop';

/**
 * A notification never carries typed text, page content or model output: only what kind of action is
 * being asked about and the label of the control it targets.
 */
export function notificationSummary(proposal: Proposal, targetDescription: string | null): string {
  const t = targetDescription ? truncate(targetDescription, 80) : 'the page';
  switch (proposal.action.type) {
    case 'click':
      return `Click ${t}`;
    case 'type_text':
      return `Type text into ${t}`;
    case 'select_option':
      return `Choose an option in ${t}`;
    case 'set_checked':
      return `${proposal.action.checked ? 'Check' : 'Uncheck'} ${t}`;
    case 'scroll':
      return `Scroll ${proposal.action.direction}`;
    case 'extract':
      return `Read data from ${t}`;
    default:
      return 'Perform an action';
  }
}

/**
 * Makes sure a decision reaches the user wherever they are:
 *  - if the side panel is open for that tab, the panel handles it and nothing else happens;
 *  - otherwise one shared popup window lists every pending decision, the toolbar badge shows how many
 *    are waiting, and a system notification announces the new one.
 */
export class DecisionCenter {
  /**
   * Connected side panels: the tab each one belongs to (resolved from its binding, null until it says) and
   * whether it reports itself visible. Visibility only decides whether to notify; it never affects a run.
   */
  private readonly panels = new Map<chrome.runtime.Port, { tabId: number | null; visible: boolean }>();
  private readonly announced = new Set<string>();
  private readonly lastStatus = new Map<string, string>();
  private readonly buttons = new Map<string, { sessionId: string; actionId: string | null; actions: ButtonAction[] }>();
  private windowId: number | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly mgr: SessionManager) {
    mgr.addListener((s) => this.onSession(s));
  }

  /** Register browser event listeners. Must run synchronously at worker start-up. */
  register(): void {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PANEL_PORT) return;
      this.panels.set(port, { tabId: null, visible: true });
      port.onMessage.addListener((m: unknown) => {
        const msg = (m ?? {}) as { bindingId?: unknown; visible?: unknown };
        const cur = this.panels.get(port) ?? { tabId: null, visible: true };
        // The tab comes from the binding the worker issued, never from what the panel claims.
        const b = typeof msg.bindingId === 'string' ? this.mgr.bindingById(msg.bindingId) : undefined;
        this.panels.set(port, { tabId: b ? b.ownerTabId : cur.tabId, visible: typeof msg.visible === 'boolean' ? msg.visible : cur.visible });
      });
      port.onDisconnect.addListener(() => {
        this.panels.delete(port);
        this.refreshBadge();
      });
    });
    chrome.notifications?.onClicked.addListener((id) => void this.onNotificationClicked(id));
    chrome.notifications?.onButtonClicked.addListener((id, index) => this.onButton(id, index));
    chrome.windows?.onRemoved.addListener((id) => {
      if (id === this.windowId) this.windowId = null;
    });
  }

  /**
   * Is the owner tab's panel actually in front of the user? A connected but hidden panel (the user is on
   * another tab) does not count, so the decision reaches them through the popup and notification instead.
   */
  private async panelShowing(tabId: number): Promise<boolean> {
    let connected = false;
    for (const p of this.panels.values()) if (p.tabId === tabId && p.visible) connected = true;
    if (!connected) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return !!tab?.active;
  }

  private onSession(s: Session): void {
    const d = s.getDecision();
    this.refreshBadge();

    // A decision was resolved: drop its notification, and close the popup when nothing is left.
    if (!d) {
      this.clearNotification(DECISION_PREFIX + s.id);
      for (const k of [...this.announced]) if (k.startsWith(s.id + ':')) this.announced.delete(k);
    }
    if (this.mgr.decisions().length === 0) void this.closeWindow();

    const status = s.getStatus();
    const previous = this.lastStatus.get(s.id);
    this.lastStatus.set(s.id, status);

    if (d) {
      const key = `${s.id}:${d.kind}:${d.proposal?.actionId ?? ''}`;
      if (this.announced.has(key)) return;
      this.announced.add(key);
      void this.panelShowing(s.tabId).then((showing) => {
        if (!showing) this.raise(d); // otherwise the panel in front of the user already shows it
      });
      return;
    }

    if (previous !== status) {
      void this.panelShowing(s.tabId).then((showing) => {
        if (showing) return;
        if (status === 'completed') this.notice(s, 'WebPilot finished', `Done${s.getHost() ? ` on ${s.getHost()}` : ''}: ${truncate(s.getPrompt(), 80)}`);
        else if (status === 'error') this.notice(s, 'WebPilot run failed', `A run${s.getHost() ? ` on ${s.getHost()}` : ''} stopped with an error. Open WebPilot to see why.`);
      });
    }
  }

  /* ---------------------------------------------------------------- */

  private refreshBadge(): void {
    const n = this.mgr.decisions().length;
    try {
      void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
      if (n > 0) void chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
    } catch {
      /* action API unavailable */
    }
  }

  private raise(d: DecisionView): void {
    void this.openWindow();
    this.notifyDecision(d);
  }

  private notifyDecision(d: DecisionView): void {
    const where = d.host ? ` on ${d.host}` : '';
    let title: string;
    let message: string;
    const actions: ButtonAction[] = [];
    const labels: string[] = [];
    if (d.kind === 'approval' && d.proposal) {
      const high = d.proposal.risk.risk === 'high';
      title = high ? 'WebPilot: HIGH-RISK action needs approval' : 'WebPilot needs your approval';
      message = `${notificationSummary(d.proposal, d.proposal.targetDescription)}${where}`;
      if (high) {
        message += '. Open the review window to decide.';
      } else {
        actions.push('approve');
        labels.push('Approve');
      }
      actions.push('reject');
      labels.push('Reject');
    } else if (d.kind === 'loop') {
      title = 'WebPilot may be stuck in a loop';
      message = `The agent keeps repeating a step${where}. Open the review window to continue or stop.`;
      actions.push('stop');
      labels.push('Stop');
    } else {
      title = 'WebPilot has a question for you';
      message = `Open the review window to answer${where}.`;
    }
    const id = DECISION_PREFIX + d.sessionId;
    this.buttons.set(id, { sessionId: d.sessionId, actionId: d.proposal?.actionId ?? null, actions });
    this.createNotification(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON),
      title,
      message,
      priority: 2,
      requireInteraction: true,
      buttons: labels.map((title) => ({ title })),
    });
  }

  private notice(s: Session, title: string, message: string): void {
    this.createNotification(`${NOTICE_PREFIX}${s.id}:${s.getStatus()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON),
      title,
      message,
      priority: 0,
    });
  }

  private createNotification(id: string, options: chrome.notifications.NotificationCreateOptions): void {
    try {
      // create() with an existing id replaces it in place.
      void chrome.notifications.create(id, options).catch(() => undefined);
    } catch {
      /* notifications unavailable or denied */
    }
  }

  private clearNotification(id: string): void {
    this.buttons.delete(id);
    try {
      void chrome.notifications.clear(id).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private async onNotificationClicked(id: string): Promise<void> {
    if (id.startsWith(DECISION_PREFIX)) await this.openWindow();
    else this.clearNotification(id);
  }

  private onButton(id: string, index: number): void {
    const b = this.buttons.get(id);
    const action = b?.actions[index];
    if (!b || !action) return;
    if (action === 'approve' && b.actionId) this.mgr.approve(b.sessionId, b.actionId);
    else if (action === 'reject' && b.actionId) this.mgr.reject(b.sessionId, b.actionId);
    else if (action === 'stop') this.mgr.stop(b.sessionId);
    this.clearNotification(id);
  }

  /* ---------------------------------------------------------------- */
  /* the single decision window                                        */
  /* ---------------------------------------------------------------- */

  private async openWindow(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.windowId !== null) {
      // Already open: it refreshes itself from the broadcasts. Just flash it, don't steal focus again.
      try {
        await chrome.windows.update(this.windowId, { drawAttention: true });
        return;
      } catch {
        this.windowId = null;
      }
    }
    this.opening = (async () => {
      try {
        const w = await chrome.windows.create({
          url: chrome.runtime.getURL(DECISION_PAGE),
          type: 'popup',
          width: 460,
          height: 720,
          focused: true,
        });
        this.windowId = w?.id ?? null;
      } catch {
        /* windows API unavailable: the badge and notification still tell the user */
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  private async closeWindow(): Promise<void> {
    const id = this.windowId;
    if (id === null) return;
    this.windowId = null;
    try {
      await chrome.windows.remove(id);
    } catch {
      /* already closed */
    }
  }
}
