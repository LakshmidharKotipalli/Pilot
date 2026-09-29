import { beforeEach, describe, expect, it } from 'vitest';
import { appendLog, clearLog, getLog, upsertLog } from '../src/background/activityLog';
import { isInScope, originOf, scopeViolation } from '../src/background/scope';
import type { AgentAction, ElementDescriptor, LogEntry } from '../src/shared/schemas';

const link = (href: string | null): ElementDescriptor =>
  ({ id: 'el_1', tag: 'a', href, fingerprint: 'fp' }) as unknown as ElementDescriptor;
const click: AgentAction = { type: 'click', targetId: 'el_1', reason: 'r' };
const ORIGIN = 'https://shop.example.com';

describe('originOf / isInScope', () => {
  it('only http(s) URLs have an origin', () => {
    expect(originOf('https://shop.example.com/a?b=1#c')).toBe(ORIGIN);
    expect(originOf('http://localhost:3000/x')).toBe('http://localhost:3000');
    for (const bad of ['mailto:a@b.co', 'javascript:alert(1)', 'chrome://settings', 'about:blank', 'not a url', '', null, undefined]) {
      expect(originOf(bad as string)).toBeNull();
    }
  });

  it('scheme, host and port all matter', () => {
    expect(isInScope(ORIGIN, 'https://shop.example.com/other')).toBe(true);
    expect(isInScope(ORIGIN, 'http://shop.example.com/')).toBe(false);
    expect(isInScope(ORIGIN, 'https://www.shop.example.com/')).toBe(false);
    expect(isInScope(ORIGIN, 'https://shop.example.com:8443/')).toBe(false);
    expect(isInScope(ORIGIN, undefined)).toBe(false);
  });
});

describe('scopeViolation', () => {
  it('lets same-origin links and non-link actions through', () => {
    expect(scopeViolation(click, link('https://shop.example.com/cart'), ORIGIN)).toBeNull();
    expect(scopeViolation(click, link(null), ORIGIN)).toBeNull();
    expect(scopeViolation({ type: 'scroll', direction: 'down', amount: 'small', reason: 'r' }, null, ORIGIN)).toBeNull();
    expect(scopeViolation({ type: 'set_checked', targetId: 'el_1', checked: true, reason: 'r' }, link('https://evil.net/'), ORIGIN)).toBeNull();
  });

  it('blocks links to another origin and to non-web schemes', () => {
    expect(scopeViolation(click, link('https://evil.net/x'), ORIGIN)).toMatch(/leaves https:\/\/shop\.example\.com.*evil\.net/);
    expect(scopeViolation(click, link('mailto:a@b.co'), ORIGIN)).toMatch(/not a normal web page/);
  });
});

describe('upsertLog', () => {
  const chromeStub = () => {
    const store: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => void Object.assign(store, o) } },
    };
  };
  const row = (over: Partial<LogEntry>): Omit<LogEntry, 'ts'> => ({
    id: 'step-1', runId: 'r', prompt: null, actionType: 'click', actionSummary: 'Click Next', target: null, risk: 'low', outcome: 'proposed', detail: null, ...over,
  });

  beforeEach(async () => {
    chromeStub();
    await clearLog();
  });

  it('updates a row in place and keeps its position and original time', async () => {
    const first = await upsertLog(row({}));
    await appendLog({ ...row({ id: 'other', actionSummary: 'Something else' }) });
    const updated = await upsertLog(row({ outcome: 'executed', detail: 'Clicked Next' }));
    const log = await getLog();
    expect(log.map((e) => e.id)).toEqual(['step-1', 'other']);
    expect(log[0]).toMatchObject({ outcome: 'executed', detail: 'Clicked Next', ts: first.ts });
    expect(updated.ts).toBe(first.ts);
  });

  it('redacts and truncates like appendLog', async () => {
    await upsertLog(row({ detail: 'card 4242 4242 4242 4242 ' + 'x'.repeat(900) }));
    const [e] = await getLog();
    expect(e!.detail).not.toContain('4242 4242 4242 4242');
    expect(e!.detail!.length).toBeLessThanOrEqual(500);
  });
});
