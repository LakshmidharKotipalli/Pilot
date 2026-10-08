import type { LogEntry } from '../../shared/schemas';

const pad = (n: number) => String(n).padStart(2, '0');

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One readable line per step: "14:02:11  executed  Click “Next” — detail". */
export function logLine(e: LogEntry): string {
  const parts = [clock(e.ts), e.outcome.replace(/_/g, ' '), e.actionSummary];
  const head = parts.join('  ');
  return e.detail ? `${head} — ${e.detail}` : head;
}

/** The entries of one run (oldest first) as plain text; empty when there are none. */
export function logText(entries: LogEntry[], runId: string | null): string {
  if (!runId) return '';
  return entries
    .filter((e) => e.runId === runId)
    .map(logLine)
    .join('\n');
}
