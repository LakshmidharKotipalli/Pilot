import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: never[]) => unknown;

interface Fake {
  calls: string[];
  setOptions: { arg: Record<string, unknown> }[];
  open: { arg: Record<string, unknown> }[];
  listeners: Record<string, Listener[]>;
}

/** A fake `chrome` that records the order of side-panel calls and every listener the worker registers. */
function installChrome(): Fake {
  const fake: Fake = { calls: [], setOptions: [], open: [], listeners: {} };
  const event = (name: string) => ({
    addListener: (fn: Listener) => void (fake.listeners[name] ??= []).push(fn),
  });
  const area = () => ({ get: async () => ({}), set: async () => undefined, remove: async () => undefined });
  const quiet = (name: string, extra: Record<string, unknown> = {}) =>
    new Proxy(extra, {
      get: (t, k) => (k in t ? t[k as string] : String(k).startsWith('on') ? event(`${name}.${String(k)}`) : async () => undefined),
    });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(), session: area(), onChanged: event('storage.onChanged') },
    runtime: quiet('runtime', { id: 'ext', getURL: (p: string) => `chrome-extension://ext/${p}`, getPlatformInfo: async () => ({}) }),
    action: quiet('action'),
    tabs: quiet('tabs', { get: async () => null }),
    windows: quiet('windows'),
    notifications: quiet('notifications'),
    sidePanel: {
      setPanelBehavior: async () => undefined,
      setOptions: (arg: Record<string, unknown>) => {
        fake.calls.push('setOptions');
        fake.setOptions.push({ arg });
        return Promise.resolve();
      },
      open: (arg: Record<string, unknown>) => {
        fake.calls.push('open');
        fake.open.push({ arg });
        return Promise.resolve();
      },
    },
  };
  return fake;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('toolbar click', () => {
  it('turns the global panel off and registers no tab-switch listener', async () => {
    const fake = installChrome();
    await import('../src/background/serviceWorker');
    expect(fake.setOptions[0]!.arg).toEqual({ enabled: false }); // no tabId: nothing is enabled by default
    expect(fake.listeners['tabs.onActivated']).toBeUndefined();
    expect(fake.listeners['windows.onFocusChanged']).toBeUndefined();
    expect(fake.listeners['tabs.onRemoved']).toHaveLength(1);
    expect(fake.listeners['tabs.onUpdated']).toHaveLength(1);
  });

  it('configures that tab’s own panel (bound to a session id), then opens it, in the same tick', async () => {
    const fake = installChrome();
    await import('../src/background/serviceWorker');
    fake.calls.length = 0;
    fake.setOptions.length = 0;
    const [onClicked] = fake.listeners['action.onClicked']!;
    // Called synchronously, exactly as Chrome does: any await before open() could lose the user gesture.
    (onClicked as (tab: object) => void)({ id: 41, windowId: 3, url: 'https://example.com/a', title: 'A' });
    expect(fake.calls).toEqual(['setOptions', 'open']);
    const opts = fake.setOptions[0]!.arg;
    expect(opts).toMatchObject({ tabId: 41, enabled: true });
    expect(String(opts.path)).toMatch(/^sidepanel\/index\.html\?bindingId=[0-9a-f-]{36}$/);
    expect(fake.open[0]!.arg).toEqual({ tabId: 41 });
  });

  it('clicking again on the same tab re-opens the same session; another tab gets a different one', async () => {
    const fake = installChrome();
    await import('../src/background/serviceWorker');
    fake.setOptions.length = 0;
    const [onClicked] = fake.listeners['action.onClicked']! as unknown as ((tab: object) => void)[];
    onClicked!({ id: 41, windowId: 3, url: 'https://example.com/a', title: 'A' });
    onClicked!({ id: 41, windowId: 3, url: 'https://example.com/a', title: 'A' });
    onClicked!({ id: 42, windowId: 3, url: 'https://example.com/b', title: 'B' });
    const paths = fake.setOptions.map((c) => String(c.arg.path));
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).not.toBe(paths[0]);
    expect(fake.setOptions.map((c) => c.arg.tabId)).toEqual([41, 41, 42]);
  });
});
