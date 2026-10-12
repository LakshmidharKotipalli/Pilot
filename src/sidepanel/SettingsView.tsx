import { useState } from 'react';
import { SettingsForm } from '../shared/SettingsForm';
import type { LogEntry, PanelState } from '../shared/schemas';
import { getTheme, setTheme, type Theme } from '../shared/theme';
import { ActivityLog } from './components/ActivityLog';

interface Props {
  state: PanelState;
  log: LogEntry[];
  reloadToken: number;
  onClearLog: () => void;
  onCopyDiagnostics: () => void;
  copied: boolean;
  onPauseSite: (paused: boolean) => void;
  onAllowSite: () => void;
  onApproveSession: () => void;
  onEndSession: () => void;
  onSitesChanged: () => void;
}

export function SettingsView({ state, log, reloadToken, onClearLog, onCopyDiagnostics, copied, onPauseSite, onAllowSite, onApproveSession, onEndSession, onSitesChanged }: Props) {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const host = state.site.host;

  const siteExtra = host ? (
    <div className="current-site">
      <div className="row spread nowrap">
        <span className="wrap">
          <span className="muted small">Current site</span>
          <br />
          <strong>{host}</strong>
        </span>
        {state.site.code === 'not_allowlisted' && (
          <button type="button" className="primary" onClick={onApproveSession}>
            Allow on this tab
          </button>
        )}
        {state.site.code === 'ok' && (
          <button type="button" onClick={() => onPauseSite(true)}>
            Pause
          </button>
        )}
        {state.site.code === 'paused' && (
          <button type="button" className="primary" onClick={() => onPauseSite(false)}>
            Resume
          </button>
        )}
      </div>
      {!state.site.allowed && <p className="muted small">{state.site.message}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={onAllowSite} title="Also ask the browser to remember access to this site">
          Keep browser access
        </button>
        <button type="button" className="danger" onClick={onEndSession}>
          End session on this tab
        </button>
      </div>
      <p className="muted small">
        This session works only on this tab, and keeps running if you switch to another one. Ending it stops any task and
        closes this panel.
      </p>
    </div>
  ) : null;

  const appearance = (
    <>
      <label htmlFor="theme-select">Theme</label>
      <select
        id="theme-select"
        value={theme}
        onChange={(e) => {
          const t = e.target.value as Theme;
          setThemeState(t);
          setTheme(t);
        }}
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="system">Match system</option>
      </select>
    </>
  );

  const activity = (
    <>
      <ActivityLog entries={log} onClear={onClearLog} />
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" onClick={onCopyDiagnostics}>
          {copied ? 'Copied ✓' : 'Copy diagnostic report'}
        </button>
      </div>
      <details className="more">
        <summary>What Pilot can do</summary>
        <p className="muted small">
          Pilot only controls elements inside the page DOM. It works only on sites you allow, and it asks before serious
          actions according to the mode you choose under Agent behavior.
        </p>
      </details>
    </>
  );

  return (
    <div className="settings-view">
      <SettingsForm
        siteExtra={siteExtra}
        appearance={appearance}
        activity={activity}
        reloadToken={reloadToken}
        onSitesChanged={onSitesChanged}
        onSaved={onSitesChanged}
      />
    </div>
  );
}
