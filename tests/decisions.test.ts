import { describe, expect, it } from 'vitest';
import { notificationSummary } from '../src/background/decisions';
import type { AgentAction, Proposal } from '../src/shared/schemas';

const proposal = (action: AgentAction, over: Partial<Proposal> = {}): Proposal => ({
  actionId: 'a1',
  action,
  summary: 'IGNORED full summary with typed text',
  targetDescription: 'the “Email” field',
  modelReason: 'model said: secret reason',
  literalText: 'hunter2-typed-text',
  risk: { risk: 'low', reasons: [], requiresConfirmation: true, blocked: false },
  autoExecute: false,
  ...over,
});

describe('notificationSummary', () => {
  it('never includes typed text, the model’s reason, or the full summary', () => {
    const text = notificationSummary(
      proposal({ type: 'type_text', targetId: 'el_1', text: 'hunter2-typed-text', clearFirst: true, reason: 'secret reason' }),
      'the “Email” field',
    );
    expect(text).toBe('Type text into the “Email” field');
    expect(text).not.toMatch(/hunter2|secret|IGNORED/);
  });

  it('describes each action by kind and target only', () => {
    expect(notificationSummary(proposal({ type: 'click', targetId: 'el_1', reason: 'r' }), 'the “Buy” button')).toBe('Click the “Buy” button');
    expect(notificationSummary(proposal({ type: 'select_option', targetId: 'el_1', value: 'Tampa', reason: 'r' }), 'the city menu')).toBe(
      'Choose an option in the city menu',
    );
    expect(notificationSummary(proposal({ type: 'set_checked', targetId: 'el_1', checked: false, reason: 'r' }), 'the box')).toBe('Uncheck the box');
  });

  it('truncates a very long target label', () => {
    const long = 'x'.repeat(500);
    expect(notificationSummary(proposal({ type: 'click', targetId: 'el_1', reason: 'r' }), long).length).toBeLessThan(120);
  });
});
