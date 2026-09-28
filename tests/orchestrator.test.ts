import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../src/background/agentOrchestrator';
import type { ElementDescriptor, PageMap, PanelState } from '../src/shared/schemas';

/* ---------- a fake `chrome` plus a fake content script ---------- */

function button(id: number, name: string, extra: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    id: `el_${id}` as ElementDescriptor['id'],
    tag: 'button', role: 'button', name, visibleText: name, label: null, inputType: 'button', placeholder: null,
    autocomplete: null, href: null, value: null, checked: null, expanded: null, options: null, disabled: false,
    visible: true, inViewport: true, inForm: false, isSubmit: false, sensitive: false, extractOnly: false,
    rect: { x: 0, y: 0, width: 10, height: 10 }, riskHints: [], safePathHint: 'button', nearbyText: '',
    fingerprint: `fp_${id}`, ...extra,
  };
}

const PAGE_URL = 'https://example.com/list';
const map = (): PageMap => ({
  url: PAGE_URL, title: 'T', capturedAt: 0,
  viewport: { width: 1, height: 1, scrollY: 0, scrollHeight: 1 },
  textSnippets: [], elements: [button(1, 'Next page')], truncated: false,
});

interface Harness {
  executed: unknown[];
  collectDelays: number[];
  llmReplies: string[];
  fetchCalls: number;
}
let h: Harness;
let store: Record<string, unknown>;

function installChrome() {
  store = {
    wp_settings: { allowedDomains: ['example.com'], modelId: 'test-model', apiBaseUrl: 'https://api.example.com/v1', safeMode: true },
    wp_api_key: 'sk-test-key-0000000000000000',
    wp_disclosure_ack: true,
  };
  const session: Record<string, unknown> = {};
  const area = (s: Record<string, unknown>) => ({
    get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in s).map((x) => [x, s[x]])),
    set: async (o: Record<string, unknown>) => void Object.assign(s, o),
    remove: async (k: string) => void delete s[k],
  });
  const tab = { id: 7, url: PAGE_URL, incognito: false, status: 'complete' };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(store), session: area(session) },
    runtime: { id: 'ext', sendMessage: async () => undefined, getPlatformInfo: async () => ({}) },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      sendMessage: async (_id: number, msg: { type: string; action?: unknown }) => {
        switch (msg.type) {
          case 'cs/collect_map': {
            const d = h.collectDelays.shift() ?? 0;
            if (d) await new Promise((r) => setTimeout(r, d));
            return { ok: true, map: map() };
          }
          case 'cs/execute':
            h.executed.push(msg.action);
            return { ok: true, message: 'Clicked “Next page”.' };
          default:
            return { ok: true };
        }
      },
    },
    scripting: { executeScript: async () => undefined },
  };
}

const wait = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for condition');
};

const CLICK = '{"type":"click","targetId":"el_1","reason":"go to the next page"}';
const DONE = '{"type":"complete","result":"Reached the next page"}';

beforeEach(() => {
  h = { executed: [], collectDelays: [], llmReplies: [], fetchCalls: 0 };
  installChrome();
  vi.stubGlobal('fetch', async () => {
    h.fetchCalls++;
    const content = h.llmReplies.shift() ?? DONE;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const status = async (o: AgentOrchestrator): Promise<PanelState> => o.getSnapshot();

describe('AgentOrchestrator', () => {
  it('safe mode: nothing executes until the previewed action is approved', async () => {
    h.llmReplies = [CLICK, DONE];
    const o = new AgentOrchestrator();
    await o.start('Click the next page button');

    await wait(async () => (await status(o)).status === 'awaiting_confirmation');
    const s = await status(o);
    expect(s.proposal?.action).toMatchObject({ type: 'click', targetId: 'el_1' });
    expect(s.proposal?.autoExecute).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.executed).toHaveLength(0); // still waiting

    expect(o.approve('not-the-right-id')).toBe(false); // only the previewed action can be approved
    expect(o.approve(s.proposal!.actionId)).toBe(true);
    await wait(async () => (await status(o)).status === 'completed', 4000);
    expect(h.executed).toEqual([{ type: 'click', targetId: 'el_1', reason: 'go to the next page' }]);
    expect((await status(o)).finalResult).toMatch(/next page/i);
  });

  it('reject stops the run without executing', async () => {
    h.llmReplies = [CLICK];
    const o = new AgentOrchestrator();
    await o.start('Click next');
    await wait(async () => (await status(o)).status === 'awaiting_confirmation');
    o.reject((await status(o)).proposal!.actionId);
    await wait(async () => (await status(o)).status === 'stopped');
    expect(h.executed).toHaveLength(0);
  });

  it('never executes when the model output is invalid twice', async () => {
    h.llmReplies = ['click the button please', '{"type":"click","targetId":"#buy","reason":"x"}'];
    const o = new AgentOrchestrator();
    await o.start('Click next');
    await wait(async () => (await status(o)).status === 'error');
    expect((await status(o)).lastError).toMatch(/failed validation twice/);
    expect(h.executed).toHaveLength(0);
  });

  it('refuses to start on a blocked site and does not call the model', async () => {
    (store.wp_settings as { allowedDomains: string[] }).allowedDomains = ['*'];
    (globalThis as unknown as { chrome: { tabs: { query: () => Promise<unknown[]> } } }).chrome.tabs.query = async () => [
      { id: 7, url: 'https://www.chase.com/', incognito: false },
    ];
    const o = new AgentOrchestrator();
    await o.start('do things');
    const s = await status(o);
    expect(s.status).toBe('error');
    expect(s.lastError).toMatch(/blocked-domain rule/);
    expect(h.fetchCalls).toBe(0);
  });

  it('Stop then Run: the superseded loop cannot corrupt the new run', async () => {
    h.collectDelays = [120]; // run 1 parks in a slow (un-abortable) collect
    h.llmReplies = [CLICK, DONE];
    const o = new AgentOrchestrator();
    await o.start('first');
    await new Promise((r) => setTimeout(r, 20));
    o.stop();
    expect((await status(o)).status).toBe('stopped');

    await o.start('second'); // run 2 starts while run 1 is still parked
    await wait(async () => (await status(o)).status === 'awaiting_confirmation');
    const s = await status(o);
    expect(s.step).toBe(1);

    await new Promise((r) => setTimeout(r, 250)); // run 1 wakes up, must be a no-op
    const after = await status(o);
    expect(after.status).toBe('awaiting_confirmation');
    expect(after.step).toBe(1);
    expect(after.proposal?.actionId).toBe(s.proposal?.actionId);
    expect(o.approve(s.proposal!.actionId)).toBe(true); // the pending approval survived
    await wait(async () => (await status(o)).status === 'completed', 4000);
    expect(h.executed).toHaveLength(1);
    expect(h.fetchCalls).toBe(2); // run 1 never reached the model
  });

  it('dry run builds the request but never calls the model or executes', async () => {
    (store.wp_settings as { dryRun: boolean }).dryRun = true;
    delete store.wp_api_key;
    const o = new AgentOrchestrator();
    await o.start('Find the contact page');
    await wait(async () => (await status(o)).status === 'completed');
    const s = await status(o);
    expect(s.dryRunPayload).toContain('Find the contact page');
    expect(s.dryRunPayload).not.toMatch(/sk-test/);
    expect(h.fetchCalls).toBe(0);
    expect(h.executed).toHaveLength(0);
  });
});
