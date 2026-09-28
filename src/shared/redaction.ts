import { SENSITIVE_FIELD_REGEX } from './constants';

const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SECRET_TOKEN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;

export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Replace card numbers (Luhn-valid), SSNs and API-key/bearer-looking tokens. */
export function redactText(input: string): string {
  return input
    .replace(CARD_CANDIDATE, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[REDACTED_CARD]' : m))
    .replace(SSN, '[REDACTED_SSN]')
    .replace(SECRET_TOKEN, '[REDACTED_SECRET]');
}

export function looksSensitiveText(input: string): boolean {
  return redactText(input) !== input;
}

/** True when a field name / label / autocomplete / placeholder hints at sensitive data. */
export function isSensitiveFieldHint(hint: string): boolean {
  return SENSITIVE_FIELD_REGEX.test(hint);
}

const SECRET_KEYS = /^(?:api[-_]?key|authorization|password|secret|token|bearer|cookie)$/i;

/** Deep-redact a value for logs / diagnostics / dry-run display. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redactForLog(v, depth + 1);
    }
    return out;
  }
  return value;
}
