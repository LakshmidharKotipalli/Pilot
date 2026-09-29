import { matchesHostPattern } from '../shared/domainPolicy';
import {
  ContentToBgMessageSchema,
  UiMessageSchema,
  type UiMessage,
  type UiResponse,
} from '../shared/messages';
import { redactText } from '../shared/redaction';
import type { AgentAction } from '../shared/schemas';
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

async function buildDiagnostics(mgr: SessionManager, tabId?: number) {
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

async function handleUi(msg: UiMessage, mgr: SessionManager): Promise<unknown> {
  switch (msg.type) {
    case 'ui/run_prompt':
      await mgr.start(msg.prompt, msg.tabId);
      return null;
    case 'ui/approve':
      if (!mgr.approve(msg.sessionId, msg.actionId)) throw new UserError('No matching action is waiting for approval.');
      return null;
    case 'ui/reject':
      if (!mgr.reject(msg.sessionId, msg.actionId)) throw new UserError('No matching action is waiting for approval.');
      return null;
    case 'ui/preview':
      return mgr.preview(msg.sessionId, msg.actionId);
    case 'ui/continue':
      if (!mgr.continueRun(msg.sessionId)) throw new UserError('That run is not waiting to continue.');
      return null;
    case 'ui/stop':
      mgr.stop(msg.sessionId);
      return null;
    case 'ui/stop_all':
      mgr.stopAll();
      return null;
    case 'ui/get_state':
      return mgr.getSnapshot(msg.tabId);
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
      return buildDiagnostics(mgr, msg.tabId);
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
      handleUi(parsed.data, mgr).then(
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
      if (parsed.success && parsed.data.type === 'content/stale' && sender.tab.id !== undefined) {
        mgr.markMapStale(sender.tab.id);
      }
      return false;
    }
    return false;
  });
}

export type { AgentAction };
