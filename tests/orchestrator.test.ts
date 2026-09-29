import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLog } from '../src/background/activityLog';
import { SessionManager } from '../src/background/sessionManager';
import { UserError } from '../src/background/tabs';
import type { ElementDescriptor, PageMap, PanelState } from '../src/shared/schemas';

// Real settle / preview delays would make a 30-step run take a minute.
vi.mock('../src/shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shared/constants')>()),
  SETTLE_MS: 0,
  AUTO_PREVIEW_MS: 0,
}));

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

const ACTIVE_TAB = 7;
const OTHER_HOST_TAB = 8;
const urlOf = (tabId: number) => (tabId === OTHER_HOST_TAB ? 'https://other.example.org/list' : 'https://example.com/list');

interface Harness {
  executed: { tabId: number; action: unknown }[];
  collectDelays: number[];
  /** Replies for the model, chosen by which goal the request is about. Falls back to DONE. */
  script: Record<string, string[]>;
  fetchCalls: number;
  /** When true, every collected map is different (as it is on a page that really changes). */
  changingPage: boolean;
  collects: Record<number, number>;
  highlights: number[];
  closed: Set<number>;
  /** Elements every collected map contains. */
  elements: ElementDescriptor[];
  /** The next N executions fail in the page (as if the target were covered). */
  execFailures: number;
  /** Overrides a tab's URL (as if the page navigated). */
  tabUrl: Record<number, string>;
  goBacks: number;
  bodies: string[];
  /** The next N highlights fail as STALE_TARGET (the page updated after the preview). */
  staleHighlights: number;
  /** The next N content-script calls throw (e.g. the page was navigating). */
  throwOnCall: number;
}
let h: Harness;
let store: Record<string, unknown>;

function installChrome() {
  store = {
    wp_settings: {
      allowedDomains: ['example.com', 'other.example.org'],
      modelId: 'test-model',
      apiBaseUrl: 'https://api.example.com/v1',
      mode: 'safe',
    },
    wp_api_key: 'sk-test-key-0000000000000000',
    wp_disclosure_ack: true,
  };
  const session: Record<string, unknown> = {};
  const area = (s: Record<string, unknown>) => ({
    get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in s).map((x) => [x, s[x]])),
    set: async (o: Record<string, unknown>) => void Object.assign(s, o),
    remove: async (k: string) => void delete s[k],
  });
  const tabObj = (id: number) => ({ id, url: h.tabUrl[id] ?? urlOf(id), incognito: false, status: 'complete' });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(store), session: area(session) },
    runtime: { id: 'ext', sendMessage: async () => undefined, getPlatformInfo: async () => ({}) },
    tabs: {
      // The "active" tab is deliberately never one of the tabs the sessions run on besides ACTIVE_TAB.
      query: async () => [tabObj(ACTIVE_TAB)],
      get: async (id: number) => {
        if (h.closed.has(id)) throw new Error('No tab with id');
        return tabObj(id);
      },
      goBack: async (id: number) => {
        h.goBacks++;
        delete h.tabUrl[id];
      },
      sendMessage: async (id: number, msg: { type: string; action?: unknown }) => {
        switch (msg.type) {
          case 'cs/collect_map': {
            const d = h.collectDelays.shift() ?? 0;
            if (d) await new Promise((r) => setTimeout(r, d));
            const n = (h.collects[id] = (h.collects[id] ?? 0) + 1);
            const map: PageMap = {
              url: h.tabUrl[id] ?? urlOf(id), title: h.changingPage ? `T${n}` : 'T', capturedAt: 0,
              viewport: { width: 1, height: 1, scrollY: 0, scrollHeight: 1 },
              textSnippets: [], elements: h.elements, truncated: false,
            };
            return { ok: true, map };
          }
          case 'cs/execute':
            if (h.throwOnCall > 0) {
              h.throwOnCall--;
              throw new Error('Frame with ID 0 was removed.');
            }
            if (h.execFailures > 0) {
              h.execFailures--;
              return { ok: false, code: 'COVERED', message: 'Another element is covering the target.' };
            }
            h.executed.push({ tabId: id, action: msg.action });
            return { ok: true, message: 'Clicked “Next page”.' };
          case 'cs/highlight':
            if (h.staleHighlights > 0) {
              h.staleHighlights--;
              return { ok: false, code: 'STALE_TARGET', message: 'The element changed since it was previewed (the page updated), so the action was cancelled.' };
            }
            h.highlights.push(id);
            return { ok: true };
          default:
            return { ok: true };
        }
      },
    },
    scripting: { executeScript: async () => undefined },
  };
}

const wait = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for condition');
};

const CLICK = '{"type":"click","targetId":"el_1","reason":"go to the next page"}';
const DONE = '{"type":"complete","result":"Reached the next page"}';

beforeEach(() => {
  h = { executed: [], collectDelays: [], script: {}, fetchCalls: 0, changingPage: false, collects: {}, highlights: [], closed: new Set(), elements: [button(1, 'Next page')], execFailures: 0, tabUrl: {}, goBacks: 0, bodies: [], staleHighlights: 0, throwOnCall: 0 };
  installChrome();
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    h.fetchCalls++;
    h.bodies.push(init.body);
    const key = Object.keys(h.script).find((k) => init.body.includes(k));
    const content = (key ? h.script[key]!.shift() : undefined) ?? DONE;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const setMode = (mode: string) => ((store.wp_settings as { mode: string }).mode = mode);
const snap = (m: SessionManager, tabId = ACTIVE_TAB): Promise<PanelState> => m.getSnapshot(tabId);
const untilStatus = (m: SessionManager, tabId: number, status: string, ms?: number) =>
  wait(async () => (await snap(m, tabId)).status === status, ms);

describe('SessionManager', () => {
  it('safe mode: nothing executes until the previewed action is approved', async () => {
    h.script = { 'Click the next page button': [CLICK, DONE] };
    const m = new SessionManager();
    await m.start('Click the next page button', ACTIVE_TAB);

    await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
    const s = await snap(m);
    expect(s.proposal?.action).toMatchObject({ type: 'click', targetId: 'el_1' });
    expect(s.proposal?.autoExecute).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.executed).toHaveLength(0); // still waiting

    expect(m.approve(s.sessionId!, 'not-the-right-id')).toBe(false); // only the previewed action can be approved
    expect(m.approve('not-the-right-session', s.proposal!.actionId)).toBe(false);
    expect(m.approve(s.sessionId!, s.proposal!.actionId)).toBe(true);
    await untilStatus(m, ACTIVE_TAB, 'completed');
    expect(h.executed).toEqual([{ tabId: ACTIVE_TAB, action: { type: 'click', targetId: 'el_1', reason: 'go to the next page' } }]);
    expect((await snap(m)).finalResult).toMatch(/next page/i);
  });

  it('reject stops the run without executing', async () => {
    h.script = { 'Click nxt-btn': [CLICK] };
    const m = new SessionManager();
    await m.start('Click nxt-btn', ACTIVE_TAB);
    await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
    const s = await snap(m);
    m.reject(s.sessionId!, s.proposal!.actionId);
    await untilStatus(m, ACTIVE_TAB, 'stopped');
    expect(h.executed).toHaveLength(0);
  });

  it('never executes when the model keeps returning invalid output, and gives up after repeated failures', async () => {
    h.script = { 'Click nxt-btn': Array.from({ length: 40 }, () => 'click the button please') };
    const m = new SessionManager();
    await m.start('Click nxt-btn', ACTIVE_TAB);
    await untilStatus(m, ACTIVE_TAB, 'error');
    expect((await snap(m)).lastError).toMatch(/Could not make progress after 6 attempts.*failed validation twice/);
    expect(h.executed).toHaveLength(0);
  });

  it('one unusable model reply is not fatal: the agent asks again and carries on', async () => {
    setMode('autonomous');
    h.script = { 'Click nxt-btn': ['click the button please', 'still not json', CLICK, DONE] };
    const m = new SessionManager();
    await m.start('Click nxt-btn', ACTIVE_TAB);
    await untilStatus(m, ACTIVE_TAB, 'completed');
    expect(h.executed).toHaveLength(1);
  });

  it('refuses to start on a blocked site and does not call the model', async () => {
    (store.wp_settings as { allowedDomains: string[] }).allowedDomains = ['*'];
    const chromeFake = (globalThis as unknown as { chrome: { tabs: { get: (id: number) => Promise<unknown> } } }).chrome;
    chromeFake.tabs.get = async (id: number) => ({ id, url: 'https://www.chase.com/', incognito: false });
    const m = new SessionManager();
    await m.start('do things', ACTIVE_TAB);
    const s = await snap(m);
    expect(s.status).toBe('error');
    expect(s.lastError).toMatch(/blocked-domain rule/);
    expect(h.fetchCalls).toBe(0);
  });

  it('Stop then Run: the superseded loop cannot corrupt the new run', async () => {
    h.collectDelays = [120]; // run 1 parks in a slow (un-abortable) collect
    h.script = { 'zulu-one': [CLICK, DONE], 'zulu-two': [CLICK, DONE] };
    const m = new SessionManager();
    await m.start('zulu-one', ACTIVE_TAB);
    await new Promise((r) => setTimeout(r, 20));
    m.stop((await snap(m)).sessionId!);
    expect((await snap(m)).status).toBe('stopped');

    await m.start('zulu-two', ACTIVE_TAB); // run 2 starts while run 1 is still parked
    await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
    const s = await snap(m);
    expect(s.step).toBe(1);

    await new Promise((r) => setTimeout(r, 250)); // run 1 wakes up, must be a no-op
    const after = await snap(m);
    expect(after.status).toBe('awaiting_confirmation');
    expect(after.step).toBe(1);
    expect(after.proposal?.actionId).toBe(s.proposal?.actionId);
    expect(m.approve(s.sessionId!, s.proposal!.actionId)).toBe(true); // the pending approval survived
    await untilStatus(m, ACTIVE_TAB, 'completed');
    expect(h.executed).toHaveLength(1);
    expect(h.fetchCalls).toBe(2); // run 1 never reached the model
  });

  it('dry run builds the request but never calls the model or executes', async () => {
    (store.wp_settings as { dryRun: boolean }).dryRun = true;
    delete store.wp_api_key;
    const m = new SessionManager();
    await m.start('Find the contact page', ACTIVE_TAB);
    await untilStatus(m, ACTIVE_TAB, 'completed');
    const s = await snap(m);
    expect(s.dryRunPayload).toContain('Find the contact page');
    expect(s.dryRunPayload).not.toMatch(/sk-test/);
    expect(h.fetchCalls).toBe(0);
    expect(h.executed).toHaveLength(0);
  });

  describe('no step limit', () => {
    it('runs well past the old 25-step ceiling when the page keeps changing', async () => {
      setMode('autonomous');
      h.changingPage = true;
      h.script = { 'Page through everything': [...Array.from({ length: 40 }, () => CLICK), DONE] };
      const m = new SessionManager();
      await m.start('Page through everything', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed', 15_000);
      expect(h.executed).toHaveLength(40);
      expect((await snap(m)).step).toBe(41);
    }, 20_000);
  });

  describe('loop detection', () => {
    it('pauses when the same step repeats on an unchanged page, and Continue resumes it', async () => {
      setMode('autonomous');
      h.script = { 'Keep clicking': [CLICK, CLICK, CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('Keep clicking', ACTIVE_TAB);

      await untilStatus(m, ACTIVE_TAB, 'paused_loop');
      expect(h.executed).toHaveLength(3); // the 4th repeat is held back, not run
      const s = await snap(m);
      expect(m.decisions()).toMatchObject([{ sessionId: s.sessionId, kind: 'loop' }]);
      expect(m.sessionForTab(ACTIVE_TAB)!.summary().needsYou).toBe('loop');

      expect(m.continueRun(s.sessionId!)).toBe(true);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(4);
    });

    it('Stop from the loop prompt ends the run without running the repeated step', async () => {
      setMode('autonomous');
      h.script = { 'Keep clicking': Array.from({ length: 10 }, () => CLICK) };
      const m = new SessionManager();
      await m.start('Keep clicking', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'paused_loop');
      m.stop((await snap(m)).sessionId!);
      await untilStatus(m, ACTIVE_TAB, 'stopped');
      expect(h.executed).toHaveLength(3);
    });

    it('does not trigger when the page changes between identical actions', async () => {
      setMode('autonomous');
      h.changingPage = true;
      h.script = { 'Keep clicking': [CLICK, CLICK, CLICK, CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('Keep clicking', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(5);
    });
  });

  describe('multiple sessions', () => {
    it('runs two tabs at once and keeps their state, approvals and executions apart', async () => {
      h.script = { 'task on seven': [CLICK, DONE], 'task on eight': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('task on seven', ACTIVE_TAB);
      await m.start('task on eight', OTHER_HOST_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      await untilStatus(m, OTHER_HOST_TAB, 'awaiting_confirmation');

      const a = await snap(m, ACTIVE_TAB);
      const b = await snap(m, OTHER_HOST_TAB);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.prompt).toBe('task on seven');
      expect(b.prompt).toBe('task on eight');
      // Each session reports its own tab's site, not whichever tab happens to be active.
      expect(a.site.host).toBe('example.com');
      expect(b.site.host).toBe('other.example.org');
      expect(b.sessions).toHaveLength(2);
      expect(h.highlights.sort()).toEqual([ACTIVE_TAB, OTHER_HOST_TAB]);

      // A decision for one session cannot be given to the other.
      expect(m.approve(a.sessionId!, b.proposal!.actionId)).toBe(false);
      expect(m.approve(b.sessionId!, a.proposal!.actionId)).toBe(false);

      expect(m.approve(b.sessionId!, b.proposal!.actionId)).toBe(true);
      await untilStatus(m, OTHER_HOST_TAB, 'completed');
      expect((await snap(m, ACTIVE_TAB)).status).toBe('awaiting_confirmation'); // untouched
      expect(h.executed).toEqual([{ tabId: OTHER_HOST_TAB, action: expect.objectContaining({ type: 'click' }) }]);

      expect(m.approve(a.sessionId!, a.proposal!.actionId)).toBe(true);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed.map((e) => e.tabId)).toEqual([OTHER_HOST_TAB, ACTIVE_TAB]);
    });

    it('allows one active session per tab', async () => {
      h.script = { 'zulu-one': [CLICK] };
      const m = new SessionManager();
      await m.start('zulu-one', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      await expect(m.start('again', ACTIVE_TAB)).rejects.toBeInstanceOf(UserError);
      await expect(m.start('other tab is fine', OTHER_HOST_TAB)).resolves.toBeUndefined();
      expect(m.activeCount()).toBe(2);
    });

    it('caps concurrent sessions at 5 and frees a slot when one stops', async () => {
      const m = new SessionManager();
      for (const tab of [1, 2, 3, 4, 5]) {
        h.script[`run ${tab}`] = [CLICK];
        await m.start(`run ${tab}`, tab);
      }
      expect(m.activeCount()).toBe(5);
      await expect(m.start('run 6', 6)).rejects.toThrow(/5 runs are already active/);
      m.stop(m.sessionForTab(1)!.id);
      await expect(m.start('run 6', 6)).resolves.toBeUndefined();
      m.stopAll();
      expect(m.activeCount()).toBe(0);
    });

    it('closing a tab stops only that tab’s session', async () => {
      h.script = { 'task on seven': [CLICK, DONE], 'task on eight': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('task on seven', ACTIVE_TAB);
      await m.start('task on eight', OTHER_HOST_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      await untilStatus(m, OTHER_HOST_TAB, 'awaiting_confirmation');
      const closing = m.sessionForTab(ACTIVE_TAB)!;

      h.closed.add(ACTIVE_TAB);
      m.handleTabClosed(ACTIVE_TAB);

      expect(closing.getStatus()).toBe('stopped');
      expect(m.sessionForTab(ACTIVE_TAB)).toBeUndefined();
      expect(m.activeCount()).toBe(1);
      const b = await snap(m, OTHER_HOST_TAB);
      expect(b.status).toBe('awaiting_confirmation');
      expect(m.approve(b.sessionId!, b.proposal!.actionId)).toBe(true);
      await untilStatus(m, OTHER_HOST_TAB, 'completed');
      expect(h.executed).toHaveLength(1);
      expect(h.executed[0]!.tabId).toBe(OTHER_HOST_TAB);
    });

    it('pausing a site stops only the sessions on that site', async () => {
      h.script = { 'task on seven': [CLICK], 'task on eight': [CLICK] };
      const m = new SessionManager();
      await m.start('task on seven', ACTIVE_TAB);
      await m.start('task on eight', OTHER_HOST_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      await untilStatus(m, OTHER_HOST_TAB, 'awaiting_confirmation');
      m.stopOnHost('other.example.org', 'Paused on this site.');
      expect((await snap(m, OTHER_HOST_TAB)).status).toBe('stopped');
      expect((await snap(m, ACTIVE_TAB)).status).toBe('awaiting_confirmation');
    });

    it('a tab with no session reports an idle state that still lists the other sessions', async () => {
      h.script = { 'task on eight': [CLICK] };
      const m = new SessionManager();
      await m.start('task on eight', OTHER_HOST_TAB);
      const idle = await snap(m, ACTIVE_TAB);
      expect(idle.status).toBe('idle');
      expect(idle.sessionId).toBeNull();
      expect(idle.sessions).toHaveLength(1);
    });
  });

  describe('stays on the starting site', () => {
    const link = (href: string, extra: Partial<ElementDescriptor> = {}) =>
      button(2, 'Partner site', { tag: 'a', role: 'link', href, inputType: null, safePathHint: 'a', ...extra });

    it('reports the origin it is confined to', async () => {
      h.script = { 'scope task': [CLICK] };
      const m = new SessionManager();
      await m.start('scope task', OTHER_HOST_TAB);
      expect((await snap(m, OTHER_HOST_TAB)).scopeOrigin).toBe('https://other.example.org');
    });

    it('never follows a link to another origin: it is skipped and another route is taken', async () => {
      setMode('autonomous');
      h.elements = [button(1, 'Next page'), link('https://evil.example.net/landing')];
      h.script = { 'scope task': ['{"type":"click","targetId":"el_2","reason":"open the partner"}', CLICK, DONE] };
      const m = new SessionManager();
      await m.start('scope task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed.map((e) => (e.action as { targetId: string }).targetId)).toEqual(['el_1']); // never el_2
      const runId = (await snap(m)).runId;
      const rows = (await getLog()).filter((e) => e.runId === runId);
      expect(rows.some((e) => e.outcome === 'blocked' && /leaves https:\/\/example\.com/.test(e.detail ?? ''))).toBe(true);
      expect(h.bodies.at(-1)).toMatch(/BLOCKED: The link leaves/); // the model was told why
    });

    it('goes back when a page action navigated off the site', async () => {
      setMode('autonomous');
      const chromeFake = (globalThis as unknown as { chrome: { tabs: { sendMessage: (id: number, msg: { type: string }) => Promise<unknown> } } }).chrome;
      const original = chromeFake.tabs.sendMessage;
      chromeFake.tabs.sendMessage = async (id, msg) => {
        const r = await original(id, msg);
        if (msg.type === 'cs/execute') h.tabUrl[id] = 'https://elsewhere.example.net/'; // e.g. a form posted away
        return r;
      };
      h.script = { 'scope task': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('scope task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.goBacks).toBe(1);
      expect(h.bodies.at(-1)).toMatch(/BLOCKED: The page left https:\/\/example\.com/);
    });

    it('the go_back action goes back one page', async () => {
      setMode('autonomous');
      h.script = { 'scope task': ['{"type":"go_back","reason":"dead end"}', DONE] };
      const m = new SessionManager();
      await m.start('scope task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.goBacks).toBe(1);
    });
  });

  describe('autonomous decisions', () => {
    it('runs serious-looking actions without asking (a submit button)', async () => {
      setMode('autonomous');
      h.elements = [button(1, 'Place order', { isSubmit: true, inForm: true })];
      h.script = { 'test checkout': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('test checkout', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(1);
      expect(m.decisions()).toHaveLength(0);
    });

    it('skips hard limits (a password field) instead of asking, and tries something else', async () => {
      setMode('autonomous');
      h.elements = [button(1, 'Next page'), button(2, 'Password', { tag: 'input', inputType: 'password', sensitive: true, role: 'textbox' })];
      h.script = { 'test login': ['{"type":"type_text","targetId":"el_2","text":"x","clearFirst":true,"reason":"log in"}', CLICK, DONE] };
      const m = new SessionManager();
      await m.start('test login', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed.map((e) => (e.action as { type: string }).type)).toEqual(['click']); // nothing typed
      expect(m.decisions()).toHaveLength(0);
      expect(h.bodies.at(-1)).toMatch(/BLOCKED:.*autonomous mode never does this/);
    });

    it('does not surface ask_user questions: the model is told to decide itself', async () => {
      setMode('autonomous');
      h.script = { 'test search': ['{"type":"ask_user","question":"Which one?","reason":"unsure"}', CLICK, DONE] };
      const m = new SessionManager();
      await m.start('test search', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      const s = await snap(m);
      expect(s.question).toBeNull();
      expect(h.executed).toHaveLength(1);
      expect(h.bodies.at(-1)).toMatch(/nobody can answer/);
      expect(h.bodies[0]).not.toContain('nobody can answer'); // and the system prompt says so up front
      expect(h.bodies[0]).toMatch(/AUTONOMOUS TESTING MODE/);
    });

    it('still asks the user in safe mode', async () => {
      h.script = { 'test search': ['{"type":"ask_user","question":"Which one?","reason":"unsure"}'] };
      const m = new SessionManager();
      await m.start('test search', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect((await snap(m)).question).toBe('Which one?');
      expect(m.decisions()).toMatchObject([{ kind: 'question' }]);
      expect(h.bodies[0]).not.toMatch(/AUTONOMOUS TESTING MODE/);
    });
  });

  describe('recovering from failures', () => {
    it('a failed action is fed back and the run continues with another attempt', async () => {
      setMode('autonomous');
      h.execFailures = 1;
      h.script = { 'flaky task': [CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('flaky task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(1);
      expect(h.bodies[1]).toMatch(/FAILED: COVERED/);
      expect(h.bodies[1]).toMatch(/Try a different approach/);
    });

    it('a stale preview (the page updated) is not fatal: it re-reads the page and tries again', async () => {
      setMode('autonomous');
      h.staleHighlights = 1;
      h.script = { 'stale task': [CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('stale task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(1);
      expect(h.bodies[1]).toMatch(/FAILED: The element changed since it was previewed/);
      const runId = (await snap(m)).runId;
      const rows = (await getLog()).filter((e) => e.runId === runId);
      expect(rows.filter((e) => e.outcome === 'failed')).toHaveLength(1); // no extra "Run failed" row
      expect(rows.some((e) => e.actionSummary === 'Run failed')).toBe(false);
    });

    it('the same recovery applies in safe mode: the new attempt asks for approval again', async () => {
      h.staleHighlights = 1;
      h.script = { 'stale task': [CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('stale task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      const s = await snap(m);
      expect(s.step).toBe(2);
      expect(m.approve(s.sessionId!, s.proposal!.actionId)).toBe(true);
      await untilStatus(m, ACTIVE_TAB, 'completed');
    });

    it('an error thrown mid-step (page navigating, script unreachable) is recovered from too', async () => {
      setMode('autonomous');
      h.throwOnCall = 1;
      h.script = { 'nav task': [CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('nav task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(1);
      expect(h.bodies[1]).toMatch(/FAILED: Frame with ID 0 was removed/);
    });

    it('but a tab that no longer exists still ends the run', async () => {
      setMode('autonomous');
      const chromeFake = (globalThis as unknown as { chrome: { tabs: { sendMessage: (id: number, msg: { type: string }) => Promise<unknown> } } }).chrome;
      const original = chromeFake.tabs.sendMessage;
      chromeFake.tabs.sendMessage = async (id, msg) => {
        if (msg.type === 'cs/execute') {
          h.closed.add(id);
          throw new Error('No tab with id');
        }
        return original(id, msg);
      };
      h.script = { 'gone task': [CLICK, CLICK, CLICK] };
      const m = new SessionManager();
      await m.start('gone task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'error');
      expect((await snap(m)).lastError).toMatch(/tab was closed/i);
    });

    it('gives up only after 6 failures in a row, and says why', async () => {
      setMode('autonomous');
      h.execFailures = 100;
      h.changingPage = true; // so the loop guard is not what stops it
      h.script = { 'doomed task': Array.from({ length: 20 }, () => CLICK) };
      const m = new SessionManager();
      await m.start('doomed task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'error');
      expect((await snap(m)).lastError).toMatch(/Could not make progress after 6 attempts.*COVERED/);
      expect(h.fetchCalls).toBe(6);
    });

    it('a step that works resets the failure count', async () => {
      setMode('autonomous');
      h.changingPage = true;
      h.execFailures = 5;
      h.script = { 'flaky task': [...Array.from({ length: 6 }, () => CLICK), CLICK, DONE] };
      const m = new SessionManager();
      await m.start('flaky task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      expect(h.executed).toHaveLength(2); // 5 failures, then two that ran
    });
  });

  describe('activity log', () => {
    const rowsFor = async (m: SessionManager, tabId = ACTIVE_TAB) => {
      const runId = (await snap(m, tabId)).runId;
      return (await getLog()).filter((e) => e.runId === runId);
    };

    it('has one row per step for an automatic action (not proposed + executed)', async () => {
      setMode('autonomous');
      h.script = { 'log task': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('log task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      const clicks = (await rowsFor(m)).filter((e) => e.actionType === 'click');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({ outcome: 'auto_executed', actionSummary: expect.stringContaining('Click') });
    });

    it('has one row per step for an approved action, ending as executed', async () => {
      h.script = { 'log task': [CLICK, DONE] };
      const m = new SessionManager();
      await m.start('log task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'awaiting_confirmation');
      expect((await rowsFor(m)).filter((e) => e.actionType === 'click')).toMatchObject([{ outcome: 'proposed' }]);
      const s = await snap(m);
      m.approve(s.sessionId!, s.proposal!.actionId);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      const clicks = (await rowsFor(m)).filter((e) => e.actionType === 'click');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.outcome).toBe('executed');
      expect(clicks[0]!.detail).toMatch(/^Approved by you\./);
    });

    it('a failed action updates its own row instead of adding a second failure row', async () => {
      setMode('autonomous');
      h.execFailures = 1;
      h.script = { 'log task': [CLICK, CLICK, DONE] };
      const m = new SessionManager();
      await m.start('log task', ACTIVE_TAB);
      await untilStatus(m, ACTIVE_TAB, 'completed');
      const clicks = (await rowsFor(m)).filter((e) => e.actionType === 'click');
      expect(clicks.map((e) => e.outcome)).toEqual(['failed', 'auto_executed']);
    });
  });

  it('restores finished views after a worker restart and marks active runs stopped', async () => {
    h.script = { 'task on seven': [CLICK] };
    const first = new SessionManager();
    await first.start('task on seven', ACTIVE_TAB);
    await untilStatus(first, ACTIVE_TAB, 'awaiting_confirmation');

    const second = new SessionManager(); // same session storage, fresh worker
    await second.init();
    const s = await snap(second, ACTIVE_TAB);
    expect(s.status).toBe('stopped');
    expect(s.statusDetail).toMatch(/restarted/);
    expect(second.activeCount()).toBe(0);
  });
});
