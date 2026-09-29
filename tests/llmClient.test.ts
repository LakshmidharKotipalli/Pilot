import { describe, expect, it, vi } from 'vitest';
import { LlmError, buildUserContent, extractJson, parseAction, requestAction, type PlanContext } from '../src/background/llmClient';
import type { ElementDescriptor, PageMap } from '../src/shared/schemas';

function element(i: number): ElementDescriptor {
  return {
    id: `el_${i}` as ElementDescriptor['id'],
    tag: 'button',
    role: 'button',
    name: `Button ${i}`,
    visibleText: `Button ${i}`,
    label: null,
    inputType: null,
    placeholder: null,
    autocomplete: null,
    href: null,
    value: null,
    checked: null,
    expanded: null,
    options: null,
    disabled: false,
    visible: true,
    inViewport: true,
    inForm: false,
    isSubmit: false,
    sensitive: false,
    extractOnly: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    riskHints: [],
    safePathHint: 'button',
    nearbyText: '',
    fingerprint: `SECRET_FINGERPRINT_${i}`,
  };
}

function ctx(n = 3): PlanContext {
  const map: PageMap = {
    url: 'https://example.com/',
    title: 'Example',
    capturedAt: 0,
    viewport: { width: 1, height: 1, scrollY: 0, scrollHeight: 1 },
    textSnippets: ['Hello'],
    elements: Array.from({ length: n }, (_, i) => element(i + 1)),
    truncated: false,
  };
  return { goal: 'find contact', map, history: [], step: 1 };
}

const deps = (fetchImpl: typeof fetch) => ({
  settings: { apiBaseUrl: 'https://api.example.com/v1', modelId: 'm' },
  apiKey: 'sk-test-key-0000000000000000',
  fetchImpl,
});

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

describe('parsing', () => {
  it('extracts JSON from fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('validates with the strict action schema', () => {
    expect(parseAction('{"type":"click","targetId":"el_1","reason":"x"}').ok).toBe(true);
    const bad = parseAction('{"type":"click","targetId":"#buy","reason":"x"}');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/targetId/);
  });
});

describe('page context', () => {
  it('does not leak fingerprints and stays within budget', () => {
    const { content } = buildUserContent(ctx(3));
    expect(content).not.toContain('SECRET_FINGERPRINT');
    expect(content).toContain('"goal":"find contact"');

    const big = buildUserContent(ctx(150), 3000);
    expect(big.content.length).toBeLessThanOrEqual(3000);
    expect(big.truncated).toBe(true);
  });
});

describe('requestAction', () => {
  it('returns a validated action', async () => {
    const f = vi.fn().mockResolvedValue(reply('{"type":"observe","reason":"look"}'));
    const r = await requestAction(deps(f as unknown as typeof fetch), ctx());
    expect(r.action.type).toBe('observe');
    expect(r.repaired).toBe(false);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test-key-0000000000000000' });
  });

  it('makes exactly one repair attempt that includes the validation errors', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply('{"type":"click","targetId":"#buy","reason":"x"}'))
      .mockResolvedValueOnce(reply('{"type":"click","targetId":"el_2","reason":"fixed"}'));
    const r = await requestAction(deps(f as unknown as typeof fetch), ctx());
    expect(r).toMatchObject({ repaired: true, action: { type: 'click', targetId: 'el_2' } });
    expect(f).toHaveBeenCalledTimes(2);
    const second = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string);
    expect(JSON.stringify(second.messages)).toMatch(/targetId/);
  });

  it('fails (never executes) when output is malformed twice', async () => {
    const f = vi.fn().mockImplementation(async () => reply('I will click the button'));
    await expect(requestAction(deps(f as unknown as typeof fetch), ctx())).rejects.toMatchObject({ code: 'invalid_output' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries once without response_format when the provider rejects it', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"response_format is not supported"}', { status: 400 }))
      .mockResolvedValueOnce(reply('{"type":"complete","result":"ok"}'));
    const r = await requestAction(deps(f as unknown as typeof fetch), ctx());
    expect(r.action.type).toBe('complete');
    expect(JSON.parse((f.mock.calls[1][1] as RequestInit).body as string).response_format).toBeUndefined();
  });

  it('maps auth, missing key and network problems to clear errors', async () => {
    const unauthorized = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(requestAction(deps(unauthorized as unknown as typeof fetch), ctx())).rejects.toMatchObject({ code: 'auth' });

    await expect(requestAction({ ...deps(vi.fn() as unknown as typeof fetch), apiKey: '' }, ctx())).rejects.toMatchObject({ code: 'missing_key' });

    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(requestAction(deps(down as unknown as typeof fetch), ctx())).rejects.toBeInstanceOf(LlmError);
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    const f = vi.fn().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))),
    );
    const p = requestAction({ ...deps(f as unknown as typeof fetch), signal: controller.signal }, ctx());
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('times out', async () => {
    const f = vi.fn().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))),
    );
    await expect(requestAction({ ...deps(f as unknown as typeof fetch), timeoutMs: 20 }, ctx())).rejects.toMatchObject({ code: 'timeout' });
  });
});
