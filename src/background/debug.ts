import { STORAGE_KEYS } from '../shared/constants';
import { redactForLog, redactText, truncate } from '../shared/redaction';

let debugEnabled = false;
const recent: string[] = [];

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

/** Logs only sanitized events, and only when the debug toggle is on. */
export function debugLog(event: string, data?: unknown): void {
  if (!debugEnabled) return;
  const line = `${new Date().toISOString()} ${event}${data === undefined ? '' : ' ' + JSON.stringify(redactForLog(data))}`;
  recent.push(truncate(line, 500));
  if (recent.length > 50) recent.shift();
  console.debug('[WebPilot]', line);
}

export function recentDebug(): string[] {
  return [...recent];
}

/** Persist the last sanitized error for the diagnostics report. */
export async function recordError(message: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.lastError]: truncate(redactText(message), 400) });
  } catch {
    /* ignore */
  }
}

export async function readLastError(): Promise<string | null> {
  const v = (await chrome.storage.local.get(STORAGE_KEYS.lastError))[STORAGE_KEYS.lastError];
  return typeof v === 'string' ? v : null;
}
