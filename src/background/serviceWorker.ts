import { DecisionCenter } from './decisions';
import { setDebug } from './debug';
import { registerMessageRouter } from './messageRouter';
import { enableRunLogSink } from './runLogSink';
import { SessionManager } from './sessionManager';
import { getSettings } from './settings';

const sessions = new SessionManager();
const decisions = new DecisionCenter(sessions);

// Listeners must be registered synchronously at top level so a restarted worker receives events.
registerMessageRouter(sessions);
decisions.register();
enableRunLogSink();

// The side panel belongs to the tab it was opened on. There is no global panel (the manifest declares no
// default_path, and the default is switched off here), so an unopened tab never shows Pilot.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
chrome.sidePanel.setOptions({ enabled: false }).catch(() => undefined);

// Toolbar click: Chrome grants `activeTab` for exactly this tab, and hands us its address and title. Bind a
// panel to it, then open that tab's panel. Both calls are made in this same tick, with nothing awaited
// between them, so the user gesture is still valid when open() runs.
chrome.action.onClicked.addListener((tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const binding = sessions.openForTab({ id: tabId, windowId: tab.windowId, url: tab.url, title: tab.title });
  chrome.sidePanel
    .setOptions({ tabId, path: `sidepanel/index.html?bindingId=${encodeURIComponent(binding.bindingId)}`, enabled: true })
    .catch(() => undefined);
  chrome.sidePanel.open({ tabId }).catch(() => undefined);
  sessions.broadcast({ type: 'bg/refresh' });
});

// Only the session on the closed tab stops; every other session keeps running.
chrome.tabs.onRemoved.addListener((tabId) => sessions.handleTabClosed(tabId));
chrome.tabs.onReplaced.addListener((_added, removed) => sessions.handleTabReplaced(removed));
chrome.tabs.onAttached.addListener((tabId, info) => sessions.handleTabAttached(tabId, info.newWindowId));
// Navigation of a bound tab can withdraw its approval. Tab *switching* (onActivated) is deliberately not
// listened to: which tab the user is looking at has no effect on any session.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => sessions.handleTabUpdated(tabId, info, tab));

// Rehydrate safe run state (status/counters only; never DOM references) and refresh settings.
void (async () => {
  await sessions.init();
  setDebug((await getSettings()).debug);
  sessions.publish();
})();
