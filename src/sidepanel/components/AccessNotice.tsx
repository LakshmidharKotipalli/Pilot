import { useState } from 'react';
import type { Blocker } from '../lib/blocker';

interface Props {
  blocker: Blocker;
  onAction: () => void;
}

/** The one place a "can't run" reason is shown, with a single action and optional expandable detail. */
export function AccessNotice({ blocker, onAction }: Props) {
  const [open, setOpen] = useState(false);
  // For the "instructions" action, the button reveals the details rather than changing anything.
  const revealOnly = blocker.action === 'instructions';
  const detailsShown = open;

  return (
    <div className="access-notice" role="status">
      <div className="access-row">
        <span className="access-msg">{blocker.message}</span>
        {blocker.action && (
          <button
            type="button"
            className="primary small-btn"
            aria-expanded={revealOnly ? detailsShown : undefined}
            onClick={revealOnly ? () => setOpen((v) => !v) : onAction}
          >
            {blocker.actionLabel}
          </button>
        )}
      </div>
      {blocker.details && (
        <>
          {!revealOnly && (
            <button type="button" className="link small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
          {open && <p className="access-details small muted">{blocker.details}</p>}
        </>
      )}
    </div>
  );
}
