import { useCallback, useEffect, useState } from 'react';
import { BgToUiMessageSchema, sendToBackground } from '../shared/messages';
import { isActiveStatus } from '../shared/stateMachine';
import { LogEntrySchema, PanelStateSchema, type LogEntry, type PanelState } from '../shared/schemas';
import { ActionPreview } from './components/ActionPreview';
import { ActivityLog } from './components/ActivityLog';
import { ExtractedDataView } from './components/ExtractedDataView';
import { PromptBox } from './components/PromptBox';
import { SettingsLink } from './components/SettingsLink';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  collecting_page_context: 'Reading page',
  calling_model: 'Asking model',
  validating_action: 'Validating',
  awaiting_confirmation: 'Needs your approval',
  executing: 'Executing',
  observing_result: 'Checking result',
  completed: 'Completed',
  stopped: 'Stopped',
  error: 'Error',
};

const MODE_LABEL = { safe: 'Safe mode', assisted: 'Assisted mode', autonomous: 'Autonomous mode' } as const;

export default function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [uiError, setUiError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const r = await sendToBackground<unknown>({ type: 'ui/get_state' });
    if (!r.ok) return setUiError(r.error);
    const p = PanelStateSchema.safeParse(r.data);
    if (p.success) setState(p.data);
  }, []);

  const refreshLog = useCallback(async () => {
    const r = await sendToBackground<unknown>({ type: 'ui/get_log' });
    if (r.ok && Array.isArray(r.data)) {
      setLog(r.data.flatMap((e) => (LogEntrySchema.safeParse(e).success ? [LogEntrySchema.parse(e)] : [])));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshLog();

    const onMsg = (raw: unknown) => {
      const p = BgToUiMessageSchema.safeParse(raw);
      if (!p.success) return;
      if (p.data.type === 'bg/state') setState(p.data.state);
      else {
        const entry = p.data.entry;
        setLog((prev) => [...prev.filter((e) => e.id !== entry.id), entry].slice(-200));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    const onTab = () => void refresh();
    chrome.tabs.onActivated.addListener(onTab);
    chrome.tabs.onUpdated.addListener(onTab);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.tabs.onActivated.removeListener(onTab);
      chrome.tabs.onUpdated.removeListener(onTab);
    };
  }, [refresh, refreshLog]);

  if (!state) {
    return (
      <div className="app">
        <p className="muted">Loading…{uiError ? ` (${uiError})` : ''}</p>
      </div>
    );
  }

  const running = isActiveStatus(state.status);
  const host = state.site.host;

  const disabledReason = !state.disclosureAcknowledged
    ? 'Accept the privacy disclosure above to enable Run.'
    : !state.site.allowed
      ? state.site.message
      : !state.dryRun && !state.apiKeySet
        ? 'Add an API key in Settings.'
        : !state.dryRun && !state.modelId
          ? 'Add a model ID in Settings.'
          : null;

  const run = async () => {
    setUiError(null);
    const r = await sendToBackground({ type: 'ui/run_prompt', prompt });
    if (!r.ok) setUiError(r.error);
    else setPrompt('');
  };

  const allowSite = () => {
    if (!host) return;
    // The permission prompt needs the user gesture, so request it before any await.
    const perm = chrome.permissions.request({ origins: [`*://${host}/*`] }).catch(() => false);
    void (async () => {
      await perm;
      const r = await sendToBackground({ type: 'ui/allow_site', host });
      if (!r.ok) setUiError(r.error);
      void refresh();
    })();
  };

  const pauseSite = async (paused: boolean) => {
    if (!host) return;
    const r = await sendToBackground({ type: 'ui/pause_site', host, paused });
    if (!r.ok) setUiError(r.error);
  };

  const copyDiagnostics = async () => {
    const r = await sendToBackground({ type: 'ui/get_diagnostics' });
    if (!r.ok) return setUiError(r.error);
    await navigator.clipboard.writeText(JSON.stringify(r.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="app">
      <header className="card">
        <div className="row spread">
          <h1>WebPilot Agent</h1>
          <SettingsLink />
        </div>
        <div className="row small" style={{ marginTop: 6 }}>
          <span className="muted">Site:</span> <strong>{host ?? 'unknown'}</strong>
          <span className={`badge mode-${state.mode}`}>{MODE_LABEL[state.mode]}</span>
          <span className="badge">{STATUS_LABEL[state.status]}</span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          Model: {state.modelId || '(not set)'}
          {state.dryRun ? ' · DRY RUN (nothing is sent)' : ''}
          {running ? ` · step ${state.step}/${state.maxSteps}` : ''}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          {state.site.code === 'not_allowlisted' && (
            <button type="button" className="primary" onClick={allowSite}>
              Allow this site
            </button>
          )}
          {state.site.code === 'ok' && (
            <button type="button" onClick={() => void pauseSite(true)}>
              Pause on this site
            </button>
          )}
          {state.site.code === 'paused' && (
            <button type="button" className="primary" onClick={() => void pauseSite(false)}>
              Resume on this site
            </button>
          )}
        </div>
        {!state.site.allowed && (
          <p className={state.site.code === 'blocked' || state.site.code === 'unsupported' ? 'error small' : 'notice small'} role="status" style={{ margin: '8px 0 0' }}>
            {state.site.message}
          </p>
        )}
      </header>

      {!state.disclosureAcknowledged && (
        <section className="card" aria-labelledby="disc-title">
          <h2 id="disc-title">Before you start: what gets sent</h2>
          <ul style={{ margin: '0 0 8px 18px', padding: 0 }}>
            <li>Your instructions and a compact list of the page’s interactive elements (names, labels, visible text snippets, URL, title) are sent to the LLM provider you configure.</li>
            <li>Password and other sensitive field values are never included; card numbers and IDs are redacted on a best-effort basis.</li>
            <li>The extension only runs on sites you allow, never on banking, healthcare, identity or password-manager sites by default, and asks before consequential actions.</li>
            <li>Your API key is kept in this browser’s extension storage, which is not a secure vault.</li>
          </ul>
          <button type="button" className="primary" onClick={() => void sendToBackground({ type: 'ui/ack_disclosure' })}>
            I understand
          </button>
        </section>
      )}

      <PromptBox
        value={prompt}
        onChange={setPrompt}
        onRun={() => void run()}
        onStop={() => void sendToBackground({ type: 'ui/stop' })}
        running={running}
        disabledReason={disabledReason}
      />

      <div role="status" aria-live="polite">
        {running && state.statusDetail && <p className="muted small">{state.statusDetail}</p>}
        {state.status === 'stopped' && state.statusDetail && <p className="notice">{state.statusDetail}</p>}
      </div>
      {(uiError || (state.status === 'error' && state.lastError)) && (
        <p className="error" role="alert">
          {uiError ?? state.lastError}
        </p>
      )}
      {state.status === 'completed' && state.finalResult && (
        <section className="ok" role="status">
          <strong>Result</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{state.finalResult}</div>
        </section>
      )}
      {state.question && state.status === 'completed' && (
        <section className="notice" role="status">
          <strong>The assistant needs to know:</strong>
          <div>{state.question}</div>
          <div className="small">Type your answer above and press Run to continue.</div>
        </section>
      )}
      {state.dryRunPayload && (
        <section className="card">
          <h2>Dry-run request (not sent)</h2>
          <pre className="mono">{state.dryRunPayload}</pre>
        </section>
      )}

      {state.proposal && (
        <ActionPreview
          proposal={state.proposal}
          status={state.status}
          pageChanged={state.pageChanged}
          onApprove={() => void sendToBackground({ type: 'ui/approve', actionId: state.proposal!.actionId })}
          onReject={() => void sendToBackground({ type: 'ui/reject', actionId: state.proposal!.actionId })}
          onPreview={() => void sendToBackground({ type: 'ui/preview', actionId: state.proposal!.actionId })}
        />
      )}

      <ExtractedDataView items={state.extracted} />
      <ActivityLog
        entries={log}
        onClear={() => {
          void sendToBackground({ type: 'ui/clear_log' }).then(() => setLog([]));
        }}
      />

      <footer className="row spread small muted">
        <span>WebPilot only controls elements inside the page DOM.</span>
        <button type="button" onClick={() => void copyDiagnostics()}>
          {copied ? 'Copied ✓' : 'Copy diagnostic report'}
        </button>
      </footer>
    </div>
  );
}
