import type { KeyboardEvent } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  onStop: () => void;
  running: boolean;
  disabledReason: string | null;
}

export function PromptBox({ value, onChange, onRun, onStop, running, disabledReason }: Props) {
  const canRun = !running && !disabledReason && value.trim().length > 0;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRun) {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (canRun) onRun();
      }}
    >
      <label htmlFor="prompt" style={{ marginTop: 0 }}>
        What should WebPilot do on this page?
      </label>
      <textarea
        id="prompt"
        value={value}
        placeholder="e.g. Find the contact page"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={running}
        aria-describedby="prompt-hint"
        maxLength={2000}
      />
      <div className="row spread" style={{ marginTop: 6 }}>
        <span id="prompt-hint" className="muted small">
          {disabledReason ?? 'Ctrl/⌘ + Enter to run. Card and ID numbers are redacted before sending.'}
        </span>
        <span className="row">
          <button type="button" className="danger" onClick={onStop} disabled={!running}>
            Stop
          </button>
          <button type="submit" className="primary" disabled={!canRun}>
            Run
          </button>
        </span>
      </div>
    </form>
  );
}
