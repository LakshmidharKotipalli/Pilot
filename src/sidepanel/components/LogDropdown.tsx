import type { LogEntry } from '../../shared/schemas';
import { logText } from '../lib/logText';

interface Props {
  entries: LogEntry[];
  runId: string | null;
}

/** This task's log as plain text, collapsed by default. The full raw log stays in Settings. */
export function LogDropdown({ entries, runId }: Props) {
  const text = logText(entries, runId);
  if (!text) return null;
  const count = text.split('\n').length;
  return (
    <details className="more log-dropdown">
      <summary>Log ({count})</summary>
      <pre className="mono log-text">{text}</pre>
    </details>
  );
}
