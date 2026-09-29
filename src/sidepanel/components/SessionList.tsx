import { isActiveStatus } from '../../shared/stateMachine';
import type { SessionSummary } from '../../shared/schemas';

interface Props {
  sessions: SessionSummary[];
  currentTabId: number | null;
  onStop: (sessionId: string) => void;
  onStopAll: () => void;
  onGoToTab: (tabId: number) => void;
}

const NEEDS: Record<string, string> = { approval: 'needs approval', loop: 'looping?', question: 'has a question' };

/** Every session across tabs, with a badge for the ones that are waiting on the user. */
export function SessionList({ sessions, currentTabId, onStop, onStopAll, onGoToTab }: Props) {
  if (sessions.length === 0) return null;
  const anyActive = sessions.some((s) => isActiveStatus(s.status));
  return (
    <section className="card" aria-labelledby="sessions-title">
      <div className="row spread">
        <h2 id="sessions-title">Sessions ({sessions.length})</h2>
        <button type="button" className="danger" onClick={onStopAll} disabled={!anyActive}>
          Stop all
        </button>
      </div>
      <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sessions.map((s) => (
          <li key={s.sessionId} className="row spread small">
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong>{s.host ?? 'unknown site'}</strong>
              {s.tabId === currentTabId ? <span className="muted"> (this tab)</span> : null}
              <span className="muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.prompt || '(no prompt)'} · {s.status.replace(/_/g, ' ')}
                {isActiveStatus(s.status) ? ` · step ${s.step}` : ''}
              </span>
            </span>
            <span className="row">
              {s.needsYou && <span className="badge high">{NEEDS[s.needsYou]}</span>}
              {s.tabId !== currentTabId && (
                <button type="button" onClick={() => onGoToTab(s.tabId)}>
                  Go to tab
                </button>
              )}
              {isActiveStatus(s.status) && (
                <button type="button" className="danger" onClick={() => onStop(s.sessionId)}>
                  Stop
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
