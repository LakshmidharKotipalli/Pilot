import { useState } from 'react';

interface LoopProps {
  summary: string | null;
  onContinue: () => void;
  onStop: () => void;
}

/** Shown when the loop guard paused a run: the same step keeps repeating. */
export function LoopCard({ summary, onContinue, onStop }: LoopProps) {
  return (
    <section className="card" role="alertdialog" aria-labelledby="loop-title">
      <div className="row spread">
        <h2 id="loop-title">Stuck in a loop?</h2>
        <span className="badge high">PAUSED</span>
      </div>
      <p style={{ margin: '0 0 8px' }}>{summary ?? 'The agent keeps repeating the same step.'}</p>
      <div className="row">
        <button type="button" className="danger" onClick={onStop}>
          Stop
        </button>
        <button type="button" className="primary" onClick={onContinue}>
          Continue anyway
        </button>
      </div>
    </section>
  );
}

interface QuestionProps {
  question: string;
  onAnswer: (answer: string) => void;
}

/** The assistant asked something: answering starts a follow-up run on the same tab. */
export function QuestionCard({ question, onAnswer }: QuestionProps) {
  const [answer, setAnswer] = useState('');
  return (
    <section className="card" role="alertdialog" aria-labelledby="question-title">
      <h2 id="question-title">The assistant needs to know</h2>
      <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{question}</p>
      <textarea
        aria-label="Your answer"
        value={answer}
        maxLength={2000}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Type your answer"
      />
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="primary" disabled={!answer.trim()} onClick={() => onAnswer(answer)}>
          Send answer
        </button>
      </div>
    </section>
  );
}
