export const OVERLAY_HOST_ID = '__pilot_overlay_host__';

export interface MutationTracker {
  isStale(): boolean;
  markFresh(): void;
  markStale(): void;
  stop(): void;
}

/**
 * Marks the interaction map stale when the DOM changes materially. Mutations inside Pilot's
 * own overlay are ignored. `onStale` fires once per fresh→stale transition (debounced).
 */
export function createMutationTracker(doc: Document, onStale: () => void, debounceMs = 150): MutationTracker {
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const win = doc.defaultView;

  const flag = () => {
    if (stale) return;
    stale = true;
    onStale();
  };

  const observer = new (win?.MutationObserver ?? MutationObserver)((records) => {
    const relevant = records.some((r) => {
      const t = r.target as Node;
      const el = t.nodeType === 1 ? (t as Element) : t.parentElement;
      return !(el && (el.id === OVERLAY_HOST_ID || el.closest?.(`#${OVERLAY_HOST_ID}`)));
    });
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flag, debounceMs);
  });

  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-expanded', 'aria-disabled', 'open'],
  });

  return {
    isStale: () => stale,
    markFresh: () => {
      stale = false;
    },
    markStale: flag,
    stop: () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    },
  };
}
