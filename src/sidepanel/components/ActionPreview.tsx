import { useEffect, useRef } from 'react';
import type { Proposal, RunStatus } from '../../shared/schemas';

interface Props {
  proposal: Proposal;
  status: RunStatus;
  pageChanged: boolean;
  onApprove: () => void;
  onReject: () => void;
  onPreview: () => void;
}

export function ActionPreview({ proposal, status, pageChanged, onApprove, onReject, onPreview }: Props) {
  const ref = useRef<HTMLElement>(null);
  const awaiting = status === 'awaiting_confirmation';

  // Move focus to the card when a new action needs a decision (not to a button, to avoid accidental Enter-approval).
  useEffect(() => {
    if (awaiting) ref.current?.focus();
  }, [awaiting, proposal.actionId]);

  return (
    <section
      className="card"
      ref={ref}
      tabIndex={-1}
      role={awaiting ? 'alertdialog' : 'region'}
      aria-labelledby="planned-title"
      aria-describedby="planned-summary"
    >
      <div className="row spread">
        <h2 id="planned-title">Planned action</h2>
        <span className={`badge ${proposal.risk.risk}`} aria-label={`Risk: ${proposal.risk.risk}`}>
          {proposal.risk.risk === 'high' ? 'HIGH RISK' : 'Low risk'}
        </span>
      </div>

      <p id="planned-summary" style={{ margin: '0 0 6px', fontWeight: 600 }}>
        {proposal.summary}
      </p>

      {proposal.targetDescription && (
        <p className="small" style={{ margin: '0 0 6px' }}>
          <span className="muted">Target: </span>
          {proposal.targetDescription} <span className="muted">(highlighted in orange on the page)</span>
        </p>
      )}

      {proposal.literalText !== null && (
        <>
          <div className="small muted">Exact text that will be typed:</div>
          <pre className="mono">{proposal.literalText || '(empty — clears the field)'}</pre>
        </>
      )}

      <p className="small" style={{ margin: '0 0 6px' }}>
        <span className="muted">Why (from the model): </span>
        {proposal.modelReason}
      </p>

      <div className="small">
        <span className="muted">Local risk check: </span>
        <ul style={{ margin: '2px 0 6px 18px', padding: 0 }}>
          {proposal.risk.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      {awaiting && pageChanged && (
        <p className="notice small" role="alert">
          The page changed after this was previewed. If the target changed, the action will be cancelled automatically;
          use “Preview on page” to re-check it.
        </p>
      )}

      {awaiting ? (
        <div className="row">
          <button type="button" onClick={onPreview}>
            Preview on page
          </button>
          <button type="button" className="danger" onClick={onReject}>
            Reject
          </button>
          <button type="button" className="primary" onClick={onApprove}>
            Approve this action
          </button>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {proposal.autoExecute
            ? 'Low-risk action allowed by Assisted mode: running automatically.'
            : 'Running…'}
        </p>
      )}
    </section>
  );
}
