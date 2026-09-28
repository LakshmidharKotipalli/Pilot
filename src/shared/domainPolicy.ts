import { DEFAULT_BLOCKED_PATH_REGEX, UNSUPPORTED_HOSTS, UNSUPPORTED_PROTOCOLS } from './constants';
import type { SiteVerdict } from './schemas';

export interface DomainSettings {
  allowedDomains: string[];
  pausedDomains: string[];
  blockedDomainPatterns: string[];
}

export function parseUrl(url: string | undefined | null): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function hostFromUrl(url: string | undefined | null): string | null {
  const u = parseUrl(url);
  return u && u.hostname ? u.hostname.toLowerCase() : null;
}

/** Glob match on hostnames: `*` is a wildcard, everything else literal. `*.x.com` also matches `x.com`. */
export function matchesHostPattern(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (new RegExp(`^${esc}$`).test(host)) return true;
  if (p.startsWith('*.')) return host === p.slice(2);
  return false;
}

export function isUnsupportedUrl(url: string | undefined | null): boolean {
  const u = parseUrl(url);
  if (!u) return true;
  if (UNSUPPORTED_PROTOCOLS.includes(u.protocol)) return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase();
  if (UNSUPPORTED_HOSTS.includes(host) && (host !== 'chrome.google.com' || u.pathname.startsWith('/webstore'))) {
    return true;
  }
  return false;
}

/**
 * Decide whether the agent may read/act on this page. Order matters:
 * unsupported → incognito → blocked (secure defaults, user-configurable) → not allowlisted → paused.
 */
export function evaluateSite(
  url: string | undefined | null,
  settings: DomainSettings,
  incognito = false,
): SiteVerdict {
  const host = hostFromUrl(url);
  if (url && parseUrl(url) && isUnsupportedUrl(url)) {
    return {
      host,
      code: 'unsupported',
      allowed: false,
      paused: false,
      message:
        'This page cannot be controlled by extensions (browser-internal, file, or Web Store page). Open a regular website tab.',
    };
  }
  if (!url || !host) {
    return {
      host: null,
      code: 'unknown',
      allowed: false,
      paused: false,
      message:
        'WebPilot cannot see this tab’s address yet. Click the WebPilot toolbar icon on the tab you want to use, or add the site by host name under Settings → Allowed sites. (Browser-internal pages are never available.)',
    };
  }
  if (incognito) {
    return {
      host,
      code: 'blocked',
      allowed: false,
      paused: false,
      message: 'WebPilot does not run in private (incognito) windows.',
    };
  }
  const blockedHit = settings.blockedDomainPatterns.find((p) => matchesHostPattern(host, p));
  if (blockedHit) {
    return {
      host,
      code: 'blocked',
      allowed: false,
      paused: false,
      message: `“${host}” matches the blocked-domain rule “${blockedHit}” (banking, healthcare, identity, or password-manager sites are blocked by default). No page content was collected or sent. You can edit these rules in Settings.`,
    };
  }
  const u = parseUrl(url)!;
  if (DEFAULT_BLOCKED_PATH_REGEX.test(u.pathname)) {
    return {
      host,
      code: 'blocked',
      allowed: false,
      paused: false,
      message:
        'This looks like a sign-in, identity, or MFA page. WebPilot does not read these pages. No page content was collected or sent.',
    };
  }
  const allowed = settings.allowedDomains.some((d) => matchesHostPattern(host, d));
  if (!allowed) {
    return {
      host,
      code: 'not_allowlisted',
      allowed: false,
      paused: false,
      message: `WebPilot is not enabled for “${host}”. Use “Allow this site” to enable it.`,
    };
  }
  if (settings.pausedDomains.some((d) => matchesHostPattern(host, d))) {
    return {
      host,
      code: 'paused',
      allowed: false,
      paused: true,
      message: `WebPilot is paused on “${host}”. Resume it to continue.`,
    };
  }
  return { host, code: 'ok', allowed: true, paused: false, message: 'Allowed' };
}
