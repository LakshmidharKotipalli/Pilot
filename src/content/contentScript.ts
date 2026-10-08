import { ToContentMessageSchema, type ToContentMessage } from '../shared/messages';
import type { ExecResult, MapResponse } from '../shared/schemas';
import { executeAction } from './domActions';
import { clearHighlight, showHighlight } from './highlightOverlay';
import { buildInteractionMap, findTarget } from './interactionMap';
import { createMutationTracker } from './mutationTracking';

type Disposable = { __webpilotDispose?: () => void };

type Reply = ExecResult | MapResponse | { ok: true; docId?: string } | { ok: false; code: string; message: string };

function init(): void {
  const w = window as unknown as Disposable;
  // A re-injected script (or one orphaned by an extension reload) replaces the previous instance.
  try {
    w.__webpilotDispose?.();
  } catch {
    /* previous context is gone */
  }

  // Identifies this document load. Every action from the worker names the docId it was planned against,
  // so an action for a page that has since been replaced (navigation, reload) is refused, not replayed.
  // (randomUUID is secure-context only, and this runs on plain http pages too.)
  const docId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const stale = (id: string): Reply | null =>
    id === docId
      ? null
      : { ok: false, code: 'STALE_DOCUMENT', message: 'The page was replaced after this action was planned, so it was cancelled.' };

  const tracker = createMutationTracker(document, () => {
    try {
      void chrome.runtime.sendMessage({ type: 'content/stale' }).catch(() => undefined);
    } catch {
      /* extension context invalidated */
    }
  });

  async function handle(msg: ToContentMessage): Promise<Reply> {
    switch (msg.type) {
      case 'cs/ping':
        return { ok: true, docId };
      case 'cs/collect_map': {
        const map = buildInteractionMap(document);
        tracker.markFresh();
        return { ok: true, map, docId };
      }
      case 'cs/highlight': {
        const gone = stale(msg.docId);
        if (gone) return gone;
        const t = findTarget(msg.targetId, msg.fingerprint, document);
        if (!t.ok) return { ok: false, code: t.code, message: t.message };
        if (typeof t.el.scrollIntoView === 'function') t.el.scrollIntoView({ block: 'center', inline: 'center' });
        showHighlight(t.el, msg.label);
        return { ok: true };
      }
      case 'cs/scroll_to_target': {
        const gone = stale(msg.docId);
        if (gone) return gone;
        const t = findTarget(msg.targetId, msg.fingerprint, document);
        if (!t.ok) return { ok: false, code: t.code, message: t.message };
        if (typeof t.el.scrollIntoView === 'function') t.el.scrollIntoView({ block: 'center', inline: 'center' });
        tracker.markStale();
        return { ok: true };
      }
      case 'cs/clear_highlight':
        clearHighlight();
        return { ok: true };
      case 'cs/execute': {
        const gone = stale(msg.docId);
        if (gone) return gone;
        const result = await executeAction(msg.action, msg.fingerprint, document);
        tracker.markStale(); // the page state has (probably) changed; the worker re-collects
        return result;
      }
    }
  }

  const listener = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: Reply) => void,
  ): boolean => {
    // Only accept messages from this extension's own service worker.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const parsed = ToContentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendResponse({ ok: false, code: 'BAD_MESSAGE', message: 'Rejected malformed message.' });
      return false;
    }
    handle(parsed.data).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, code: 'ERROR', message: e instanceof Error ? e.message : 'Unexpected error.' }),
    );
    return true; // async response
  };

  chrome.runtime.onMessage.addListener(listener);

  w.__webpilotDispose = () => {
    chrome.runtime.onMessage.removeListener(listener);
    tracker.stop();
    clearHighlight();
  };
}

init();
