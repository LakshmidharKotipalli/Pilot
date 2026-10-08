import { useCallback, useEffect, useState } from 'react';
import { BgToUiMessageSchema, sendToBackground } from '../shared/messages';
import { DecisionViewSchema, type DecisionView } from '../shared/schemas';
import { ActionPreview } from '../sidepanel/components/ActionPreview';
import { LoopCard, QuestionCard } from '../sidepanel/components/DecisionCards';

const KIND_LABEL = { approval: 'Approval', loop: 'Loop check', question: 'Question' } as const;

/**
 * The popup that opens when a session needs the user and no side panel is showing it. One window for
 * every session: the queue is listed, and the selected decision is shown with the same preview card
 * the side panel uses.
 */
export default function DecisionApp() {
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await sendToBackground<unknown>({ type: 'ui/get_decisions' });
    if (!r.ok) return setError(r.error);
    const list = Array.isArray(r.data) ? r.data.flatMap((d) => {
      const p = DecisionViewSchema.safeParse(d);
      return p.success ? [p.data] : [];
    }) : [];
    setDecisions(list);
  }, []);

  useEffect(() => {
    void refresh();
    const onMsg = (raw: unknown) => {
      const p = BgToUiMessageSchema.safeParse(raw);
      if (p.success && p.data.type !== 'bg/log') void refresh();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [refresh]);

  const current = decisions.find((d) => d.sessionId === selected) ?? decisions[0] ?? null;
  const send = async (msg: Parameters<typeof sendToBackground>[0]) => {
    setError(null);
    const r = await sendToBackground(msg);
    if (!r.ok) setError(r.error);
    void refresh();
  };

  if (!current) {
    return (
      <div className="app">
        <p className="muted">Nothing needs you right now. This window will close on its own.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="card">
        <h1>WebPilot Agent</h1>
        <div className="small muted">
          {decisions.length} {decisions.length === 1 ? 'decision is' : 'decisions are'} waiting. Runs continue in their own tabs.
        </div>
        {decisions.length > 1 && (
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {decisions.map((d) => (
              <li key={d.sessionId}>
                <button
                  type="button"
                  aria-pressed={d.sessionId === current.sessionId}
                  className={d.sessionId === current.sessionId ? 'primary' : undefined}
                  onClick={() => setSelected(d.sessionId)}
                >
                  {KIND_LABEL[d.kind]} · {d.host ?? 'unknown site'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>

      <p className="small muted" style={{ margin: 0 }}>
        {current.host ?? 'unknown site'}: “{current.prompt}”
      </p>

      {current.kind === 'approval' && current.proposal && (
        <ActionPreview
          proposal={current.proposal}
          status={current.status}
          pageChanged={current.pageChanged}
          onApprove={() => void send({ type: 'ui/approve', sessionId: current.sessionId, actionId: current.proposal!.actionId })}
          onReject={() => void send({ type: 'ui/reject', sessionId: current.sessionId, actionId: current.proposal!.actionId })}
          onPreview={() => void send({ type: 'ui/preview', sessionId: current.sessionId, actionId: current.proposal!.actionId })}
        />
      )}

      {current.kind === 'loop' && (
        <LoopCard
          summary={current.loopSummary}
          onContinue={() => void send({ type: 'ui/continue', sessionId: current.sessionId })}
          onStop={() => void send({ type: 'ui/stop', sessionId: current.sessionId })}
        />
      )}

      {current.kind === 'question' && current.question && (
        <QuestionCard
          question={current.question}
          onAnswer={(answer) => void send({ type: 'ui/answer', sessionId: current.sessionId, answer })}
        />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
