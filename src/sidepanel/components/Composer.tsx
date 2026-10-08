import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { shouldSubmit } from '../lib/composerKeys';
import { ArrowUpIcon, StopIcon } from './Icons';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: () => void;
  onStop: () => void;
  running: boolean;
  blocked: boolean;
}

const MAX_HEIGHT_LINES = 5;

export function Composer({ value, onChange, onRun, onStop, running, blocked }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const canRun = !running && !blocked && value.trim().length > 0;

  // Grow with content between the CSS min-height (about two lines) and five lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_HEIGHT_LINES)}px`;
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmit({ key: e.key, shiftKey: e.shiftKey, keyCode: e.keyCode, isComposing: e.nativeEvent.isComposing }, canRun)) {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (canRun) onRun();
      }}
    >
      <label htmlFor="prompt" className="sr-only">
        Task for WebPilot
      </label>
      <textarea
        id="prompt"
        ref={ref}
        value={value}
        rows={2}
        placeholder="Ask WebPilot to do something on this page…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={2000}
      />
      {running ? (
        <button type="button" className="icon-btn send stop" onClick={onStop} aria-label="Stop">
          <StopIcon />
        </button>
      ) : (
        <button type="submit" className="icon-btn send" disabled={!canRun} aria-label="Send">
          <ArrowUpIcon />
        </button>
      )}
    </form>
  );
}
