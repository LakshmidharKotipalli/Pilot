import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_PORT } from '../shared/constants';
import { BgToUiMessageSchema, sendToBackground } from '../shared/messages';
import { isActiveStatus } from '../shared/stateMachine';
import { LogEntrySchema, PanelStateSchema, type LogEntry, type PanelState } from '../shared/schemas';
import { ActionPreview } from './components/ActionPreview';
import { LoopCard, QuestionCard } from './components/DecisionCards';
import { ExtractedDataView } from './components/ExtractedDataView';
import { AccessNotice } from './components/AccessNotice';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { LogDropdown } from './components/LogDropdown';
import { getBlocker } from './lib/blocker';
import { SettingsView } from './SettingsView';

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

export default function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [uiError, setUiError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [settingsToken, setSettingsToken] = useState(0);

  // This panel belongs to the tab it was opened on. The worker put that binding in our URL; we never look
  // at which tab is active, and the worker takes our tab from the binding, not from anything we send.
  const bindingId = useRef(new URLSearchParams(location.search).get('bindingId')).current;
  const ownerTabRef = useRef<number | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const refresh = useCallback(async () => {
    const r = await sendToBackground<unknown>({ type: 'ui/get_state' });
    if (!r.ok) return setUiError(r.error);
    const p = PanelStateSchema.safeParse(r.data);
    if (p.success) {
      ownerTabRef.current = p.data.binding?.ownerTabId ?? null;
      setState(p.data);
    }
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
      const report = () => port.postMessage({ bindingId, visible: document.visibilityState === 'visible' });
      report();
      // Visibility only tells the worker whether to notify you elsewhere. It never pauses or stops a run.
      document.addEventListener('visibilitychange', report);
      port.onDisconnect.addListener(() => {
        document.removeEventListener('visibilitychange', report);
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
        // Only this panel's own tab's session is ever shown here.
        if (incoming.tabId === ownerTabRef.current) setState(incoming);
      } else {
        const entry = p.data.entry;
        /* One row per step: an update replaces its row where it is instead of adding a new one. */
        setLog((prev) =>
          prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry].slice(-200),
        );
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    return () => {
      closed = true;
      portRef.current?.disconnect();
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, [refresh, refreshLog, bindingId]);

  if (!state) {
    return (
      <div className="panel">
        <p className="muted" style={{ padding: 16 }}>
          Loading…{uiError ? ` (${uiError})` : ''}
        </p>
      </div>
    );
  }

  if (!state.binding) {
    return (
      <div className="panel">
        <Header view="main" context={null} onOpenSettings={() => setView('settings')} onBack={() => setView('main')} />
        <main className="scroll workspace">
          <div className="empty">
            <p>This Pilot session has ended.</p>
            <p className="small">Click the Pilot toolbar icon on the tab you want to use.</p>
          </div>
        </main>
      </div>
    );
  }

  const running = isActiveStatus(state.status);
  const host = state.site.host;
  const blocker = getBlocker(state);
  const hasTask = state.status !== 'idle';

  const run = async () => {
    setUiError(null);
    const r = await sendToBackground({ type: 'ui/run_prompt', prompt });
    if (!r.ok) setUiError(r.error);
    else setPrompt('');
  };

  const approveSession = async () => {
    setUiError(null);
    const r = await sendToBackground({ type: 'ui/approve_session' });
    if (!r.ok) setUiError(r.error);
    void refresh();
  };

  const endSession = async () => {
    const r = await sendToBackground({ type: 'ui/end_session' });
    if (!r.ok) setUiError(r.error);
  };

  const allowSite = () => {
    if (!host) return;
    // The permission prompt needs the user gesture, so request it before any await.
    const perm = chrome.permissions.request({ origins: [`*://${host}/*`] }).catch(() => false);
    void (async () => {
      await perm;
      const r = await sendToBackground({ type: 'ui/allow_site', host });
      if (!r.ok) setUiError(r.error);
      setSettingsToken((n) => n + 1);
      void refresh();
    })();
  };

  const pauseSite = async (paused: boolean) => {
    if (!host) return;
    const r = await sendToBackground({ type: 'ui/pause_site', host, paused });
    if (!r.ok) setUiError(r.error);
    setSettingsToken((n) => n + 1);
  };

  const copyDiagnostics = async () => {
    const r = await sendToBackground({ type: 'ui/get_diagnostics' });
    if (!r.ok) return setUiError(r.error);
    await navigator.clipboard.writeText(JSON.stringify(r.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onBlockerAction = () => {
    switch (blocker?.action) {
      case 'ack':
        void sendToBackground({ type: 'ui/ack_disclosure' });
        break;
      case 'allow':
        void approveSession();
        break;
      case 'resume':
        void pauseSite(false);
        break;
      case 'settings':
        setView('settings');
        break;
      default:
        break;
    }
  };

  return (
    <div className="panel">
      <Header
        view={view}
        context={state.binding ? { host: state.site.host ?? state.binding.lastKnownHost, title: state.binding.title } : null}
        onOpenSettings={() => setView('settings')}
        onBack={() => setView('main')}
      />

      {view === 'settings' ? (
        <main className="scroll">
          <SettingsView
            state={state}
            log={log}
            reloadToken={settingsToken}
            onClearLog={() => {
              void sendToBackground({ type: 'ui/clear_log' }).then(() => setLog([]));
            }}
            onCopyDiagnostics={() => void copyDiagnostics()}
            copied={copied}
            onPauseSite={(p) => void pauseSite(p)}
            onAllowSite={allowSite}
            onApproveSession={() => void approveSession()}
            onEndSession={() => void endSession()}
            onSitesChanged={() => void refresh()}
          />
        </main>
      ) : (
        <>
          <main className="scroll workspace">
            {!hasTask && !uiError && (
              <div className="empty">
                <p>What can I do for you on this page?</p>
              </div>
            )}

            {hasTask && state.prompt && <div className="msg-user">{state.prompt}</div>}

            <div role="status" aria-live="polite" className="progress">
              {running && (
                <p className="muted">
                  {STATUS_LABEL[state.status]}
                  {state.statusDetail ? ` · ${state.statusDetail}` : ''}
                  {state.step > 0 ? ` (step ${state.step})` : ''}
                </p>
              )}
              {state.status === 'stopped' && state.statusDetail && <p className="notice">{state.statusDetail}</p>}
            </div>

            {state.status === 'paused_loop' && state.sessionId && (
              <LoopCard
                summary={null}
                onContinue={() => void sendToBackground({ type: 'ui/continue', sessionId: state.sessionId! })}
                onStop={() => void sendToBackground({ type: 'ui/stop', sessionId: state.sessionId! })}
              />
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

            {(uiError || (state.status === 'error' && state.lastError)) && (
              <p className="error" role="alert">
                {uiError ?? state.lastError}
              </p>
            )}
            {state.status === 'completed' && state.finalResult && (
              <section className="msg-result" role="status">
                <div style={{ whiteSpace: 'pre-wrap' }}>{state.finalResult}</div>
              </section>
            )}
            {state.question && state.status === 'completed' && (
              <QuestionCard
                question={state.question}
                onAnswer={(answer) => {
                  void sendToBackground({ type: 'ui/run_prompt', prompt: answer }).then((r) => {
                    if (!r.ok) setUiError(r.error);
                  });
                }}
              />
            )}
            {state.dryRunPayload && (
              <details className="more" open>
                <summary>Dry-run request (not sent)</summary>
                <pre className="mono">{state.dryRunPayload}</pre>
              </details>
            )}
            <ExtractedDataView items={state.extracted} />
            <LogDropdown entries={log} runId={state.runId} />
          </main>

          <div className="dock">
            {blocker && <AccessNotice key={`${blocker.action}:${blocker.message}`} blocker={blocker} onAction={onBlockerAction} />}
            <Composer
              value={prompt}
              onChange={setPrompt}
              onRun={() => void run()}
              onStop={() => {
                if (state.sessionId) void sendToBackground({ type: 'ui/stop', sessionId: state.sessionId });
              }}
              running={running}
              blocked={blocker !== null}
            />
          </div>
        </>
      )}
    </div>
  );
}
