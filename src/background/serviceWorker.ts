import { DecisionCenter } from './decisions';
import { setDebug } from './debug';
import { registerMessageRouter } from './messageRouter';
import { SessionManager } from './sessionManager';
import { getSettings } from './settings';

const sessions = new SessionManager();
const decisions = new DecisionCenter(sessions);

// Listeners must be registered synchronously at top level so a restarted worker receives events.
registerMessageRouter(sessions);
decisions.register();

// Toolbar click → open the side panel for that tab. Handling the click ourselves (instead of
// openPanelOnActionClick) guarantees Chrome treats it as an `activeTab` invocation for this tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});

// Only the session on the closed tab stops; every other session keeps running.
chrome.tabs.onRemoved.addListener((tabId) => sessions.handleTabClosed(tabId));

// Rehydrate safe run state (status/counters only; never DOM references) and refresh settings.
void (async () => {
  await sessions.init();
  setDebug((await getSettings()).debug);
  sessions.publish();
})();
