import { ToContentMessageSchema, type ToContentMessage } from '../shared/messages';
import type { ExecResult, MapResponse } from '../shared/schemas';
import { executeAction } from './domActions';
import { clearHighlight, showHighlight } from './highlightOverlay';
import { buildInteractionMap, findTarget } from './interactionMap';
import { createMutationTracker } from './mutationTracking';

type Disposable = { __webpilotDispose?: () => void };

type Reply = ExecResult | MapResponse | { ok: true } | { ok: false; code: string; message: string };

function init(): void {
  const w = window as unknown as Disposable;
  // A re-injected script (or one orphaned by an extension reload) replaces the previous instance.
  try {
    w.__webpilotDispose?.();
  } catch {
    /* previous context is gone */
  }

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
        return { ok: true };
      case 'cs/collect_map': {
        const map = buildInteractionMap(document);
        tracker.markFresh();
        return { ok: true, map };
      }
      case 'cs/highlight': {
        const t = findTarget(msg.targetId, msg.fingerprint, document);
        if (!t.ok) return { ok: false, code: t.code, message: t.message };
        if (typeof t.el.scrollIntoView === 'function') t.el.scrollIntoView({ block: 'center', inline: 'center' });
        showHighlight(t.el, msg.label);
        return { ok: true };
      }
      case 'cs/scroll_to_target': {
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
