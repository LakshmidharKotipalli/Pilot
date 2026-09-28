import { CONTEXT_KEYWORDS, HIGH_RISK_KEYWORDS } from './constants';
import { isSensitiveFieldHint, looksSensitiveText, truncate } from './redaction';
import { parseUrl } from './domainPolicy';
import type { AgentAction, ElementDescriptor, Mode, RiskAssessment } from './schemas';

export interface RiskInput {
  action: AgentAction;
  target?: ElementDescriptor | null;
  pageUrl: string;
  mode: Mode;
  /** What the user actually typed (never model output). Used in autonomous mode to honour explicit requests. */
  userGoal?: string;
}

export function keywordHints(text: string): string[] {
  const out: string[] = [];
  for (const { category, pattern } of HIGH_RISK_KEYWORDS) {
    if (pattern.test(text)) out.push(category);
  }
  return out;
}

export function contextHints(text: string): string[] {
  const out: string[] = [];
  for (const { category, pattern } of CONTEXT_KEYWORDS) {
    if (pattern.test(text)) out.push(category);
  }
  return out;
}

export function isMutating(action: AgentAction): boolean {
  return (
    action.type === 'click' ||
    action.type === 'type_text' ||
    action.type === 'select_option' ||
    action.type === 'set_checked'
  );
}

/** Plain-English description of a target, safe to show and log. */
export function describeTarget(t?: ElementDescriptor | null): string {
  if (!t) return 'unknown element';
  if (t.extractOnly) return `Content region “${truncate(t.name || t.safePathHint, 80)}”`;
  const kind =
    t.tag === 'a' || t.role === 'link'
      ? 'Link'
      : t.tag === 'select'
        ? 'Dropdown'
        : t.tag === 'textarea'
          ? 'Text area'
          : t.tag === 'input'
            ? t.inputType === 'checkbox'
              ? 'Checkbox'
              : t.inputType === 'radio'
                ? 'Radio button'
                : t.inputType === 'submit' || t.inputType === 'button' || t.inputType === 'image'
                  ? 'Button'
                  : t.inputType === 'password'
                    ? 'Password field'
                    : 'Text field'
            : t.role === 'tab'
              ? 'Tab'
              : 'Button';
  const name = t.name || t.visibleText || t.placeholder || t.safePathHint;
  const extras: string[] = [];
  if (t.inForm) extras.push('inside a form');
  if (t.sensitive) extras.push('sensitive field');
  if (t.href) extras.push(`→ ${truncate(t.href, 80)}`);
  return `${kind} “${truncate(name, 80)}”${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * True when the user's own prompt names the control being operated (e.g. prompt "click Add to cart" and
 * the target is the “Add to cart” button). This is the only way a serious action can skip approval.
 */
export function isExplicitlyRequested(target: ElementDescriptor | null | undefined, userGoal: string | undefined): boolean {
  if (!target || !userGoal) return false;
  const goal = ` ${normalizePhrase(userGoal)} `;
  for (const label of [target.name, target.visibleText]) {
    const phrase = normalizePhrase(label ?? '');
    if (phrase.length >= 3 && goal.includes(` ${phrase} `)) return true;
  }
  return false;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', '']);

/** Assisted-mode allowlist: low-risk, reversible interactions the extension may auto-run. */
export function isAutoEligible(action: AgentAction, target: ElementDescriptor | null | undefined, pageUrl: string): boolean {
  switch (action.type) {
    case 'scroll':
    case 'observe':
    case 'complete':
    case 'ask_user':
      return true;
    case 'extract':
      return !!target && !target.sensitive;
    case 'click': {
      if (!target || target.sensitive || target.disabled) return false;
      if (target.isSubmit) return false;
      if (target.role === 'tab' || target.tag === 'summary') return true; // switch tab / expand
      if (target.expanded !== null) return true; // accordion toggle
      if (target.tag === 'textarea') return true; // focus a field
      if (target.tag === 'input' && TEXT_INPUT_TYPES.has((target.inputType ?? '').toLowerCase())) return true;
      if (target.tag === 'a' && target.href) return isSamePageHash(target.href, pageUrl);
      return false;
    }
    default:
      return false; // type_text, select_option, set_checked are never auto-run
  }
}

function isSamePageHash(href: string, pageUrl: string): boolean {
  const h = parseUrl(href);
  const p = parseUrl(pageUrl);
  if (!h || !p) return false;
  return h.origin === p.origin && h.pathname === p.pathname && h.search === p.search && h.hash !== '';
}

/**
 * Local, model-independent risk classification. Uncertain → high.
 * In safe mode every mutating action needs approval; in assisted mode only actions outside the
 * low-risk allowlist (or classified high) do. In autonomous mode every low-risk action runs on its own;
 * high-risk ones need approval unless the user's prompt explicitly names the control ("soft" reasons only).
 * "Hard" reasons (sensitive fields, uploads, unknown targets, odd schemes) always need approval.
 */
export function assessRisk({ action, target, pageUrl, mode, userGoal }: RiskInput): RiskAssessment {
  const finish = (hard: string[], soft: string[], low: string[]): RiskAssessment => {
    const high = [...hard, ...soft];
    const risk = high.length > 0 ? 'high' : 'low';
    let requiresConfirmation: boolean;
    let reasons = risk === 'high' ? high : low.length ? low : ['No sensitive indicators found'];
    if (mode === 'safe') {
      requiresConfirmation = risk === 'high' || isMutating(action);
    } else if (mode === 'autonomous') {
      requiresConfirmation = hard.length > 0 || (soft.length > 0 && !isExplicitlyRequested(target, userGoal));
      if (risk === 'high' && !requiresConfirmation) reasons = [...high, 'Explicitly requested in your prompt'];
    } else {
      requiresConfirmation = risk === 'high' || !isAutoEligible(action, target, pageUrl);
    }
    return { risk, reasons, requiresConfirmation };
  };

  switch (action.type) {
    case 'observe':
    case 'complete':
    case 'ask_user':
      return { risk: 'low', reasons: ['No page interaction'], requiresConfirmation: false };
    case 'scroll':
      return { risk: 'low', reasons: ['Scrolling is reversible and changes no page data'], requiresConfirmation: false };
    default:
      break;
  }

  if (!target) {
    return finish(['Target is not in the current page map (uncertain)'], [], []);
  }

  const hard: string[] = [];
  const soft: string[] = [];
  const low: string[] = [];

  const labelText = [target.name, target.visibleText, target.label, target.placeholder].filter(Boolean).join(' ');
  const fieldHint = [labelText, target.autocomplete, target.inputType, target.safePathHint].filter(Boolean).join(' ');

  if (target.extractOnly && action.type !== 'extract') {
    hard.push('Target is a read-only content region, not a control (uncertain)');
  }
  if (target.sensitive) hard.push('Target is a password / payment / identity / security field');
  if (target.inputType === 'file') hard.push('File upload control');
  if (target.disabled) low.push('Target is disabled');

  if (action.type === 'extract') {
    return finish(hard, soft, ['Reads visible, sanitized content only']);
  }

  if (action.type === 'type_text') {
    if (isSensitiveFieldHint(fieldHint)) hard.push('Typing into a payment / identity / security / MFA-like field');
    if (looksSensitiveText(action.text)) hard.push('Text to type looks like a card number, SSN or secret');
    if (action.text.length > 0) low.push('Enters text into a form field');
  } else {
    // click / select_option / set_checked: judge by label + destination
    const hints = new Set<string>([...keywordHints(labelText), ...target.riskHints]);
    for (const h of hints) soft.push(`Label suggests a “${h}” action`);
    if (isSensitiveFieldHint(fieldHint) && action.type !== 'click') {
      hard.push('Changes a payment / identity / security-related control');
    }
  }

  if (action.type === 'click') {
    if (target.isSubmit) soft.push('Submits a form');
    else if (target.inForm && target.tag === 'button') soft.push('Button inside a form (may submit it)');

    if (target.href) {
      const dest = parseUrl(target.href);
      const page = parseUrl(pageUrl);
      if (!dest) {
        hard.push('Link destination could not be parsed');
      } else if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
        hard.push(`Link uses the “${dest.protocol}” scheme`);
      } else if (page && dest.origin !== page.origin) {
        soft.push(`Navigates to a new origin (${dest.origin})`);
      } else if (page && (dest.pathname !== page.pathname || dest.search !== page.search)) {
        low.push('Navigates to another page on the same site');
      } else {
        low.push('Same-page navigation');
      }
      const destKeywords = keywordHints(decodeURIComponentSafe(dest?.pathname ?? ''));
      for (const h of destKeywords) soft.push(`Link destination suggests a “${h}” action`);
    }

    const ctx = contextHints(target.nearbyText).filter((c) => c === 'commerce' || c === 'auth' || c === 'account');
    if (ctx.length && (target.inForm || target.tag === 'button' || target.role === 'button')) {
      soft.push(`Sits in a ${ctx.join('/')} context (“${truncate(target.nearbyText, 60)}”)`);
    }
  }

  return finish(dedupe(hard), dedupe(soft), dedupe(low));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s).replace(/[-_/]+/g, ' ');
  } catch {
    return s;
  }
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}
