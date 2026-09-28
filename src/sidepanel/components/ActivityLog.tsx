import type { LogEntry } from '../../shared/schemas';

interface Props {
  entries: LogEntry[];
  onClear: () => void;
}

const BAD = new Set(['failed', 'blocked', 'rejected', 'stopped']);

export function ActivityLog({ entries, onClear }: Props) {
  const shown = [...entries].reverse().slice(0, 60);
  return (
    <section className="card" aria-labelledby="log-title">
      <div className="row spread">
        <h2 id="log-title">Activity log</h2>
        <button type="button" onClick={onClear} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Nothing yet. Every proposed action, decision and outcome is recorded here (stored locally, sensitive values redacted).
        </p>
      ) : (
        <ul className="plain" aria-live="polite">
          {shown.map((e) => (
            <li key={e.id}>
              <div className="row spread small">
                <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className={`badge ${BAD.has(e.outcome) ? 'high' : e.outcome === 'executed' || e.outcome === 'auto_executed' ? 'low' : ''}`}>
                  {e.outcome.replace('_', ' ')}
                </span>
              </div>
              <div>{e.actionSummary}</div>
              {e.target && <div className="muted small">Target: {e.target}</div>}
              {e.detail && <div className="muted small">{e.detail}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
