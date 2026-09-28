export function SettingsLink() {
  return (
    <button type="button" onClick={() => void chrome.runtime.openOptionsPage()} aria-label="Open WebPilot settings">
      ⚙ Settings
    </button>
  );
}
