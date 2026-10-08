import { describe, expect, it } from 'vitest';
import type { PanelState } from '../src/shared/schemas';
import { getBlocker } from '../src/sidepanel/lib/blocker';
import { shouldSubmit } from '../src/sidepanel/lib/composerKeys';

const base = {
  disclosureAcknowledged: true,
  dryRun: false,
  apiKeySet: true,
  modelId: 'm',
  site: { allowed: true, code: 'ok', host: 'example.com', message: '' },
} as unknown as PanelState;

const withSite = (code: string, allowed = false): PanelState =>
  ({ ...base, site: { allowed, code, host: 'example.com', message: 'raw message' } }) as unknown as PanelState;

describe('getBlocker', () => {
  it('is null when everything is ready', () => {
    expect(getBlocker(base)).toBeNull();
  });

  it('puts the disclosure before every other blocker', () => {
    const b = getBlocker({ ...withSite('not_allowlisted'), disclosureAcknowledged: false });
    expect(b?.action).toBe('ack');
  });

  it('offers a real grant only for a non-allowlisted site', () => {
    expect(getBlocker(withSite('not_allowlisted'))?.action).toBe('allow');
    expect(getBlocker(withSite('paused'))?.action).toBe('resume');
  });

  it('only shows instructions, with no action, when access cannot be granted from here', () => {
    expect(getBlocker(withSite('unknown'))?.action).toBe('instructions');
    expect(getBlocker(withSite('unknown'))?.details).toMatch(/toolbar icon/);
    for (const code of ['blocked', 'unsupported']) {
      const b = getBlocker(withSite(code));
      expect(b?.action).toBeNull();
      expect(b?.details).toBe('raw message');
    }
  });

  it('asks for a key then a model, unless dry run', () => {
    expect(getBlocker({ ...base, apiKeySet: false })?.action).toBe('settings');
    expect(getBlocker({ ...base, modelId: '' })?.action).toBe('settings');
    expect(getBlocker({ ...base, apiKeySet: false, modelId: '', dryRun: true })).toBeNull();
  });
});

describe('shouldSubmit', () => {
  const enter = { key: 'Enter', shiftKey: false };
  it('submits on Enter when allowed', () => {
    expect(shouldSubmit(enter, true)).toBe(true);
  });
  it('does not submit when the composer cannot run', () => {
    expect(shouldSubmit(enter, false)).toBe(false);
  });
  it('Shift+Enter is a newline', () => {
    expect(shouldSubmit({ ...enter, shiftKey: true }, true)).toBe(false);
  });
  it('ignores Enter while an IME is composing', () => {
    expect(shouldSubmit({ ...enter, isComposing: true }, true)).toBe(false);
    expect(shouldSubmit({ ...enter, keyCode: 229 }, true)).toBe(false);
  });
  it('ignores other keys', () => {
    expect(shouldSubmit({ key: 'a', shiftKey: false }, true)).toBe(false);
  });
});
