import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKED_DOMAIN_PATTERNS } from '../src/shared/constants';
import { evaluateSite, isUnsupportedUrl, matchesHostPattern } from '../src/shared/domainPolicy';
import { luhn, redactForLog, redactText } from '../src/shared/redaction';

const base = { allowedDomains: ['example.com', '*.docs.example.org'], pausedDomains: [] as string[], blockedDomainPatterns: [...DEFAULT_BLOCKED_DOMAIN_PATTERNS] };

describe('evaluateSite', () => {
  it('blocks unsupported pages with a friendly message', () => {
    for (const url of ['chrome://extensions', 'chrome-extension://abc/x.html', 'about:blank', 'file:///etc/hosts', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x']) {
      const v = evaluateSite(url, base);
      expect(v.allowed).toBe(false);
      expect(v.code).toBe('unsupported');
    }
    expect(isUnsupportedUrl('https://example.com/')).toBe(false);
  });

  it('runs only on explicitly allowed domains', () => {
    expect(evaluateSite('https://example.com/a', base)).toMatchObject({ allowed: true, code: 'ok' });
    expect(evaluateSite('https://other.com/', base)).toMatchObject({ allowed: false, code: 'not_allowlisted' });
    expect(evaluateSite('https://a.docs.example.org/', base).allowed).toBe(true);
    expect(evaluateSite('https://www.example.com/', base).allowed).toBe(false); // exact host by default
  });

  it('honours pause', () => {
    expect(evaluateSite('https://example.com/', { ...base, pausedDomains: ['example.com'] })).toMatchObject({ allowed: false, code: 'paused', paused: true });
  });

  it('blocks banking / healthcare / identity / password-manager sites by default, even if allowlisted', () => {
    const s = { ...base, allowedDomains: ['*'] };
    for (const url of ['https://www.chase.com/', 'https://onlinebanking.example.com/', 'https://mychart.hospital.org/', 'https://id.me/', 'https://vault.bitwarden.com/', 'https://accounts.google.com/']) {
      const v = evaluateSite(url, s);
      expect(v.code, url).toBe('blocked');
      expect(v.message).toMatch(/blocked/i);
    }
  });

  it('blocks sign-in / MFA paths and incognito', () => {
    expect(evaluateSite('https://example.com/login', base).code).toBe('blocked');
    expect(evaluateSite('https://example.com/account/mfa/verify', base).code).toBe('blocked');
    expect(evaluateSite('https://example.com/', base, true).code).toBe('blocked');
  });

  it('domain rules are configurable', () => {
    expect(evaluateSite('https://www.chase.com/', { ...base, allowedDomains: ['www.chase.com'], blockedDomainPatterns: [] }).allowed).toBe(true);
  });

  it('handles a missing URL (no activeTab yet)', () => {
    expect(evaluateSite(undefined, base).code).toBe('unknown');
  });
});

describe('matchesHostPattern', () => {
  it('supports wildcards', () => {
    expect(matchesHostPattern('a.b.example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('notexample.com', '*.example.com')).toBe(false);
    expect(matchesHostPattern('my-bank.io', '*bank*')).toBe(true);
  });
});

describe('redaction', () => {
  it('validates card numbers with Luhn and redacts them', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
    expect(redactText('pay 4242-4242-4242-4242 now')).toBe('pay [REDACTED_CARD] now');
    expect(redactText('order 1234567890123')).toBe('order 1234567890123'); // not Luhn-valid
    expect(redactText('ssn 123-45-6789')).toBe('ssn [REDACTED_SSN]');
    expect(redactText('key sk-abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED_SECRET]');
  });

  it('redacts secret-named keys in logs', () => {
    const out = redactForLog({ apiKey: 'sk-live-xyz', nested: { Authorization: 'Bearer abc', note: 'card 4242424242424242' } }) as Record<string, any>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.nested.Authorization).toBe('[REDACTED]');
    expect(out.nested.note).toContain('[REDACTED_CARD]');
  });
});
