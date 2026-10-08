import { matchesHostPattern } from '../shared/domainPolicy';
import {
  ContentToBgMessageSchema,
  UiMessageSchema,
  type UiMessage,
  type UiResponse,
} from '../shared/messages';
import { redactText } from '../shared/redaction';
import type { AgentAction, TabBinding } from '../shared/schemas';
import type { SessionManager } from './sessionManager';
import { appendLog, clearLog, getLog } from './activityLog';
import { readLastError, recentDebug, setDebug } from './debug';
import {
  acknowledgeDisclosure,
  clearApiKey,
  getPublicSettings,
  getSettings,
  saveSettings,
  setApiKey,
  updateDomainList,
} from './settings';
import { UserError } from './tabs';

export function normalizeHost(raw: string): string {
  const h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9*]([a-z0-9*.-]*[a-z0-9])?$/.test(h) || h === '*') throw new UserError('That is not a valid host name.');
  return h;
}

/**
 * Who is calling. A side panel names its binding in its own URL (set by the worker when it opened the
 * panel), so its tab is never taken from message content or from "the active tab".
 */
export type Caller =
  | { kind: 'panel'; binding: TabBinding }
  | { kind: 'panel-unbound' }
  | { kind: 'other' };

const PANEL_PATH = '/sidepanel/index.html';

export function identify(senderUrl: string | undefined, mgr: SessionManager): Caller {
  try {
    const u = new URL(senderUrl ?? '');
    if (u.pathname !== PANEL_PATH) return { kind: 'other' };
    const id = u.searchParams.get('bindingId');
    const binding = id ? mgr.bindingById(id) : undefined;
    return binding ? { kind: 'panel', binding } : { kind: 'panel-unbound' };
  } catch {
    return { kind: 'other' };
  }
}

const UNBOUND = 'This WebPilot panel is not attached to a tab session. Click the WebPilot toolbar icon on the tab you want to use.';

async function buildDiagnostics(mgr: SessionManager, tabId: number | null) {
  const s = await mgr.getSnapshot(tabId);
  const perms = await chrome.permissions.getAll();
  return {
    extension: 'WebPilot Agent',
    version: chrome.runtime.getManifest().version,
    generatedAt: new Date().toISOString(),
    currentDomain: s.site.host,
    siteStatus: s.site.code,
    stateMachineStatus: s.status,
    step: s.step,
    sessions: s.sessions.map((x) => ({ status: x.status, step: x.step, needsYou: x.needsYou })),
    mode: s.mode,
    dryRun: s.dryRun,
    modelIdConfigured: s.modelId.length > 0,
    apiKeyConfigured: s.apiKeySet,
    permissions: perms.permissions ?? [],
    hostPermissions: perms.origins ?? [],
    lastError: redactText((await readLastError()) ?? s.lastError ?? '') || null,
    recentDebugEvents: recentDebug(),
    note: 'No API key, page content, or typed text is included in this report.',
  };
}

/** A panel may only touch the session that runs on its own tab. */
function ownSession(caller: Caller, mgr: SessionManager, sessionId: string): void {
  if (caller.kind === 'panel-unbound') throw new UserError(UNBOUND);
  if (caller.kind === 'panel' && mgr.sessionById(sessionId)?.tabId !== caller.binding.ownerTabId) {
    throw new UserError('That session belongs to another tab.');
  }
}

function closePanel(tabId: number): void {
  try {
    void chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => undefined);
  } catch {
    /* side panel API unavailable */
  }
}

export async function handleUi(msg: UiMessage, mgr: SessionManager, caller: Caller = { kind: 'other' }): Promise<unknown> {
  switch (msg.type) {
    case 'ui/run_prompt':
      if (caller.kind !== 'panel') throw new UserError(UNBOUND);
      await mgr.start(msg.prompt, caller.binding.ownerTabId);
      return null;
    case 'ui/answer':
      ownSession(caller, mgr, msg.sessionId);
      await mgr.answer(msg.sessionId, msg.answer);
      return null;
    case 'ui/approve_session':
      if (caller.kind !== 'panel') throw new UserError(UNBOUND);
      await mgr.approveSession(caller.binding.bindingId);
      return null;
    case 'ui/end_session':
      if (caller.kind !== 'panel') throw new UserError(UNBOUND);
      mgr.endSession(caller.binding.bindingId);
      closePanel(caller.binding.ownerTabId);
      return null;
    case 'ui/approve':
      ownSession(caller, mgr, msg.sessionId);
      if (!mgr.approve(msg.sessionId, msg.actionId)) throw new UserError('No matching action is waiting for approval.');
      return null;
    case 'ui/reject':
      ownSession(caller, mgr, msg.sessionId);
      if (!mgr.reject(msg.sessionId, msg.actionId)) throw new UserError('No matching action is waiting for approval.');
      return null;
    case 'ui/preview':
      ownSession(caller, mgr, msg.sessionId);
      return mgr.preview(msg.sessionId, msg.actionId);
    case 'ui/continue':
      ownSession(caller, mgr, msg.sessionId);
      if (!mgr.continueRun(msg.sessionId)) throw new UserError('That run is not waiting to continue.');
      return null;
    case 'ui/stop':
      ownSession(caller, mgr, msg.sessionId);
      mgr.stop(msg.sessionId);
      return null;
    case 'ui/stop_all':
      // Only the cross-session decision window may do this; a panel controls its own tab alone.
      if (caller.kind !== 'other') throw new UserError('A panel can only stop its own tab’s session.');
      mgr.stopAll();
      return null;
    case 'ui/get_state':
      return mgr.getSnapshot(caller.kind === 'panel' ? caller.binding.ownerTabId : null);
    case 'ui/get_decisions':
      return mgr.decisions();
    case 'ui/get_settings':
      return getPublicSettings();
    case 'ui/save_settings': {
      await saveSettings(msg.settings);
      if (msg.apiKey && msg.apiKey.trim()) await setApiKey(msg.apiKey);
      setDebug((await getSettings()).debug);
      mgr.publish();
      return getPublicSettings();
    }
    case 'ui/clear_api_key':
      await clearApiKey();
      mgr.publish();
      return null;
    case 'ui/get_log':
      return getLog();
    case 'ui/clear_log':
      await clearLog();
      return null;
    case 'ui/allow_site': {
      const host = normalizeHost(msg.host);
      const settings = await getSettings();
      const hit = settings.blockedDomainPatterns.find((p) => matchesHostPattern(host, p));
      if (hit) {
        throw new UserError(
          `“${host}” matches the blocked-domain rule “${hit}”. Remove that rule in Settings first if you really want to allow it.`,
        );
      }
      await updateDomainList('allowedDomains', host, true);
      await updateDomainList('pausedDomains', host, false);
      await appendLog({
        runId: null,
        prompt: null,
        actionType: 'settings',
        actionSummary: `Allowed site ${host}`,
        target: null,
        risk: null,
        outcome: 'info',
        detail: null,
      });
      mgr.publish();
      return null;
    }
    case 'ui/remove_site': {
      const host = normalizeHost(msg.host);
      await updateDomainList('allowedDomains', host, false);
      await updateDomainList('pausedDomains', host, false);
      try {
        await chrome.permissions.remove({ origins: [`*://${host}/*`] });
      } catch {
        /* permission was never granted */
      }
      mgr.publish();
      return null;
    }
    case 'ui/pause_site':
      await updateDomainList('pausedDomains', normalizeHost(msg.host), msg.paused);
      if (msg.paused) mgr.stopOnHost(normalizeHost(msg.host), 'Paused on this site.');
      mgr.publish();
      return null;
    case 'ui/ack_disclosure':
      await acknowledgeDisclosure();
      mgr.publish();
      return null;
    case 'ui/get_diagnostics':
      return buildDiagnostics(mgr, caller.kind === 'panel' ? caller.binding.ownerTabId : null);
  }
}

/** Only this extension's own pages may command the worker; content scripts may only report staleness. */
export function registerMessageRouter(mgr: SessionManager): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (r: UiResponse) => void) => {
    if (sender.id !== chrome.runtime.id) return false;

    const fromExtensionPage = !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
    if (fromExtensionPage) {
      const parsed = UiMessageSchema.safeParse(raw);
      if (!parsed.success) {
        sendResponse({ ok: false, error: 'Rejected malformed message.' });
        return false;
      }
      handleUi(parsed.data, mgr, identify(sender.url, mgr)).then(
        (data) => sendResponse({ ok: true, data }),
        (e: unknown) =>
          sendResponse({
            ok: false,
            error: redactText(e instanceof Error ? e.message : 'Unexpected error.'),
          }),
      );
      return true;
    }

    if (sender.tab) {
      const parsed = ContentToBgMessageSchema.safeParse(raw);
      // Only a page's top frame, in a tab that has a session, can mark that tab's map stale.
      if (parsed.success && parsed.data.type === 'content/stale' && sender.tab.id !== undefined && sender.frameId === 0) {
        mgr.markMapStale(sender.tab.id);
      }
      return false;
    }
    return false;
  });
}

export type { AgentAction };
