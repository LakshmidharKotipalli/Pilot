import {
  MAX_EXTRACT_CHARS,
  MAX_EXTRACT_COLS,
  MAX_EXTRACT_LINKS,
  MAX_EXTRACT_ROWS,
  SCROLL_FRACTION,
} from '../shared/constants';
import { normalizeWhitespace, redactText, truncate } from '../shared/redaction';
import type { ExecResult, ExecutableAction, ExtractedData } from '../shared/schemas';
import { showHighlight } from './highlightOverlay';
import { findTarget } from './interactionMap';
import { isSensitiveField } from './sensitiveData';

type Ok = Extract<ExecResult, { ok: true }>;
type Fail = Extract<ExecResult, { ok: false }>;

const fail = (code: Fail['code'], message: string): Fail => ({ ok: false, code, message });
const ok = (message: string, extra: Partial<Ok> = {}): Ok => ({ ok: true, message, ...extra });

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', '']);

function scrollIntoViewCentered(el: Element): void {
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
}

/** Set `.value` through the prototype's native setter so framework-controlled inputs notice the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

function fireInput(el: Element, data: string | null): void {
  const win = el.ownerDocument.defaultView!;
  const Ctor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
  const ev = Ctor
    ? new Ctor('input', { bubbles: true, cancelable: false, data, inputType: 'insertText' })
    : new win.Event('input', { bubbles: true });
  el.dispatchEvent(ev);
}

const fireChange = (el: Element): boolean => el.dispatchEvent(new (el.ownerDocument.defaultView!.Event)('change', { bubbles: true }));

/** Is the element's center covered by something unrelated? (best effort; skipped where unsupported) */
function isCovered(el: Element): boolean {
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return false;
  const r = el.getBoundingClientRect();
  const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top) return false;
  const sameLabel = !!top.closest('label') && top.closest('label') === el.closest('label');
  return !(el === top || el.contains(top) || top.contains(el) || sameLabel);
}

/**
 * Execute exactly one validated action. The target is re-resolved against a freshly built map and its
 * fingerprint compared with what the user saw; any mismatch aborts.
 */
export async function executeAction(
  action: ExecutableAction,
  expectedFingerprint: string | undefined,
  doc: Document = document,
): Promise<ExecResult> {
  const win = doc.defaultView!;

  if (action.type === 'scroll') {
    const before = win.scrollY;
    const delta = win.innerHeight * SCROLL_FRACTION[action.amount] * (action.direction === 'down' ? 1 : -1);
    win.scrollBy({ top: delta, left: 0, behavior: 'auto' });
    const moved = Math.abs(win.scrollY - before) > 0;
    return ok(
      moved
        ? `Scrolled ${action.direction} (${action.amount}).`
        : `Already at the ${action.direction === 'down' ? 'bottom' : 'top'} of the page.`,
    );
  }

  const lookup = findTarget(action.targetId, expectedFingerprint, doc);
  if (!lookup.ok) return fail(lookup.code, lookup.message);
  const { el, descriptor } = lookup;

  if (descriptor.extractOnly && action.type !== 'extract') {
    return fail('UNSUPPORTED', 'That element is a read-only content region; it can only be read with extract.');
  }
  if (descriptor.disabled && action.type !== 'extract') return fail('DISABLED', 'The element is disabled.');

  try {
    switch (action.type) {
      case 'click':
        return doClick(el, descriptor.name || descriptor.visibleText || descriptor.safePathHint);
      case 'type_text':
        return doType(el, action.text, action.clearFirst);
      case 'select_option':
        return doSelect(el, action.value);
      case 'set_checked':
        return doSetChecked(el, action.checked);
      case 'extract':
        return doExtract(el, action.targetId, action.format);
      default:
        return fail('UNSUPPORTED', 'Unsupported action.');
    }
  } catch (e) {
    return fail('ERROR', e instanceof Error ? e.message : 'Unexpected error while executing the action.');
  }
}

function doClick(el: Element, label: string): ExecResult {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'input' && type === 'file') {
    return fail('UNSUPPORTED', 'File upload controls are not supported for safety.');
  }
  if (tag === 'a') {
    const href = (el.getAttribute('href') ?? '').trim().toLowerCase();
    if (href.startsWith('javascript:')) return fail('UNSUPPORTED', 'javascript: links are never clicked.');
    if (el.hasAttribute('download')) return fail('UNSUPPORTED', 'File downloads are not supported for safety.');
  }
  scrollIntoViewCentered(el);
  showHighlight(el, `Clicking “${truncate(label, 40)}”`, 2000);
  if (isCovered(el)) {
    return fail('COVERED', 'Another element is covering the target, so the click was not performed.');
  }
  const navigating = tag === 'a' && !!(el as HTMLAnchorElement).href && !/^#/.test(el.getAttribute('href') ?? '');
  /* Links stay in this tab: a session never opens or moves to another tab. */
  if (tag === 'a' && (el as HTMLAnchorElement).target && (el as HTMLAnchorElement).target !== '_self') {
    (el as HTMLAnchorElement).target = '_self';
  }
  (el as HTMLElement).click();
  return ok(`Clicked “${truncate(label, 60)}”.`, navigating ? { navigating: true } : {});
}

function doType(el: Element, text: string, clearFirst: boolean): ExecResult {
  const tag = el.tagName.toLowerCase();
  if (isSensitiveField(el)) {
    return fail('SENSITIVE', 'This looks like a password, payment, identity or security field. WebPilot never types into these.');
  }
  const isTextarea = tag === 'textarea';
  const isInput = tag === 'input' && TEXT_INPUT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase());
  if (!isTextarea && !isInput) {
    return fail('UNSUPPORTED', 'Only text inputs and text areas can be typed into.');
  }
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  if (field.readOnly) return fail('UNSUPPORTED', 'The field is read-only.');

  scrollIntoViewCentered(field);
  showHighlight(field, 'Typing', 2000);
  // focus() fires a focus event only when the window has system focus; synthesize one otherwise.
  let focused = false;
  const onFocus = () => (focused = true);
  field.addEventListener('focus', onFocus, { once: true });
  field.focus();
  field.removeEventListener('focus', onFocus);
  if (!focused) field.dispatchEvent(new (field.ownerDocument.defaultView!.FocusEvent)('focus'));
  const next = clearFirst ? text : field.value + text;
  setNativeValue(field, next);
  fireInput(field, text);
  fireChange(field);
  field.blur();
  if (field.value !== next) {
    return fail('VERIFY_FAILED', 'The field did not accept the full text (it may enforce a length or format limit).');
  }
  return ok(`Entered ${text.length} character${text.length === 1 ? '' : 's'}.`);
}

function doSelect(el: Element, wanted: string): ExecResult {
  if (el.tagName.toLowerCase() !== 'select') {
    return fail('UNSUPPORTED', 'Only native <select> dropdowns are supported.');
  }
  if (isSensitiveField(el)) return fail('SENSITIVE', 'This dropdown looks sensitive; WebPilot will not change it.');
  const select = el as HTMLSelectElement;
  const w = wanted.trim().toLowerCase();
  const opts = Array.from(select.options);
  const match =
    opts.find((o) => o.value === wanted) ??
    opts.find((o) => o.value.toLowerCase() === w) ??
    opts.find((o) => (o.label || o.textContent || '').trim().toLowerCase() === w);
  if (!match) return fail('NOT_FOUND', `No option matching “${truncate(wanted, 40)}” exists in this dropdown.`);
  if (match.disabled) return fail('DISABLED', 'That option is disabled.');
  scrollIntoViewCentered(select);
  showHighlight(select, 'Selecting', 2000);
  setNativeValue(select, match.value);
  fireInput(select, null);
  fireChange(select);
  if (select.value !== match.value) return fail('VERIFY_FAILED', 'The selection did not take effect.');
  return ok(`Selected “${truncate((match.label || match.textContent || match.value).trim(), 60)}”.`);
}

function doSetChecked(el: Element, checked: boolean): ExecResult {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) {
    return fail('UNSUPPORTED', 'Only native checkboxes and radio buttons are supported.');
  }
  if (isSensitiveField(el)) return fail('SENSITIVE', 'This control looks sensitive; WebPilot will not change it.');
  const input = el as HTMLInputElement;
  if (input.checked !== checked) {
    if (type === 'radio' && !checked) {
      return fail('UNSUPPORTED', 'A radio button cannot be unchecked directly; select another option instead.');
    }
    scrollIntoViewCentered(input);
    showHighlight(input, checked ? 'Checking' : 'Unchecking', 2000);
    input.click();
  }
  if (input.checked !== checked) return fail('VERIFY_FAILED', 'The control did not reach the requested state.');
  return ok(`Set to ${checked ? 'checked' : 'unchecked'}.`);
}

function visibleTextOf(el: Element): string {
  const anyEl = el as HTMLElement;
  return (typeof anyEl.innerText === 'string' && anyEl.innerText ? anyEl.innerText : el.textContent) ?? '';
}

function doExtract(el: Element, targetId: string, format: 'text' | 'table' | 'links'): ExecResult {
  if (isSensitiveField(el)) return fail('SENSITIVE', 'WebPilot does not read sensitive fields.');
  const base = { targetId: targetId as ExtractedData['targetId'] };

  if (format === 'text') {
    // Text content only: input values (including passwords) are not part of textContent/innerText.
    const raw = redactText(normalizeWhitespace(visibleTextOf(el)));
    const truncated = raw.length > MAX_EXTRACT_CHARS;
    return ok('Extracted text.', { extracted: { ...base, format, text: truncate(raw, MAX_EXTRACT_CHARS), truncated } });
  }

  if (format === 'table') {
    const table = el.tagName.toLowerCase() === 'table' ? el : (el.querySelector('table') ?? el.closest('table'));
    if (!table) return fail('NOT_FOUND', 'No table was found inside the target element.');
    const rows: string[][] = [];
    let truncated = false;
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      if (rows.length >= MAX_EXTRACT_ROWS) {
        truncated = true;
        break;
      }
      const cells = Array.from(tr.querySelectorAll('th,td'));
      if (cells.length > MAX_EXTRACT_COLS) truncated = true;
      rows.push(
        cells.slice(0, MAX_EXTRACT_COLS).map((c) => truncate(redactText(normalizeWhitespace(visibleTextOf(c))), 200)),
      );
    }
    return ok(`Extracted a table with ${rows.length} row(s).`, { extracted: { ...base, format, rows, truncated } });
  }

  const anchors = el.tagName.toLowerCase() === 'a' ? [el] : Array.from(el.querySelectorAll('a[href]'));
  const links: Array<{ text: string; href: string }> = [];
  let truncated = false;
  for (const a of anchors) {
    if (links.length >= MAX_EXTRACT_LINKS) {
      truncated = true;
      break;
    }
    const href = (a as HTMLAnchorElement).href;
    if (!/^https?:/i.test(href)) continue;
    links.push({
      text: truncate(redactText(normalizeWhitespace(visibleTextOf(a))) || '(no text)', 120),
      href: truncate(redactText(href), 300),
    });
  }
  return ok(`Extracted ${links.length} link(s).`, { extracted: { ...base, format, links, truncated } });
}
