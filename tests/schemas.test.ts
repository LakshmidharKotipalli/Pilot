import { describe, expect, it } from 'vitest';
import { ActionSchema, ExecutableActionSchema, SettingsSchema } from '../src/shared/schemas';
import { ToContentMessageSchema, UiMessageSchema } from '../src/shared/messages';
import { canTransition } from '../src/shared/stateMachine';

const valid = [
  { type: 'observe', reason: 'need info' },
  { type: 'click', targetId: 'el_42', reason: 'the button' },
  { type: 'type_text', targetId: 'el_1', text: 'John Doe', clearFirst: true, reason: 'name field' },
  { type: 'select_option', targetId: 'el_3', value: 'Tampa', reason: 'city' },
  { type: 'set_checked', targetId: 'el_4', checked: true, reason: 'agree to nothing' },
  { type: 'scroll', direction: 'down', amount: 'medium', reason: 'see more' },
  { type: 'extract', targetId: 'el_5', format: 'table', reason: 'summarize' },
  { type: 'complete', result: 'Done' },
  { type: 'ask_user', question: 'Which city?', reason: 'ambiguous' },
];

describe('ActionSchema', () => {
  it.each(valid)('accepts %j', (a) => {
    expect(ActionSchema.safeParse(a).success).toBe(true);
  });

  it('defaults clearFirst to true', () => {
    const r = ActionSchema.parse({ type: 'type_text', targetId: 'el_1', text: 'x', reason: 'r' });
    expect(r.type === 'type_text' && r.clearFirst).toBe(true);
  });

  it('rejects unknown action types', () => {
    expect(ActionSchema.safeParse({ type: 'navigate', url: 'https://evil.example' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'run_js', code: 'alert(1)' }).success).toBe(false);
  });

  it('rejects arrays of actions (one action per response)', () => {
    expect(ActionSchema.safeParse([valid[1], valid[2]]).success).toBe(false);
  });

  it('rejects CSS selectors, XPath and arbitrary ids as targets', () => {
    for (const targetId of ['#buy', 'button.primary', '//div[1]', 'el_', 'EL_1', 'el_1; drop', '']) {
      expect(ActionSchema.safeParse({ type: 'click', targetId, reason: 'x' }).success).toBe(false);
    }
  });

  it('rejects unexpected extra keys (strict)', () => {
    expect(ActionSchema.safeParse({ type: 'click', targetId: 'el_1', reason: 'x', selector: 'a' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'observe', reason: 'x', script: 'alert(1)' }).success).toBe(false);
  });

  it('rejects missing/invalid fields', () => {
    expect(ActionSchema.safeParse({ type: 'click', targetId: 'el_1' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'scroll', direction: 'left', amount: 'small', reason: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'extract', targetId: 'el_1', format: 'html', reason: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'set_checked', targetId: 'el_1', checked: 'yes', reason: 'x' }).success).toBe(false);
  });

  it('caps typed text length', () => {
    const r = ActionSchema.safeParse({ type: 'type_text', targetId: 'el_1', text: 'a'.repeat(2001), reason: 'x' });
    expect(r.success).toBe(false);
  });

  it('executable subset excludes complete/ask_user/observe', () => {
    expect(ExecutableActionSchema.safeParse({ type: 'complete', result: 'x' }).success).toBe(false);
    expect(ExecutableActionSchema.safeParse(valid[1]).success).toBe(true);
  });
});

describe('message schemas', () => {
  it('rejects unknown UI messages and bad prompts', () => {
    expect(UiMessageSchema.safeParse({ type: 'ui/eval', code: '1' }).success).toBe(false);
    expect(UiMessageSchema.safeParse({ type: 'ui/run_prompt', prompt: '   ' }).success).toBe(false);
    expect(UiMessageSchema.safeParse({ type: 'ui/run_prompt', prompt: 'find contact page' }).success).toBe(true);
  });

  it('only lets the worker send validated executable actions to the content script', () => {
    expect(
      ToContentMessageSchema.safeParse({ type: 'cs/execute', action: { type: 'complete', result: 'x' } }).success,
    ).toBe(false);
    expect(
      ToContentMessageSchema.safeParse({ type: 'cs/execute', action: { type: 'click', targetId: 'el_1', reason: 'r' } }).success,
    ).toBe(true);
  });
});

describe('settings & state machine', () => {
  it('has secure defaults', () => {
    const s = SettingsSchema.parse({});
    expect(s.safeMode).toBe(true);
    expect(s.allowedDomains).toEqual([]);
    expect(s.blockedDomainPatterns.length).toBeGreaterThan(5);
    expect(s.dryRun).toBe(false);
  });

  it('bounds maxSteps', () => {
    expect(SettingsSchema.safeParse({ maxSteps: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ maxSteps: 500 }).success).toBe(false);
  });

  it('enforces legal transitions', () => {
    expect(canTransition('idle', 'collecting_page_context')).toBe(true);
    expect(canTransition('awaiting_confirmation', 'executing')).toBe(true);
    expect(canTransition('calling_model', 'executing')).toBe(false); // must validate first
    expect(canTransition('validating_action', 'executing')).toBe(true);
    expect(canTransition('completed', 'executing')).toBe(false);
  });
});
