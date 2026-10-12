import { beforeEach, describe, expect, it } from 'vitest';
import { buildInteractionMap, findTarget, resetInteractionMapState } from '../src/content/interactionMap';
import { createMutationTracker } from '../src/content/mutationTracking';
import { isSensitiveField } from '../src/content/sensitiveData';

beforeEach(() => {
  resetInteractionMapState();
  document.body.innerHTML = '';
  // jsdom has no layout: give every element a rendered box.
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 100, height: 30, top: 10, left: 10, right: 110, bottom: 40, toJSON() {} } as DOMRect;
  };
});

function html(s: string) {
  document.body.innerHTML = s;
}

describe('buildInteractionMap', () => {
  it('lists only interactive, rendered elements with descriptors', () => {
    html(`
      <h1>Store</h1>
      <button id="buy" aria-label="Add to cart">Add</button>
      <a href="/contact">Contact us</a>
      <input type="text" name="city" placeholder="City">
      <textarea aria-label="Message"></textarea>
      <select aria-label="Country"><option value="us">United States</option><option value="ca">Canada</option></select>
      <input type="checkbox" aria-label="Subscribe">
      <div role="button">Custom</div>
      <div role="tab">Tab A</div>
      <p>Not interactive</p>
      <button hidden>Hidden button</button>
      <button style="display:none">Display none</button>
      <input type="hidden" name="csrf" value="secret">
    `);
    const map = buildInteractionMap(document);
    const names = map.elements.map((e) => e.name);
    expect(names).toContain('Add to cart');
    expect(names).toContain('Contact us');
    expect(names).toContain('Custom');
    expect(names).not.toContain('Hidden button');
    expect(names).not.toContain('Display none');
    expect(map.elements.find((e) => e.tag === 'input' && e.inputType === 'hidden')).toBeUndefined();
    expect(map.elements.find((e) => e.role === 'tab')).toBeTruthy();

    const btn = map.elements.find((e) => e.name === 'Add to cart')!;
    expect(btn).toMatchObject({ tag: 'button', role: 'button', disabled: false, visible: true });
    expect(btn.id).toMatch(/^el_\d+$/);
    expect(btn.riskHints).toContain('commerce');
    expect(btn.safePathHint).toBe("button[aria-label='Add to cart']");

    const sel = map.elements.find((e) => e.tag === 'select')!;
    expect(sel.options).toEqual(['United States', 'Canada']);
    expect(map.title).toBeDefined();
    expect(map.textSnippets).toContain('Store');
  });

  it('never exposes password / sensitive field values', () => {
    html(`
      <input type="password" id="pw" aria-label="Password" value="hunter2-secret">
      <input type="text" name="cardnumber" placeholder="Card number" value="4242 4242 4242 4242">
      <input type="text" autocomplete="one-time-code" aria-label="Code" value="123456">
      <input type="text" aria-label="Full name" value="John Doe">
    `);
    const map = buildInteractionMap(document);
    const json = JSON.stringify(map);
    expect(json).not.toContain('hunter2-secret');
    expect(json).not.toContain('4242');
    expect(json).not.toContain('123456');
    const pw = map.elements.find((e) => e.inputType === 'password')!;
    expect(pw.sensitive).toBe(true);
    expect(pw.value).toBeNull();
    expect(map.elements.filter((e) => e.sensitive)).toHaveLength(3);
    expect(map.elements.find((e) => e.name === 'Full name')!.value).toBe('John Doe');
  });

  it('redacts card numbers in visible text and names', () => {
    html(`<p>Card on file 4242 4242 4242 4242 thanks</p><button>Pay 4242424242424242</button>`);
    const json = JSON.stringify(buildInteractionMap(document));
    expect(json).not.toContain('4242 4242 4242 4242');
    expect(json).not.toContain('4242424242424242');
    expect(json).toContain('[REDACTED_CARD]');
  });

  it('offers tables, articles and lists as extract-only regions (never nav menus or tiny lists)', () => {
    html(`
      <nav><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul></nav>
      <main>
        <article><h2>Return policy</h2><p>30 days.</p></article>
        <table><caption>Prices</caption><tr><td>Pen</td><td>2</td></tr></table>
        <ul><li>one</li><li>two</li><li>three</li></ul>
        <ul><li>x</li><li>y</li></ul>
      </main>
    `);
    const map = buildInteractionMap(document);
    const regions = map.elements.filter((e) => e.extractOnly);
    expect(regions.map((r) => r.tag).sort()).toEqual(['article', 'main', 'table', 'ul']);
    expect(regions.find((r) => r.tag === 'table')!.name).toBe('Prices');
    expect(regions.find((r) => r.tag === 'article')!.name).toBe('Return policy');
    // regions are never sensitive/controls, and normal controls are not flagged
    expect(regions.every((r) => !r.sensitive && !r.isSubmit && r.value === null)).toBe(true);
    expect(map.elements.filter((e) => e.tag === 'a').every((e) => !e.extractOnly)).toBe(true);
  });

  it('keeps ids stable for the same element across rebuilds', () => {
    html(`<button id="a">A</button><button id="b">B</button>`);
    const first = buildInteractionMap(document);
    const again = buildInteractionMap(document);
    expect(again.elements.map((e) => e.id)).toEqual(first.elements.map((e) => e.id));
  });

  it('flags submit buttons and forms', () => {
    html(`<form action="/checkout"><input type="text" aria-label="Name"><button>Go</button></form><button type="button">Plain</button>`);
    const map = buildInteractionMap(document);
    expect(map.elements.find((e) => e.name === 'Go')).toMatchObject({ isSubmit: true, inForm: true });
    expect(map.elements.find((e) => e.name === 'Plain')).toMatchObject({ isSubmit: false, inForm: false });
  });

  it('caps the number of elements and marks the map truncated', () => {
    html(Array.from({ length: 400 }, (_, i) => `<button>B${i}</button>`).join(''));
    const map = buildInteractionMap(document);
    expect(map.elements.length).toBe(150);
    expect(map.truncated).toBe(true);
  });
});

describe('findTarget (stale detection)', () => {
  it('resolves a target and verifies its fingerprint', () => {
    html(`<button id="x">Next</button>`);
    const d = buildInteractionMap(document).elements[0];
    const r = findTarget(d.id, d.fingerprint, document);
    expect(r.ok).toBe(true);
  });

  it('fails closed when the element was removed', () => {
    html(`<button id="x">Next</button>`);
    const d = buildInteractionMap(document).elements[0];
    document.getElementById('x')!.remove();
    const r = findTarget(d.id, d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('fails closed when the element changed meaning', () => {
    html(`<button id="x">Save draft</button>`);
    const d = buildInteractionMap(document).elements[0];
    document.getElementById('x')!.textContent = 'Delete account';
    const r = findTarget(d.id, d.fingerprint, document);
    expect(r).toMatchObject({ ok: false, code: 'STALE_TARGET' });
  });

  it('reports hidden targets', () => {
    html(`<button id="x">Next</button>`);
    const d = buildInteractionMap(document).elements[0];
    document.getElementById('x')!.setAttribute('hidden', '');
    expect(findTarget(d.id, d.fingerprint, document)).toMatchObject({ ok: false, code: 'NOT_VISIBLE' });
  });

  it('does not treat scrolling/typing as a change (fingerprint ignores value and position)', () => {
    html(`<input id="x" type="text" placeholder="City">`);
    const d = buildInteractionMap(document).elements[0];
    (document.getElementById('x') as HTMLInputElement).value = 'Tampa';
    expect(findTarget(d.id, d.fingerprint, document).ok).toBe(true);
  });
});

describe('isSensitiveField', () => {
  it('detects by type, autocomplete, and name hints', () => {
    html(`
      <input id="a" type="password">
      <input id="b" autocomplete="cc-number">
      <input id="c" name="ssn">
      <input id="d" name="search" type="search">
      <input id="e" name="city">
    `);
    const g = (id: string) => document.getElementById(id)!;
    expect(isSensitiveField(g('a'))).toBe(true);
    expect(isSensitiveField(g('b'))).toBe(true);
    expect(isSensitiveField(g('c'))).toBe(true);
    expect(isSensitiveField(g('d'))).toBe(false);
    expect(isSensitiveField(g('e'))).toBe(false);
  });
});

describe('mutation tracking', () => {
  it('marks the map stale on DOM changes and ignores the overlay', async () => {
    html(`<div id="root"></div>`);
    let fired = 0;
    const t = createMutationTracker(document, () => fired++, 5);
    t.markFresh();
    document.getElementById('root')!.appendChild(document.createElement('button'));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.isStale()).toBe(true);
    expect(fired).toBe(1);

    t.markFresh();
    const host = document.createElement('div');
    host.id = '__pilot_overlay_host__';
    document.body.appendChild(host);
    await new Promise((r) => setTimeout(r, 30));
    // appending the host to <body> is a body mutation, but changes inside it must not count
    t.markFresh();
    host.appendChild(document.createElement('span'));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.isStale()).toBe(false);
    t.stop();
  });
});
