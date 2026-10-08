import { RUN_LOG_URL } from '../shared/constants';
import type { LogEntry } from '../shared/schemas';

/**
 * Optional development aid: forward every activity-log row to `npm run logs`, which keeps one JSON file
 * per run in ./logs. Rows are already redacted and truncated by the log itself. When the server is not
 * running the post fails quietly, and we stop trying for a while so a missing server costs nothing.
 */
const RETRY_AFTER_MS = 30_000;
const TIMEOUT_MS = 1500;

let enabled = false;
let pausedUntil = 0;

/** Turned on by the service worker only; tests and other contexts never send anything. */
export function enableRunLogSink(): void {
  enabled = true;
}

export function emitRunLog(entry: LogEntry, host: string | null): void {
  if (!enabled || Date.now() < pausedUntil) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  fetch(RUN_LOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, entry }),
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok) pausedUntil = Date.now() + RETRY_AFTER_MS;
    })
    .catch(() => {
      pausedUntil = Date.now() + RETRY_AFTER_MS;
    })
    .finally(() => clearTimeout(timer));
}

/** For tests. */
export function resetRunLogSink(): void {
  enabled = false;
  pausedUntil = 0;
}
