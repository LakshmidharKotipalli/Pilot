import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_PORT } from '../shared/constants';
import { BgToUiMessageSchema, sendToBackground } from '../shared/messages';
import { isActiveStatus } from '../shared/stateMachine';
import { LogEntrySchema, PanelStateSchema, type LogEntry, type PanelState } from '../shared/schemas';
import { ActionPreview } from './components/ActionPreview';
import { ActivityLog } from './components/ActivityLog';
import { LoopCard, QuestionCard } from './components/DecisionCards';
import { ExtractedDataView } from './components/ExtractedDataView';
import { PromptBox } from './components/PromptBox';
import { SessionList } from './components/SessionList';
import { SettingsLink } from './components/SettingsLink';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  collecting_page_context: 'Reading page',
  calling_model: 'Asking model',
  validating_action: 'Validating',
  awaiting_confirmation: 'Needs your approval',
  executing: 'Executing',
  paused_loop: 'Paused: repeating',
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

  // The tab this panel is showing. Every command names it, so the worker never has to guess "the active tab".
  const [tabId, setTabId] = useState<number | null>(null);
  const tabIdRef = useRef<number | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const refresh = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tab?.id ?? null;
    tabIdRef.current = id;
    setTabId(id);
    portRef.current?.postMessage({ tabId: id });
    const r = await sendToBackground<unknown>({ type: 'ui/get_state', tabId: id ?? undefined });
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

    // Tell the worker this panel is open for our tab, so decisions for it are shown here instead of in a popup.
    let closed = false;
    const connect = () => {
      if (closed) return;
      const port = chrome.runtime.connect({ name: PANEL_PORT });
      portRef.current = port;
      port.postMessage({ tabId: tabIdRef.current });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        setTimeout(connect, 500); // the worker restarted: reconnect
      });
    };
    connect();

    const onMsg = (raw: unknown) => {
      const p = BgToUiMessageSchema.safeParse(raw);
      if (!p.success) return;
      if (p.data.type === 'bg/refresh') void refresh();
      else if (p.data.type === 'bg/state') {
        const incoming = p.data.state;
        // Other tabs' sessions only update the session list; this tab's session updates the whole view.
        if (incoming.tabId === tabIdRef.current) setState(incoming);
        else setState((prev) => (prev ? { ...prev, sessions: incoming.sessions } : prev));
      } else {
        const entry = p.data.entry;
        /* One row per step: an update replaces its row where it is instead of adding a new one. */
        setLog((prev) =>
          prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry].slice(-200),
        );
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    const onTab = () => void refresh();
    chrome.tabs.onActivated.addListener(onTab);
    chrome.tabs.onUpdated.addListener(onTab);
    return () => {
      closed = true;
      portRef.current?.disconnect();
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
    const r = await sendToBackground({ type: 'ui/run_prompt', prompt, tabId: tabId ?? undefined });
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
    const r = await sendToBackground({ type: 'ui/get_diagnostics', tabId: tabId ?? undefined });
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
          {state.scopeOrigin && <span className="badge" title="This run never leaves this site">Stays on {new URL(state.scopeOrigin).host}</span>}
          <span className={`badge mode-${state.mode}`}>{MODE_LABEL[state.mode]}</span>
          <span className="badge">{STATUS_LABEL[state.status]}</span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          Model: {state.modelId || '(not set)'}
          {state.dryRun ? ' · DRY RUN (nothing is sent)' : ''}
          {running ? ` · step ${state.step}` : ''}
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
        onStop={() => {
          if (state.sessionId) void sendToBackground({ type: 'ui/stop', sessionId: state.sessionId });
        }}
        running={running}
        disabledReason={disabledReason}
      />

      <SessionList
        sessions={state.sessions}
        currentTabId={tabId}
        onStop={(sessionId) => void sendToBackground({ type: 'ui/stop', sessionId })}
        onStopAll={() => void sendToBackground({ type: 'ui/stop_all' })}
        // A click by the user is the only way a tab comes to the front; the agent never does it.
        onGoToTab={(id) => void chrome.tabs.update(id, { active: true }).catch(() => undefined)}
      />

      {state.status === 'paused_loop' && state.sessionId && (
        <LoopCard
          summary={null}
          onContinue={() => void sendToBackground({ type: 'ui/continue', sessionId: state.sessionId! })}
          onStop={() => void sendToBackground({ type: 'ui/stop', sessionId: state.sessionId! })}
        />
      )}

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
        <QuestionCard
          question={state.question}
          onAnswer={(answer) => {
            void sendToBackground({ type: 'ui/run_prompt', prompt: answer, tabId: tabId ?? undefined }).then((r) => {
              if (!r.ok) setUiError(r.error);
            });
          }}
        />
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
          onApprove={() => void sendToBackground({ type: 'ui/approve', sessionId: state.sessionId!, actionId: state.proposal!.actionId })}
          onReject={() => void sendToBackground({ type: 'ui/reject', sessionId: state.sessionId!, actionId: state.proposal!.actionId })}
          onPreview={() => void sendToBackground({ type: 'ui/preview', sessionId: state.sessionId!, actionId: state.proposal!.actionId })}
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
