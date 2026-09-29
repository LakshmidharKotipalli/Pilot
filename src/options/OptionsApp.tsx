import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_BLOCKED_DOMAIN_PATTERNS, DEFAULT_API_BASE_URL } from '../shared/constants';
import { sendToBackground } from '../shared/messages';
import { SettingsSchema } from '../shared/schemas';
import type { PublicSettings } from '../shared/types';

function hostPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export default function OptionsApp() {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [blockedText, setBlockedText] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'notice'; text: string } | null>(null);

  const load = async () => {
    const r = await sendToBackground<PublicSettings>({ type: 'ui/get_settings' });
    if (!r.ok) return setMsg({ kind: 'error', text: r.error });
    setS(r.data);
    setBlockedText(r.data.blockedDomainPatterns.join('\n'));
  };

  useEffect(() => {
    void load();
  }, []);

  if (!s) return <div className="options">Loading…{msg ? ` ${msg.text}` : ''}</div>;

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
    })();
  };

  return (
    <form className="options" onSubmit={save}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>WebPilot Agent – Settings</h1>

      <div className="notice" role="note" style={{ marginBottom: 14 }}>
        <strong>Storage warning:</strong> your API key is stored in <code>chrome.storage.local</code>. Extension storage is
        unencrypted on disk and is <em>not</em> a server-side secret vault; anyone with access to this browser profile could
        read it. Use a key with a low spend limit that you can revoke.
      </div>

      <section className="card" aria-labelledby="llm">
        <h2 id="llm">LLM provider (OpenAI-compatible)</h2>
        <label htmlFor="base">API base URL</label>
        <input id="base" type="url" value={s.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} placeholder={DEFAULT_API_BASE_URL} required />
        <div className="muted small">Requests go to <code>{'{base}'}/chat/completions</code>. https is required (http only for localhost).</div>

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
            <button
              type="button"
              className="link"
              onClick={() => void sendToBackground({ type: 'ui/clear_api_key' }).then(() => load())}
            >
              Remove key
            </button>
          )}
        </div>

        <label htmlFor="model">Model ID</label>
        <input id="model" type="text" value={s.modelId} onChange={(e) => set('modelId', e.target.value)} placeholder="Model ID from your provider" />
      </section>

      <section className="card" aria-labelledby="mode">
        <h2 id="mode">Mode</h2>
        <label htmlFor="mode-select">How much should WebPilot do on its own?</label>
        <select id="mode-select" value={s.mode} onChange={(e) => set('mode', e.target.value as PublicSettings['mode'])}>
          <option value="autonomous">Autonomous (default): asks only before serious actions</option>
          <option value="assisted">Assisted: auto-runs only scrolling, expanding, tabs and reading</option>
          <option value="safe">Safe: approve every click, text entry and selection</option>
        </select>
        {s.mode === 'autonomous' && (
          <div className="notice small" role="alert">
            <strong>Autonomous mode is on.</strong> Routine, low-risk steps (navigating the same site, searching, filling
            ordinary fields, choosing options) run without asking. Anything that could change data or involve payment
            (submitting, purchasing, sending, deleting, booking, account changes, new-origin navigation) waits for your
            approval unless your prompt explicitly names that control, for example “click Add to cart”. Password, payment,
            identity and MFA fields, file uploads, and uncertain targets always require approval.
          </div>
        )}
        {s.mode === 'assisted' && (
          <div className="notice small" role="alert">
            <strong>Assisted mode is on.</strong> Only low-risk, reversible actions (scrolling, expanding sections, switching
            tabs, focusing fields, reading visible text, same-page links) run without asking. Everything else needs your
            confirmation. Uncertain actions are treated as high risk.
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="sites">
        <h2 id="sites">Allowed sites</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          WebPilot does nothing on a site until you allow it. Exact host names (e.g. <code>example.com</code>); use{' '}
          <code>*.example.com</code> for subdomains.
        </p>
        <ul className="plain">
          {s.allowedDomains.length === 0 && <li className="muted">No sites allowed yet.</li>}
          {s.allowedDomains.map((d) => (
            <li key={d} className="row spread">
              <span>
                {d} {s.pausedDomains.includes(d) && <span className="badge">paused</span>}
              </span>
              <button type="button" onClick={() => void sendToBackground({ type: 'ui/remove_site', host: d }).then(() => load())}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 8 }}>
          <input type="text" aria-label="Add allowed host" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="example.com" style={{ flex: 1 }} />
          <button type="button" onClick={addDomain}>
            Allow
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="blocked">
        <h2 id="blocked">Blocked domain rules</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          One host glob per line (<code>*</code> = wildcard). Matching sites are never read or sent, even if allowed. The
          defaults cover banking, payments, healthcare, identity verification and password managers. Sign-in / MFA URL
          paths are always blocked.
        </p>
        <textarea aria-label="Blocked domain patterns" rows={10} value={blockedText} onChange={(e) => setBlockedText(e.target.value)} className="mono" />
        <button type="button" onClick={() => setBlockedText(DEFAULT_BLOCKED_DOMAIN_PATTERNS.join('\n'))} style={{ marginTop: 6 }}>
          Reset to secure defaults
        </button>
      </section>

      <section className="card" aria-labelledby="diag">
        <h2 id="diag">Diagnostics</h2>
        <label className="inline">
          <input type="checkbox" checked={s.dryRun} onChange={(e) => set('dryRun', e.target.checked)} />
          Dry run: build and show the request (secrets removed) but never send it or execute anything
        </label>
        <label className="inline">
          <input type="checkbox" checked={s.debug} onChange={(e) => set('debug', e.target.checked)} />
          Debug logging (sanitized events only)
        </label>
      </section>

      {msg && (
        <p className={msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
      <button type="submit" className="primary">
        Save settings
      </button>
    </form>
  );
}
