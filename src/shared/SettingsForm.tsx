import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_BLOCKED_DOMAIN_PATTERNS, DEFAULT_API_BASE_URL } from './constants';
import { sendToBackground } from './messages';
import { SettingsSchema } from './schemas';
import type { PublicSettings } from './types';

function hostPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

interface Props {
  /** Shown at the top of "Site permissions" (the side panel puts the current-site actions here). */
  siteExtra?: ReactNode;
  /** An "Appearance" section, rendered only when given. */
  appearance?: ReactNode;
  /** Extra content in "Activity & diagnostics" (raw log, diagnostic export, capability notes). */
  activity?: ReactNode;
  /** Bump to re-read settings after something outside the form changed them. */
  reloadToken?: number;
  /** Called after allowed sites change so the host can refresh its own state. */
  onSitesChanged?: () => void;
  onSaved?: () => void;
}

/** The full settings form, shared by the options page and the side-panel Settings view. */
export function SettingsForm({ siteExtra, appearance, activity, reloadToken = 0, onSitesChanged, onSaved }: Props) {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [blockedText, setBlockedText] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'notice'; text: string } | null>(null);

  const load = async () => {
    const r = await sendToBackground<PublicSettings>({ type: 'ui/get_settings' });
    if (!r.ok) return setMsg({ kind: 'error', text: r.error });
    // Keep unsaved edits to the textarea if only the site list changed.
    setS(r.data);
    setBlockedText((prev) => (prev === '' ? r.data.blockedDomainPatterns.join('\n') : prev));
  };

  useEffect(() => {
    void load();
  }, [reloadToken]);

  if (!s) return <div>Loading…{msg ? ` ${msg.text}` : ''}</div>;

  const set = <K extends keyof PublicSettings>(k: K, v: PublicSettings[K]) => setS({ ...s, [k]: v });

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    // Request access to the LLM host synchronously (needs the click gesture) so service-worker fetches
    // are not blocked by CORS.
    const pattern = hostPattern(s.apiBaseUrl);
    const perm = pattern ? chrome.permissions.request({ origins: [pattern] }).catch(() => false) : Promise.resolve(false);

    void (async () => {
      const granted = await perm;
      const blocked = blockedText
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean);
      const candidate = {
        apiBaseUrl: s.apiBaseUrl,
        modelId: s.modelId,
        mode: s.mode,
        dryRun: s.dryRun,
        debug: s.debug,
        blockedDomainPatterns: blocked,
      };
      const check = SettingsSchema.partial().safeParse(candidate);
      if (!check.success) {
        return setMsg({ kind: 'error', text: check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      const r = await sendToBackground<PublicSettings>({
        type: 'ui/save_settings',
        settings: check.data,
        apiKey: apiKey.trim() || undefined,
      });
      if (!r.ok) return setMsg({ kind: 'error', text: r.error });
      setApiKey('');
      setS(r.data);
      setBlockedText(r.data.blockedDomainPatterns.join('\n'));
      setMsg({
        kind: granted ? 'ok' : 'notice',
        text: granted
          ? 'Saved.'
          : 'Saved, but access to the API host was not granted. Requests may be blocked by the browser (CORS) until you grant it by saving again.',
      });
      onSaved?.();
    })();
  };

  const addDomain = () => {
    const host = newDomain.trim();
    if (!host) return;
    const perm = chrome.permissions
      .request({ origins: [`*://${host.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')}/*`] })
      .catch(() => false);
    void (async () => {
      await perm;
      const r = await sendToBackground({ type: 'ui/allow_site', host });
      if (!r.ok) return setMsg({ kind: 'error', text: r.error });
      setNewDomain('');
      void load();
      onSitesChanged?.();
    })();
  };

  return (
    <form className="settings-form" onSubmit={save}>
      <section className="group" aria-labelledby="g-model">
        <h2 id="g-model">Model &amp; connection</h2>
        <label htmlFor="base">API base URL</label>
        <input id="base" type="url" value={s.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} placeholder={DEFAULT_API_BASE_URL} required />
        <div className="muted small">Any OpenAI-compatible provider. Requests go to <code>{'{base}'}/chat/completions</code>. https is required (http only for localhost).</div>

        <label htmlFor="key">API key</label>
        <input
          id="key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={s.apiKeySet ? '•••••••• saved (enter a new value to replace)' : 'Paste your key'}
        />
        <div className="row small" style={{ marginTop: 4 }}>
          <span className="muted">{s.apiKeySet ? 'A key is saved. It is never shown again.' : 'No key saved.'}</span>
          {s.apiKeySet && (
            <button type="button" className="link" onClick={() => void sendToBackground({ type: 'ui/clear_api_key' }).then(() => load())}>
              Remove key
            </button>
          )}
        </div>

        <label htmlFor="model">Model ID</label>
        <input id="model" type="text" value={s.modelId} onChange={(e) => set('modelId', e.target.value)} placeholder="Model ID from your provider" />

        <details className="more">
          <summary>About key storage</summary>
          <p className="muted small">
            Your API key is stored in <code>chrome.storage.local</code>. Extension storage is unencrypted on disk and is{' '}
            <em>not</em> a server-side secret vault; anyone with access to this browser profile could read it. Use a key with
            a low spend limit that you can revoke.
          </p>
        </details>
      </section>

      <section className="group" aria-labelledby="g-agent">
        <h2 id="g-agent">Agent behavior</h2>
        <label htmlFor="mode-select">How much should Pilot do on its own?</label>
        <select id="mode-select" value={s.mode} onChange={(e) => set('mode', e.target.value as PublicSettings['mode'])}>
          <option value="autonomous">Autonomous (default): asks only before serious actions</option>
          <option value="assisted">Assisted: auto-runs only scrolling, expanding, tabs and reading</option>
          <option value="safe">Safe: approve every click, text entry and selection</option>
        </select>
        {s.mode === 'autonomous' && (
          <div className="notice small" role="note">
            <strong>Autonomous mode is on.</strong> Routine, low-risk steps (navigating the same site, searching, filling
            ordinary fields, choosing options) run without asking. Anything that could change data or involve payment
            (submitting, purchasing, sending, deleting, booking, account changes, new-origin navigation) waits for your
            approval unless your prompt explicitly names that control, for example “click Add to cart”. Password, payment,
            identity and MFA fields, file uploads, and uncertain targets always require approval.
          </div>
        )}
        {s.mode === 'assisted' && (
          <div className="notice small" role="note">
            <strong>Assisted mode is on.</strong> Only low-risk, reversible actions (scrolling, expanding sections, switching
            tabs, focusing fields, reading visible text, same-page links) run without asking. Everything else needs your
            confirmation. Uncertain actions are treated as high risk.
          </div>
        )}
        <label className="inline">
          <input type="checkbox" checked={s.dryRun} onChange={(e) => set('dryRun', e.target.checked)} />
          Dry run: build and show the request (secrets removed) but never send it or execute anything
        </label>
      </section>

      <section className="group" aria-labelledby="g-sites">
        <h2 id="g-sites">Site permissions</h2>
        {siteExtra}
        <p className="muted small" style={{ marginTop: 0 }}>
          Pilot does nothing on a site until you allow it. Exact host names (e.g. <code>example.com</code>); use{' '}
          <code>*.example.com</code> for subdomains.
        </p>
        <ul className="plain">
          {s.allowedDomains.length === 0 && <li className="muted">No sites allowed yet.</li>}
          {s.allowedDomains.map((d) => (
            <li key={d} className="row spread">
              <span className="wrap">
                {d} {s.pausedDomains.includes(d) && <span className="badge">paused</span>}
              </span>
              <button
                type="button"
                onClick={() =>
                  void sendToBackground({ type: 'ui/remove_site', host: d }).then(() => {
                    void load();
                    onSitesChanged?.();
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="row nowrap" style={{ marginTop: 8 }}>
          <input type="text" aria-label="Add allowed host" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.com" style={{ flex: 1, minWidth: 0 }} />
          <button type="button" onClick={addDomain}>
            Allow
          </button>
        </div>

        <details className="more">
          <summary>Blocked domain rules</summary>
          <p className="muted small">
            One host glob per line (<code>*</code> = wildcard). Matching sites are never read or sent, even if allowed. The
            defaults cover banking, payments, healthcare, identity verification and password managers. Sign-in / MFA URL
            paths are always blocked.
          </p>
          <textarea aria-label="Blocked domain patterns" rows={8} value={blockedText} onChange={(e) => setBlockedText(e.target.value)} className="mono" />
          <button type="button" onClick={() => setBlockedText(DEFAULT_BLOCKED_DOMAIN_PATTERNS.join('\n'))} style={{ marginTop: 6 }}>
            Reset to secure defaults
          </button>
        </details>
      </section>

      {appearance && (
        <section className="group" aria-labelledby="g-appearance">
          <h2 id="g-appearance">Appearance</h2>
          {appearance}
        </section>
      )}

      <section className="group" aria-labelledby="g-activity">
        <h2 id="g-activity">Activity &amp; diagnostics</h2>
        <label className="inline">
          <input type="checkbox" checked={s.debug} onChange={(e) => set('debug', e.target.checked)} />
          Debug logging (sanitized events only)
        </label>
        {activity}
      </section>

      <div className="save-bar">
        {msg && (
          <p className={`${msg.kind} small`} role={msg.kind === 'error' ? 'alert' : 'status'} style={{ margin: '0 0 8px' }}>
            {msg.text}
          </p>
        )}
        <button type="submit" className="primary block">
          Save settings
        </button>
      </div>
    </form>
  );
}
