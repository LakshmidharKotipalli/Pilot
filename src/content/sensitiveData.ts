import { isSensitiveFieldHint } from '../shared/redaction';

const NON_SENSITIVE_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'image',
  'checkbox',
  'radio',
  'search',
]);

/** Text of the <label> associated with a form control, if any (unredacted; used only for classification). */
export function labelTextFor(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  const id = el.getAttribute('id');
  if (id && doc) {
    for (const l of Array.from(doc.querySelectorAll('label'))) {
      if (l.getAttribute('for') === id) parts.push(l.textContent ?? '');
    }
  }
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent ?? '');
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && doc) {
    for (const ref of labelledBy.split(/\s+/)) {
      const t = doc.getElementById(ref);
      if (t) parts.push(t.textContent ?? '');
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * True for password inputs and anything whose type / autocomplete / name / id / label / placeholder
 * suggests payment, identity, security or MFA data. Such fields are never read, typed into or sent.
 */
export function isSensitiveField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;

  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password') return true;

  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  if (/(?:^|\s)(?:cc-|one-time-code|new-password|current-password|transaction-)/.test(autocomplete)) return true;

  if (NON_SENSITIVE_TYPES.has(type)) return false;

  const hint = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    autocomplete,
    labelTextFor(el),
    type === 'tel' || type === 'number' ? el.getAttribute('inputmode') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return isSensitiveFieldHint(hint);
}
