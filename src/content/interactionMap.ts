import {
  MAX_CANDIDATES_SCANNED,
  MAX_ELEMENTS,
  MAX_NAME_CHARS,
  MAX_NEARBY_CHARS,
  MAX_SELECT_OPTIONS,
  MAX_SHADOW_SCAN_NODES,
  MAX_SNIPPET_CHARS,
  MAX_TEXT_SNIPPETS,
  MAX_VALUE_CHARS,
  MAX_VISIBLE_TEXT_CHARS,
} from '../shared/constants';
import { normalizeWhitespace, redactText, truncate } from '../shared/redaction';
import { keywordHints } from '../shared/risk';
import type { ElementDescriptor, ExecCode, PageMap } from '../shared/schemas';
import { OVERLAY_HOST_ID } from './mutationTracking';
import { isSensitiveField, labelTextFor } from './sensitiveData';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'textarea',
  'select',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=menuitem]',
].join(',');

/** Read-only content regions offered to `extract` (never to click/type/select). */
const REGION_SELECTOR = 'table,main,article,[role=main],ul,ol,dl,section';
const MAX_REGIONS = 20;
const MAX_REGION_SCAN = 600;

const TEXT_SELECTOR = 'h1,h2,h3,h4,p,li,td,th,dt,dd,legend,figcaption,[role=heading]';

/* ---- stable ids -------------------------------------------------- */

let counter = 0;
let ids = new WeakMap<Element, string>();
const known = new Map<string, WeakRef<Element>>();
/** Valid only for the most recent build (the "current page state"). */
let currentById = new Map<string, Element>();
let currentDescriptors = new Map<string, ElementDescriptor>();

export function resetInteractionMapState(): void {
  counter = 0;
  ids = new WeakMap();
  known.clear();
  currentById = new Map();
  currentDescriptors = new Map();
}

function idFor(el: Element): string {
  let id = ids.get(el);
  if (!id) {
    id = `el_${++counter}`;
    ids.set(el, id);
    known.set(id, new WeakRef(el));
  }
  return id;
}

/* ---- visibility -------------------------------------------------- */

export function isRendered(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    try {
      if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch {
      /* fall through to manual checks */
    }
  }
  const own = win.getComputedStyle(el);
  if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
  if (parseFloat(own.opacity || '1') < 0.01) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return false;
    if (win.getComputedStyle(n).display === 'none') return false;
  }
  return true;
}

export function isInViewport(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
}

/* ---- describing elements ----------------------------------------- */

const clean = (s: string | null | undefined, max = MAX_NAME_CHARS): string =>
  truncate(redactText(normalizeWhitespace(s ?? '')), max);

function ownText(el: Element): string {
  const anyEl = el as HTMLElement;
  return (typeof anyEl.innerText === 'string' ? anyEl.innerText : el.textContent) ?? '';
}

function implicitRole(el: Element, type: string): string | null {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
    case 'summary':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input':
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return type === 'range' ? 'slider' : 'textbox';
    default:
      return null;
  }
}

export function getAccessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clean(aria);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (['submit', 'button', 'reset'].includes(type)) {
      return clean(el.getAttribute('value') || (type === 'reset' ? 'Reset' : 'Submit'));
    }
    if (type === 'image') return clean(el.getAttribute('alt') || 'Image button');
    const l = labelTextFor(el);
    if (l) return clean(l);
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
  }
  const text = clean(ownText(el));
  if (text) return text;
  const img = el.querySelector('img[alt]');
  if (img && img.getAttribute('alt')?.trim()) return clean(img.getAttribute('alt'));
  return clean(el.getAttribute('title'));
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Identity of an element that survives scrolling but changes when the control itself changes. */
export function computeFingerprint(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const role = el.getAttribute('role') ?? implicitRole(el, type) ?? '';
  const name = getAccessibleName(el);
  const text = clean(ownText(el), 60);
  const href = tag === 'a' ? (el.getAttribute('href') ?? '') : '';
  return hashString([tag, role, type, name, text, href].join('|'));
}

function safePathHint(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const esc = (s: string) => truncate(s.replace(/['"\\\n\r]/g, '').trim(), 40);
  const aria = el.getAttribute('aria-label');
  if (aria && esc(aria)) return `${tag}[aria-label='${esc(aria)}']`;
  const id = el.getAttribute('id');
  if (id && /^[A-Za-z][\w-]{0,40}$/.test(id) && !/\d{4,}|[0-9a-f]{8,}/i.test(id)) return `${tag}#${id}`;
  const name = el.getAttribute('name');
  if (name && esc(name)) return `${tag}[name='${esc(name)}']`;
  const testId = el.getAttribute('data-testid');
  if (testId && esc(testId)) return `${tag}[data-testid='${esc(testId)}']`;
  const type = el.getAttribute('type');
  if (type) return `${tag}[type='${esc(type)}']`;
  const parent = el.parentElement;
  const idx = parent ? Array.from(parent.children).filter((c) => c.tagName === el.tagName).indexOf(el) + 1 : 1;
  return `${tag}:nth-of-type(${Math.max(1, idx)})`;
}

function nearbyText(el: Element): string {
  const parts: string[] = [];
  const form = el.closest('form');
  if (form) {
    parts.push(
      form.getAttribute('aria-label') ?? '',
      form.getAttribute('name') ?? '',
      form.getAttribute('id') ?? '',
      (form.getAttribute('action') ?? '').split('?')[0],
    );
  }
  const container = el.closest('fieldset,section,dialog,[role=dialog],article,form');
  const heading = container?.querySelector('legend,h1,h2,h3,h4,[role=heading]');
  if (heading) parts.push(heading.textContent ?? '');
  return clean(parts.filter(Boolean).join(' '), MAX_NEARBY_CHARS);
}

function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  try {
    return el.matches(':disabled');
  } catch {
    return (el as HTMLInputElement).disabled === true;
  }
}

export function describeElement(el: Element, id: string): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const typeAttr = (el.getAttribute('type') ?? '').toLowerCase();
  const isInput = tag === 'input';
  const inputType = isInput ? typeAttr || 'text' : tag === 'button' ? typeAttr || null : null;
  const role = el.getAttribute('role') ?? implicitRole(el, inputType ?? '');
  const sensitive = isSensitiveField(el);
  const form = el.closest('form');
  const name = getAccessibleName(el);
  const rawText = clean(ownText(el));
  const labelTxt = tag === 'input' || tag === 'textarea' || tag === 'select' ? clean(labelTextFor(el)) : '';

  const isSubmit =
    (tag === 'button' && (typeAttr === 'submit' || (typeAttr === '' && !!form))) ||
    (isInput && (typeAttr === 'submit' || typeAttr === 'image'));

  let value: string | null = null;
  let options: string[] | null = null;
  let checked: boolean | null = null;

  if (!sensitive) {
    if (tag === 'textarea' || (isInput && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(typeAttr))) {
      const v = (el as HTMLInputElement).value;
      value = v ? clean(v, MAX_VALUE_CHARS) : null;
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      options = Array.from(sel.options)
        .slice(0, MAX_SELECT_OPTIONS)
        .map((o) => clean(o.label || o.textContent, 60));
      const cur = sel.selectedOptions?.[0];
      value = cur ? clean(cur.label || cur.textContent, MAX_VALUE_CHARS) : null;
    }
  }
  if (isInput && (typeAttr === 'checkbox' || typeAttr === 'radio')) checked = (el as HTMLInputElement).checked;
  else if (role === 'checkbox' || role === 'radio' || role === 'switch') checked = el.getAttribute('aria-checked') === 'true';

  let expanded: boolean | null = null;
  const ae = el.getAttribute('aria-expanded');
  if (ae === 'true' || ae === 'false') expanded = ae === 'true';
  else if (tag === 'summary') expanded = !!el.closest('details')?.hasAttribute('open');

  const r = el.getBoundingClientRect();
  const href = tag === 'a' ? clean((el as HTMLAnchorElement).href || el.getAttribute('href'), 300) : null;

  return {
    id: id as ElementDescriptor['id'],
    tag,
    role: role ?? null,
    name,
    visibleText: rawText,
    label: labelTxt || null,
    inputType,
    placeholder: el.getAttribute('placeholder') ? clean(el.getAttribute('placeholder')) : null,
    autocomplete: el.getAttribute('autocomplete'),
    href: href || null,
    value,
    checked,
    expanded,
    options,
    disabled: isDisabled(el),
    visible: true,
    inViewport: isInViewport(el),
    inForm: !!form,
    isSubmit,
    sensitive,
    extractOnly: false,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    riskHints: keywordHints([name, rawText, labelTxt].join(' ')),
    safePathHint: safePathHint(el),
    nearbyText: nearbyText(el),
    fingerprint: computeFingerprint(el),
  };
}

const REGION_ROLES: Record<string, string> = {
  table: 'table',
  main: 'main',
  article: 'article',
  ul: 'list',
  ol: 'list',
  dl: 'list',
  section: 'region',
};

const HEADING = 'caption,h1,h2,h3,h4,legend,[role=heading]';

function qualifiesAsRegion(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (el.closest('nav,[role=navigation],[role=menu]')) return false;
  switch (tag) {
    case 'table':
      return !!el.querySelector('tr');
    case 'ul':
    case 'ol':
      return Array.from(el.children).filter((c) => c.tagName === 'LI').length >= 3;
    case 'dl':
      return !!el.querySelector('dt');
    case 'section':
      return !!el.querySelector('h1,h2,h3,h4,[role=heading]');
    default:
      return true; // main / article / [role=main]
  }
}

/** Descriptor for a read-only content region: never sensitive-field data, only valid for `extract`. */
function describeRegion(el: Element, id: string): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute('aria-label');
  const name = aria?.trim()
    ? clean(aria)
    : clean(el.querySelector(HEADING)?.textContent) || clean(el.textContent, 60);
  const role = el.getAttribute('role') ?? REGION_ROLES[tag] ?? 'region';
  const r = el.getBoundingClientRect();
  return {
    id: id as ElementDescriptor['id'],
    tag,
    role,
    name,
    visibleText: '',
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
    inViewport: isInViewport(el),
    inForm: false,
    isSubmit: false,
    sensitive: false,
    extractOnly: true,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    riskHints: [],
    safePathHint: safePathHint(el),
    nearbyText: '',
    fingerprint: hashString([tag, role, name, 'region'].join('|')),
  };
}

function collectRegions(doc: Document, exclude: Set<Element>): Element[] {
  const out: Element[] = [];
  let scanned = 0;
  for (const el of Array.from(doc.querySelectorAll(REGION_SELECTOR))) {
    if (++scanned > MAX_REGION_SCAN || out.length >= MAX_REGIONS) break;
    if (exclude.has(el) || el.closest(`#${OVERLAY_HOST_ID}`)) continue;
    if (!isRendered(el) || !qualifiesAsRegion(el)) continue;
    out.push(el);
  }
  return out;
}

/* ---- collecting -------------------------------------------------- */

function collectCandidates(root: Document | ShadowRoot, out: Element[], budget: { n: number }): void {
  for (const e of Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (out.length >= MAX_CANDIDATES_SCANNED) break;
    out.push(e);
  }
  for (const e of Array.from(root.querySelectorAll('*'))) {
    if (--budget.n < 0) return;
    const sr = (e as Element).shadowRoot; // only open shadow roots are reachable
    if (sr) collectCandidates(sr, out, budget);
  }
}

function collectTextSnippets(doc: Document): string[] {
  const win = doc.defaultView;
  const vh = win?.innerHeight ?? 800;
  const seen = new Set<string>();
  const out: string[] = [];
  let total = 0;
  let scanned = 0;
  for (const el of Array.from(doc.querySelectorAll(TEXT_SELECTOR))) {
    if (++scanned > 800 || out.length >= MAX_TEXT_SNIPPETS || total >= MAX_VISIBLE_TEXT_CHARS) break;
    if (el.closest(`#${OVERLAY_HOST_ID}`)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh * 1.5) continue;
    if (!isRendered(el)) continue;
    const t = clean(ownText(el), MAX_SNIPPET_CHARS);
    if (t.length < 3 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    total += t.length;
  }
  return out;
}

/** Build a fresh interaction map. Replaces the id → Element mapping (valid for this page state only). */
export function buildInteractionMap(doc: Document = document): PageMap {
  const win = doc.defaultView!;
  const candidates: Element[] = [];
  collectCandidates(doc, candidates, { n: MAX_SHADOW_SCAN_NODES });

  const rendered: Array<{ el: Element; vp: boolean }> = [];
  for (const el of candidates) {
    if (!isRendered(el)) continue;
    rendered.push({ el, vp: isInViewport(el) });
  }
  // In-viewport controls first; stable within each group (document order).
  const ordered = [...rendered.filter((r) => r.vp), ...rendered.filter((r) => !r.vp)];
  const truncated = ordered.length > MAX_ELEMENTS;
  const kept = ordered.slice(0, MAX_ELEMENTS);
  const regions = collectRegions(doc, new Set(candidates));
  const vpCount = kept.filter((k) => k.vp).length;

  const byId = new Map<string, Element>();
  const descriptors = new Map<string, ElementDescriptor>();
  const elements: ElementDescriptor[] = [];
  const add = (el: Element, region: boolean) => {
    const id = idFor(el);
    const d = region ? describeRegion(el, id) : describeElement(el, id);
    byId.set(d.id, el);
    descriptors.set(d.id, d);
    elements.push(d);
  };
  // Order: on-screen controls, content regions, then off-screen controls (trimmed first when over budget).
  kept.slice(0, vpCount).forEach(({ el }) => add(el, false));
  regions.forEach((el) => add(el, true));
  kept.slice(vpCount).forEach(({ el }) => add(el, false));
  currentById = byId;
  currentDescriptors = descriptors;

  return {
    url: doc.location?.href ?? '',
    title: clean(doc.title, 200),
    capturedAt: Date.now(),
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      scrollY: Math.round(win.scrollY ?? 0),
      scrollHeight: doc.documentElement?.scrollHeight ?? 0,
    },
    textSnippets: collectTextSnippets(doc),
    elements,
    truncated,
  };
}

export type TargetLookup =
  | { ok: true; el: Element; descriptor: ElementDescriptor }
  | { ok: false; code: ExecCode; message: string };

/**
 * Refresh the map, then resolve `id` and verify it is still the same control the user was shown.
 * Any mismatch stops the action (fail closed).
 */
export function findTarget(id: string, expectedFingerprint: string | undefined, doc: Document = document): TargetLookup {
  buildInteractionMap(doc);
  const el = currentById.get(id);
  if (!el) {
    const ref = known.get(id)?.deref();
    if (!ref || !ref.isConnected) {
      return { ok: false, code: 'NOT_FOUND', message: 'The element was not found after the page changed.' };
    }
    return {
      ok: false,
      code: 'NOT_VISIBLE',
      message: 'The element is no longer visible or is not part of the current page map.',
    };
  }
  const descriptor = currentDescriptors.get(id)!;
  if (expectedFingerprint !== undefined && descriptor.fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      code: 'STALE_TARGET',
      message: 'The element changed since it was previewed (the page updated), so the action was cancelled.',
    };
  }
  return { ok: true, el, descriptor };
}
