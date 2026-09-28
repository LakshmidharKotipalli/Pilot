import { OVERLAY_HOST_ID } from './mutationTracking';

let host: HTMLElement | null = null;
let box: HTMLElement | null = null;
let tag: HTMLElement | null = null;
let current: Element | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;

function ensureHost(doc: Document): void {
  if (host && host.isConnected) return;
  host = doc.createElement('div');
  host.id = OVERLAY_HOST_ID;
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .box{position:fixed;box-sizing:border-box;border:3px solid #ff6a00;border-radius:6px;
      background:rgba(255,106,0,.12);box-shadow:0 0 0 2px rgba(255,255,255,.85),0 0 16px rgba(255,106,0,.7);
      transition:all .12s ease-out;pointer-events:none}
    .tag{position:fixed;max-width:320px;padding:3px 8px;border-radius:4px;background:#1f1f1f;color:#fff;
      font:600 12px/1.3 system-ui,sans-serif;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  `;
  box = doc.createElement('div');
  box.className = 'box';
  tag = doc.createElement('div');
  tag.className = 'tag';
  root.append(style, box, tag);
  (doc.documentElement ?? doc.body).appendChild(host);
}

function position(): void {
  if (!current || !box || !tag) return;
  if (!current.isConnected) {
    clearHighlight();
    return;
  }
  const r = current.getBoundingClientRect();
  box.style.left = `${r.left - 3}px`;
  box.style.top = `${r.top - 3}px`;
  box.style.width = `${r.width + 6}px`;
  box.style.height = `${r.height + 6}px`;
  const above = r.top > 28;
  tag.style.left = `${Math.max(4, r.left)}px`;
  tag.style.top = above ? `${r.top - 28}px` : `${r.bottom + 6}px`;
}

/** Outline `el` with a visible box and label. Auto-clears after `ttlMs`. */
export function showHighlight(el: Element, label: string, ttlMs = 60_000): void {
  const doc = el.ownerDocument;
  ensureHost(doc);
  current = el;
  if (tag) tag.textContent = `WebPilot: ${label}`;
  position();
  if (!listenersAttached && doc.defaultView) {
    doc.defaultView.addEventListener('scroll', position, true);
    doc.defaultView.addEventListener('resize', position, true);
    listenersAttached = true;
  }
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(clearHighlight, ttlMs);
}

export function clearHighlight(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  current = null;
  if (host) {
    const doc = host.ownerDocument;
    if (listenersAttached && doc.defaultView) {
      doc.defaultView.removeEventListener('scroll', position, true);
      doc.defaultView.removeEventListener('resize', position, true);
    }
    listenersAttached = false;
    host.remove();
  }
  host = null;
  box = null;
  tag = null;
}
