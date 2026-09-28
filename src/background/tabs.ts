import { NAVIGATION_WAIT_MS } from '../shared/constants';
import type { z } from 'zod';

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

const UNREACHABLE = /cannot access|cannot be scripted|extensions gallery|chrome:\/\/|manifest must request permission|showing error page/i;
const PORT_CLOSED = /message channel closed|receiving end does not exist|message port closed|context invalidated/i;

export function friendlyInjectionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (UNREACHABLE.test(msg)) {
    return 'WebPilot cannot access this page. It may be a browser-internal or protected page, or WebPilot has not been granted access to this tab yet. Click the WebPilot toolbar icon on the tab or use “Allow this site”.';
  }
  return `Could not reach the page: ${msg}`;
}

export function isPortClosedError(e: unknown): boolean {
  return PORT_CLOSED.test(e instanceof Error ? e.message : String(e));
}

/** Inject the content script only when it is not already answering. */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { type: 'cs/ping' })) as { ok?: boolean } | undefined;
    if (pong?.ok) return;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw new UserError(friendlyInjectionError(e));
  }
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { type: 'cs/ping' })) as { ok?: boolean } | undefined;
    if (!pong?.ok) throw new Error('no response');
  } catch (e) {
    throw new UserError(friendlyInjectionError(e));
  }
}

/** Send a message to the content script and validate the reply with `schema`. */
export async function sendToContent<S extends z.ZodTypeAny>(
  tabId: number,
  message: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const raw: unknown = await chrome.tabs.sendMessage(tabId, message);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new UserError('The page returned an unexpected response.');
  return parsed.data;
}

/** Wait until the tab finishes loading (or the timeout elapses). */
export async function waitForTabComplete(tabId: number, timeoutMs = NAVIGATION_WAIT_MS): Promise<void> {
  const start = Date.now();
  await sleep(150); // give the navigation a moment to begin
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch {
      return;
    }
    await sleep(200);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
