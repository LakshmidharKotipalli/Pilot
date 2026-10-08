import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/shared/schemas';
import { logLine, logText } from '../src/sidepanel/lib/logText';

const entry = (over: Partial<LogEntry>): LogEntry => ({
  id: 'i', ts: new Date(2026, 0, 1, 14, 2, 11).getTime(), runId: 'r1', prompt: null, actionType: 'click',
  actionSummary: 'Click “Next”', target: null, risk: null, outcome: 'auto_executed', detail: null, ...over,
});

describe('logText', () => {
  it('formats one readable line per entry', () => {
    expect(logLine(entry({}))).toBe('14:02:11  auto executed  Click “Next”');
    expect(logLine(entry({ detail: 'Clicked it.' }))).toBe('14:02:11  auto executed  Click “Next” — Clicked it.');
  });

  it('shows only the current run, oldest first', () => {
    const text = logText([entry({ actionSummary: 'one' }), entry({ runId: 'r2', actionSummary: 'other' }), entry({ actionSummary: 'two' })], 'r1');
    expect(text.split('\n').map((l) => l.split('  ').at(-1))).toEqual(['one', 'two']);
  });

  it('is empty without a run', () => {
    expect(logText([entry({})], null)).toBe('');
  });
});
