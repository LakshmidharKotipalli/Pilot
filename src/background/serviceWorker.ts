import { AgentOrchestrator } from './agentOrchestrator';
import { setDebug } from './debug';
import { registerMessageRouter } from './messageRouter';
import { getSettings } from './settings';

const orchestrator = new AgentOrchestrator();

// Listeners must be registered synchronously at top level so a restarted worker receives events.
registerMessageRouter(orchestrator);

// Toolbar click → open the side panel for that tab. Handling the click ourselves (instead of
// openPanelOnActionClick) guarantees Chrome treats it as an `activeTab` invocation for this tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => orchestrator.handleTabClosed(tabId));

// Rehydrate safe run state (status/counters only; never DOM references) and refresh settings.
void (async () => {
  await orchestrator.init();
  setDebug((await getSettings()).debug);
  orchestrator.publish();
})();
