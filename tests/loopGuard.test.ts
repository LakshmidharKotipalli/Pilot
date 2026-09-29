import { describe, expect, it } from 'vitest';
import { LoopGuard, stepSignature } from '../src/background/loopGuard';
import type { AgentAction, ElementDescriptor, PageMap } from '../src/shared/schemas';

const el = (extra: Partial<ElementDescriptor> = {}): ElementDescriptor => ({
  id: 'el_1', tag: 'button', role: 'button', name: 'Next', visibleText: 'Next', label: null, inputType: null,
  placeholder: null, autocomplete: null, href: null, value: null, checked: null, expanded: null, options: null,
  disabled: false, visible: true, inViewport: true, inForm: false, isSubmit: false, sensitive: false,
  extractOnly: false, rect: { x: 0, y: 0, width: 1, height: 1 }, riskHints: [], safePathHint: 'button',
  nearbyText: '', fingerprint: 'fp1', ...extra,
});
const page = (over: Partial<PageMap> = {}, elements = [el()]): PageMap => ({
  url: 'https://example.com/a', title: 'A', capturedAt: 0,
  viewport: { width: 1, height: 1, scrollY: 0, scrollHeight: 1 }, textSnippets: [], elements, truncated: false, ...over,
});
const click: AgentAction = { type: 'click', targetId: 'el_1', reason: 'go' };

describe('stepSignature', () => {
  it('is identical for the same action, target and page state', () => {
    expect(stepSignature(click, el(), page())).toBe(stepSignature({ ...click, reason: 'different reason' }, el(), page()));
  });

  it('changes with the page state', () => {
    const base = stepSignature(click, el(), page());
    expect(stepSignature(click, el(), page({ url: 'https://example.com/b' }))).not.toBe(base);
    expect(stepSignature(click, el(), page({ title: 'B' }))).not.toBe(base);
    expect(stepSignature(click, el(), page({ viewport: { width: 1, height: 1, scrollY: 50, scrollHeight: 1 } }))).not.toBe(base);
    expect(stepSignature(click, el(), page({}, [el({ checked: true })]))).not.toBe(base);
  });

  it('changes with the action and its target', () => {
    const base = stepSignature(click, el(), page());
    expect(stepSignature(click, el({ fingerprint: 'fp2' }), page())).not.toBe(base);
    expect(stepSignature({ type: 'scroll', direction: 'down', amount: 'small', reason: 'x' }, null, page())).not.toBe(base);
    const t1 = stepSignature({ type: 'type_text', targetId: 'el_1', text: 'a', clearFirst: true, reason: 'x' }, el(), page());
    const t2 = stepSignature({ type: 'type_text', targetId: 'el_1', text: 'b', clearFirst: true, reason: 'x' }, el(), page());
    expect(t1).not.toBe(t2);
  });

  it('does not contain typed text', () => {
    const sig = stepSignature({ type: 'type_text', targetId: 'el_1', text: 'hunter2-secret', clearFirst: true, reason: 'x' }, el(), page());
    expect(sig).not.toContain('hunter2');
  });
});

describe('LoopGuard', () => {
  it('fires on the 4th occurrence within the last 8 steps', () => {
    const g = new LoopGuard();
    expect([g.record('a'), g.record('a'), g.record('a')]).toEqual([false, false, false]);
    expect(g.record('a')).toBe(true);
  });

  it('counts repeats that are not consecutive', () => {
    const g = new LoopGuard();
    const results = ['a', 'b', 'a', 'c', 'a', 'd', 'a'].map((s) => g.record(s));
    expect(results.at(-1)).toBe(true);
  });

  it('forgets steps older than the window', () => {
    const g = new LoopGuard();
    g.record('a'); g.record('a'); g.record('a');
    for (const s of ['1', '2', '3', '4', '5']) g.record(s); // pushes the first "a" out of the last 8
    expect(g.record('a')).toBe(false); // only 3 of the last 8
  });

  it('does not fire for varied steps', () => {
    const g = new LoopGuard();
    expect(Array.from({ length: 50 }, (_, i) => g.record(`step${i}`)).some(Boolean)).toBe(false);
  });

  it('reset clears the history', () => {
    const g = new LoopGuard();
    g.record('a'); g.record('a'); g.record('a');
    g.reset();
    expect(g.record('a')).toBe(false);
  });
});
