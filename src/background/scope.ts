import type { AgentAction, ElementDescriptor } from '../shared/schemas';

/** Origin of an http(s) URL, or null for anything else (about:, chrome:, data:, unparseable). */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function isInScope(startOrigin: string, url: string | null | undefined): boolean {
  return originOf(url) === startOrigin;
}

/**
 * A session stays on the origin it started on. Returns why `action` would leave it, or null when it
 * stays. Only link clicks can navigate on their own; form submits and script navigation are caught
 * after the fact by comparing the tab's URL.
 */
export function scopeViolation(
  action: AgentAction,
  target: ElementDescriptor | null,
  startOrigin: string,
): string | null {
  if (action.type !== 'click' || !target?.href) return null;
  const dest = originOf(target.href);
  if (dest === null) return `The link goes somewhere that is not a normal web page (${target.href.slice(0, 40)})`;
  if (dest !== startOrigin) return `The link leaves ${startOrigin} (goes to ${dest})`;
  return null;
}
