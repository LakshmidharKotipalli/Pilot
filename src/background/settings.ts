import { STORAGE_KEYS } from '../shared/constants';
import { SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from '../shared/schemas';
import type { PublicSettings } from '../shared/types';

/**
 * NOTE: chrome.storage.local is NOT a secret vault. It is unencrypted on disk and readable by anyone
 * with access to the browser profile. The API key is stored here (and only here) and is read only by the
 * service worker; UI pages only ever learn `apiKeySet: boolean`.
 */

export function validateApiBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('The API base URL must use https:// (http:// is allowed only for localhost).');
  }
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/+$/, '');
}

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings] as unknown;
  const parsed = SettingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const validated = SettingsPatchSchema.parse(patch);
  if (validated.apiBaseUrl !== undefined) validated.apiBaseUrl = validateApiBaseUrl(validated.apiBaseUrl);
  const current = await getSettings();
  const next = SettingsSchema.parse({ ...current, ...validated });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getApiKey(): Promise<string> {
  const v = (await chrome.storage.local.get(STORAGE_KEYS.apiKey))[STORAGE_KEYS.apiKey];
  return typeof v === 'string' ? v : '';
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.apiKey]: key.trim() });
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
}

export async function getPublicSettings(): Promise<PublicSettings> {
  return { ...(await getSettings()), apiKeySet: (await getApiKey()).length > 0 };
}

export async function isDisclosureAcknowledged(): Promise<boolean> {
  return (await chrome.storage.local.get(STORAGE_KEYS.disclosure))[STORAGE_KEYS.disclosure] === true;
}

export async function acknowledgeDisclosure(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.disclosure]: true });
}

/** Add/remove a host in one of the domain lists. */
export async function updateDomainList(
  list: 'allowedDomains' | 'pausedDomains',
  host: string,
  present: boolean,
): Promise<Settings> {
  const s = await getSettings();
  const h = host.trim().toLowerCase();
  const set = new Set(s[list]);
  if (present) set.add(h);
  else set.delete(h);
  return saveSettings({ [list]: [...set] });
}
