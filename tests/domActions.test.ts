import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction } from '../src/content/domActions';
import { buildInteractionMap, resetInteractionMapState } from '../src/content/interactionMap';
import type { ExecutableAction } from '../src/shared/schemas';

beforeEach(() => {
  resetInteractionMapState();
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 100, height: 30, top: 10, left: 10, right: 110, bottom: 40, toJSON() {} } as DOMRect;
  };
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
});

function setup(html: string, pick: (els: ReturnType<typeof buildInteractionMap>['elements']) => number = () => 0) {
  document.body.innerHTML = html;
  const map = buildInteractionMap(document);
  const d = map.elements[pick(map.elements)];
  return { d, map };
}

const region = (els: Array<{ extractOnly: boolean }>) => els.findIndex((e) => e.extractOnly);

const click = (id: string): ExecutableAction => ({ type: 'click', targetId: id as `el_${number}`, reason: 'r' });
const typeText = (id: string, text: string, clearFirst = true): ExecutableAction => ({
  type: 'type_text',
  targetId: id,
  text,
  clearFirst,
  reason: 'r',
});

describe('click', () => {
  it('clicks a normal control after fingerprint verification', async () => {
    const onClick = vi.fn();
    const { d } = setup(`<button id="b">Next page</button>`);
    document.getElementById('b')!.addEventListener('click', onClick);
    const r = await executeAction(click(d.id), d.fingerprint, document);
    expect(r.ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses when the target changed (stale) and does not click', async () => {
    const onClick = vi.fn();
    const { d } = setup(`<button id="b">Save draft</button>`);
    const b = document.getElementById('b')!;
    b.addEventListener('click', onClick);
    b.textContent = 'Delete everything';
    const r = await executeAction(click(d.id), d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'STALE_TARGET' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('reports a removed element clearly', async () => {
    const { d } = setup(`<button id="b">Next</button>`);
    document.getElementById('b')!.remove();
    const r = await executeAction(click(d.id), d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(!r.ok && r.message).toMatch(/page changed/i);
  });

  it('refuses disabled controls, javascript: links, downloads and file inputs', async () => {
    const dis = setup(`<button id="b" disabled>Nope</button>`);
    expect(await executeAction(click(dis.d.id), dis.d.fingerprint, document)).toMatchObject({ ok: false, code: 'DISABLED' });

    const js = setup(`<a id="a" href="javascript:alert(1)">Run</a>`);
    expect(await executeAction(click(js.d.id), js.d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });

    const dl = setup(`<a id="a" href="/f.zip" download>Get</a>`);
    expect(await executeAction(click(dl.d.id), dl.d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });

    const file = setup(`<input id="f" type="file" aria-label="Upload">`);
    expect(await executeAction(click(file.d.id), file.d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  });

  it('flags a covered target', async () => {
    const { d } = setup(`<button id="b">Under</button><div id="cover">Overlay</div>`);
    const cover = document.getElementById('cover')!;
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => cover;
    const onClick = vi.fn();
    document.getElementById('b')!.addEventListener('click', onClick);
    const r = await executeAction(click(d.id), d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'COVERED' });
    expect(onClick).not.toHaveBeenCalled();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });
});

describe('type_text', () => {
  it('uses the native value setter and fires focus/input/change so controlled inputs update', async () => {
    const { d } = setup(`<input id="i" type="text" aria-label="Name">`);
    const input = document.getElementById('i') as HTMLInputElement;

    // Simulate React's value tracker: assigning `.value` on the instance is ignored by frameworks;
    // the prototype setter is what triggers their input handlers.
    let instanceSetterUsed = false;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(this);
      },
      set(v: string) {
        instanceSetterUsed = true;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(this, v);
      },
    });

    const events: string[] = [];
    let seen = '';
    for (const t of ['focus', 'input', 'change', 'blur']) input.addEventListener(t, (e) => {
      events.push(e.type);
      if (e.type === 'input') seen = (e.target as HTMLInputElement).value;
    });

    const r = await executeAction(typeText(d.id, 'John Doe'), d.fingerprint, document);
    expect(r.ok).toBe(true);
    expect(input.value).toBe('John Doe');
    expect(seen).toBe('John Doe');
    expect(events).toEqual(['focus', 'input', 'change', 'blur']);
    expect(instanceSetterUsed).toBe(false);
  });

  it('appends when clearFirst is false and clears when true', async () => {
    const { d } = setup(`<textarea id="t" aria-label="Message">Hello</textarea>`);
    const ta = document.getElementById('t') as HTMLTextAreaElement;
    await executeAction(typeText(d.id, ' world', false), d.fingerprint, document);
    expect(ta.value).toBe('Hello world');
    await executeAction(typeText(d.id, 'Hi', true), d.fingerprint, document);
    expect(ta.value).toBe('Hi');
  });

  it('rejects password and other sensitive fields without touching them', async () => {
    for (const html of [
      `<input id="i" type="password" aria-label="Password">`,
      `<input id="i" type="text" name="cardnumber" aria-label="Card">`,
      `<input id="i" type="text" autocomplete="one-time-code" aria-label="Code">`,
    ]) {
      const { d } = setup(html);
      const r = await executeAction(typeText(d.id, 'x'), d.fingerprint, document);
      expect(r).toMatchObject({ ok: false, code: 'SENSITIVE' });
      expect((document.getElementById('i') as HTMLInputElement).value).toBe('');
    }
  });

  it('rejects non-text targets and read-only fields', async () => {
    const btn = setup(`<button id="b">Go</button>`);
    expect(await executeAction(typeText(btn.d.id, 'x'), btn.d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    const ro = setup(`<input id="i" type="text" readonly aria-label="Ro">`);
    expect(await executeAction(typeText(ro.d.id, 'x'), ro.d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  });

  it('detects fields that truncate input (verification)', async () => {
    const { d } = setup(`<input id="i" type="text" aria-label="Short">`);
    // Simulate a masked/limited input that silently truncates programmatic values.
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get: desc.get,
      set(v: string) {
        desc.set!.call(this, String(v).slice(0, 3));
      },
    });
    const r = await executeAction(typeText(d.id, 'abcdef'), d.fingerprint, document);
    Object.defineProperty(HTMLInputElement.prototype, 'value', desc);
    expect(r).toMatchObject({ ok: false, code: 'VERIFY_FAILED' });
  });
});

describe('select_option and set_checked', () => {
  it('selects by value or visible label and fires input+change', async () => {
    const { d } = setup(`<select id="s" aria-label="City"><option value="nyc">New York</option><option value="tpa">Tampa</option></select>`);
    const s = document.getElementById('s') as HTMLSelectElement;
    const fired: string[] = [];
    s.addEventListener('input', () => fired.push('input'));
    s.addEventListener('change', () => fired.push('change'));
    const r = await executeAction({ type: 'select_option', targetId: d.id, value: 'tampa', reason: 'r' }, d.fingerprint, document);
    expect(r.ok).toBe(true);
    expect(s.value).toBe('tpa');
    expect(fired).toEqual(['input', 'change']);
    const r2 = await executeAction({ type: 'select_option', targetId: d.id, value: 'nyc', reason: 'r' }, d.fingerprint, document);
    expect(r2.ok).toBe(true);
    expect(s.value).toBe('nyc');
  });

  it('errors when no option matches', async () => {
    const { d } = setup(`<select aria-label="City"><option value="a">A</option></select>`);
    const r = await executeAction({ type: 'select_option', targetId: d.id, value: 'zzz', reason: 'r' }, d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('sets and verifies checkbox state', async () => {
    const { d } = setup(`<input id="c" type="checkbox" aria-label="Newsletter">`);
    const c = document.getElementById('c') as HTMLInputElement;
    expect((await executeAction({ type: 'set_checked', targetId: d.id, checked: true, reason: 'r' }, d.fingerprint, document)).ok).toBe(true);
    expect(c.checked).toBe(true);
    // already in the desired state: no toggle
    expect((await executeAction({ type: 'set_checked', targetId: d.id, checked: true, reason: 'r' }, d.fingerprint, document)).ok).toBe(true);
    expect(c.checked).toBe(true);
    expect((await executeAction({ type: 'set_checked', targetId: d.id, checked: false, reason: 'r' }, d.fingerprint, document)).ok).toBe(true);
    expect(c.checked).toBe(false);
  });

  it('cannot uncheck a radio directly', async () => {
    const { d } = setup(`<input id="r" type="radio" checked aria-label="Option">`);
    const r = await executeAction({ type: 'set_checked', targetId: d.id, checked: false, reason: 'r' }, d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  });
});

describe('scroll', () => {
  it('scrolls the active page by a fraction of the viewport', async () => {
    const r = await executeAction({ type: 'scroll', direction: 'down', amount: 'medium', reason: 'r' }, undefined, document);
    expect(r.ok).toBe(true);
    expect(window.scrollBy).toHaveBeenCalledWith({ top: window.innerHeight * 0.6, left: 0, behavior: 'auto' });
  });
});

describe('extract', () => {
  it('extracts sanitized text without input values', async () => {
    const { d } = setup(
      `<article id="box"><h2>Policy</h2><p>Price 4242 4242 4242 4242 ok</p><input type="password" value="hunter2" aria-label="Password"></article>`,
      region,
    );
    expect(d.extractOnly).toBe(true);
    const r = await executeAction({ type: 'extract', targetId: d.id, format: 'text', reason: 'r' }, d.fingerprint, document);
    expect(r.ok).toBe(true);
    const text = r.ok ? (r.extracted?.text ?? '') : '';
    expect(text).toContain('Price');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4242 4242');
  });

  it('extracts a table', async () => {
    const { d } = setup(`<table id="t"><tr><th>Item</th><th>Qty</th></tr><tr><td>Pen</td><td>2</td></tr></table>`, region);
    const r = await executeAction({ type: 'extract', targetId: d.id, format: 'table', reason: 'r' }, d.fingerprint, document);
    expect(r.ok && r.extracted?.rows).toEqual([['Item', 'Qty'], ['Pen', '2']]);
  });

  it('extracts http(s) links only', async () => {
    const { d } = setup(
      `<ul><li><a href="https://a.example/x">A</a></li><li><a href="mailto:x@y.z">M</a></li><li><a href="javascript:void(0)">J</a></li></ul>`,
      region,
    );
    const r = await executeAction({ type: 'extract', targetId: d.id, format: 'links', reason: 'r' }, d.fingerprint, document);
    expect(r.ok && r.extracted?.links).toEqual([{ text: 'A', href: 'https://a.example/x' }]);
  });

  it('content regions are extract-only: click / type / select / check are refused', async () => {
    const { d } = setup(`<table id="t"><tr><td>Pen</td></tr></table>`, region);
    const onClick = vi.fn();
    document.getElementById('t')!.addEventListener('click', onClick);
    for (const action of [
      click(d.id),
      typeText(d.id, 'x'),
      { type: 'select_option', targetId: d.id, value: 'a', reason: 'r' } as ExecutableAction,
      { type: 'set_checked', targetId: d.id, checked: true, reason: 'r' } as ExecutableAction,
    ]) {
      expect(await executeAction(action, d.fingerprint, document)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    }
    expect(onClick).not.toHaveBeenCalled();
  });

  it('refuses to read sensitive fields', async () => {
    const { d } = setup(`<input type="password" aria-label="Password" value="x">`);
    const r = await executeAction({ type: 'extract', targetId: d.id, format: 'text', reason: 'r' }, d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'SENSITIVE' });
  });
});
