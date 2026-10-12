// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs script with no type declarations
import { createLogServer } from '../scripts/logServer.mjs';
import { emitRunLog, enableRunLogSink, resetRunLogSink } from '../src/background/runLogSink';
import type { LogEntry } from '../src/shared/schemas';

const RUN = '3f2b8c1e-9d4a-4c55-8a71-0123456789ab';
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 'step-1', ts: 1, runId: RUN, prompt: 'test the site', actionType: 'click', actionSummary: 'Click Next',
  target: null, risk: 'low', outcome: 'proposed', detail: null, ...over,
});

function post(port: number, body: unknown, origin: string | null = 'chrome-extension://abc', path = '/log') {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('log server', () => {
  let dir: string;
  let server: ReturnType<typeof createLogServer>;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilot-logs-'));
    server = createLogServer({ dir });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps one JSON file per run, with one row per step that updates in place', async () => {
    expect((await post(port, { host: 'shop.example.com', entry: entry() })).status).toBe(204);
    expect((await post(port, { host: 'shop.example.com', entry: entry({ id: 'step-2', actionSummary: 'Type' }) })).status).toBe(204);
    expect((await post(port, { host: 'shop.example.com', entry: entry({ outcome: 'auto_executed', detail: 'Clicked' }) })).status).toBe(204);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d-]+_shop\.example\.com_3f2b8c1e\.json$/);
    const saved = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'));
    expect(saved).toMatchObject({ runId: RUN, host: 'shop.example.com', prompt: 'test the site' });
    expect(saved.entries.map((e: LogEntry) => [e.id, e.outcome])).toEqual([['step-1', 'auto_executed'], ['step-2', 'proposed']]);
  });

  it('writes separate files for separate runs', async () => {
    await post(port, { host: 'a.example.com', entry: entry() });
    await post(port, { host: 'b.example.com', entry: entry({ runId: '77777777-aaaa-bbbb-cccc-111111111111' }) });
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('refuses anything that is not from a browser extension (web pages, curl)', async () => {
    expect((await post(port, { entry: entry() }, 'https://evil.example.com')).status).toBe(403);
    expect((await post(port, { entry: entry() }, null)).status).toBe(403);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('answers the extension preflight with CORS headers for that origin only', async () => {
    const res = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/log', method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } },
        (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://abc');
  });

  it('rejects bad input and cannot be steered into other paths', async () => {
    expect((await post(port, 'not json')).status).toBe(400);
    expect((await post(port, { entry: entry({ runId: '../../etc/passwd' }) })).status).toBe(400);
    expect((await post(port, { entry: { ...entry(), id: undefined } })).status).toBe(400);
    expect((await post(port, { entry: entry() }, 'chrome-extension://abc', '/other')).status).toBe(404);
    expect((await post(port, { host: '../../../evil', entry: entry() })).status).toBe(204);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('/');
  });

  it('rejects oversized bodies', async () => {
    const res = await post(port, { entry: entry({ detail: 'x'.repeat(300_000) }) }).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
    expect(await readdir(dir)).toHaveLength(0);
  });
});

describe('extension log sink', () => {
  beforeEach(() => resetRunLogSink());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRunLogSink();
  });

  it('sends nothing until it is enabled (so tests and other contexts stay silent)', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    emitRunLog(entry(), 'a.com');
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the row with the host once enabled', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    enableRunLogSink();
    emitRunLog(entry(), 'shop.example.com');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('http://127.0.0.1:8787/log');
    expect(JSON.parse(init.body)).toMatchObject({ host: 'shop.example.com', entry: { id: 'step-1', runId: RUN } });
  });

  it('backs off after a failure so a missing server costs nothing', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', f);
    enableRunLogSink();
    emitRunLog(entry(), null);
    await new Promise((r) => setTimeout(r, 10));
    emitRunLog(entry({ id: 'step-2' }), null);
    emitRunLog(entry({ id: 'step-3' }), null);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
