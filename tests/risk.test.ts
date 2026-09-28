import { describe, expect, it } from 'vitest';
import { assessRisk, keywordHints } from '../src/shared/risk';
import type { AgentAction, ElementDescriptor } from '../src/shared/schemas';

const PAGE = 'https://shop.example.com/products';

function el(over: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    id: 'el_1',
    tag: 'button',
    role: 'button',
    name: 'Learn more',
    visibleText: 'Learn more',
    label: null,
    inputType: null,
    placeholder: null,
    autocomplete: null,
    href: null,
    value: null,
    checked: null,
    expanded: null,
    options: null,
    disabled: false,
    visible: true,
    inViewport: true,
    inForm: false,
    isSubmit: false,
    sensitive: false,
    extractOnly: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    riskHints: [],
    safePathHint: 'button',
    nearbyText: '',
    fingerprint: 'fp',
    ...over,
  };
}

const click: AgentAction = { type: 'click', targetId: 'el_1', reason: 'r' };
const type = (text: string): AgentAction => ({ type: 'type_text', targetId: 'el_1', text, clearFirst: true, reason: 'r' });

describe('keywordHints', () => {
  it.each([
    ['Buy now', 'commerce'],
    ['Proceed to Checkout', 'commerce'],
    ['Submit', 'publish'],
    ['Delete account', 'destructive'],
    ['Sign in', 'auth'],
    ['Log out', 'auth'],
    ['Withdraw funds', 'finance'],
    ['Book a table', 'booking'],
    ['Download PDF', 'file'],
    ['Allow notifications', 'permission'],
    ['Save changes', 'account'],
    ['Agree and continue', 'account'],
  ])('%s → %s', (text, cat) => {
    expect(keywordHints(text)).toContain(cat);
  });

  it('is case-insensitive and does not flag benign labels', () => {
    expect(keywordHints('SUBMIT')).toContain('publish');
    expect(keywordHints('Read more')).toEqual([]);
    expect(keywordHints('Next page')).toEqual([]);
  });
});

describe('assessRisk', () => {
  it('scroll / observe are low and never need confirmation', () => {
    const r = assessRisk({ action: { type: 'scroll', direction: 'down', amount: 'small', reason: 'r' }, pageUrl: PAGE, mode: 'safe' });
    expect(r).toMatchObject({ risk: 'low', requiresConfirmation: false });
  });

  it('safe mode requires confirmation for every click, even low-risk', () => {
    const r = assessRisk({ action: click, target: el(), pageUrl: PAGE, mode: 'safe' });
    expect(r.risk).toBe('low');
    expect(r.requiresConfirmation).toBe(true);
  });

  it('safe mode requires confirmation for typing/select/check', () => {
    for (const action of [
      type('hello'),
      { type: 'select_option', targetId: 'el_1', value: 'a', reason: 'r' } as AgentAction,
      { type: 'set_checked', targetId: 'el_1', checked: true, reason: 'r' } as AgentAction,
    ]) {
      expect(assessRisk({ action, target: el({ tag: 'input', inputType: 'text' }), pageUrl: PAGE, mode: 'safe' }).requiresConfirmation).toBe(true);
    }
  });

  it('treats "Add to cart" as high risk (commerce)', () => {
    const r = assessRisk({ action: click, target: el({ name: 'Add to cart', visibleText: 'Add to cart' }), pageUrl: PAGE, mode: 'assisted' });
    expect(r.risk).toBe('high');
    expect(r.requiresConfirmation).toBe(true);
  });

  it('form submit buttons are high risk in assisted mode', () => {
    const r = assessRisk({ action: click, target: el({ isSubmit: true, inForm: true, name: 'Go' }), pageUrl: PAGE, mode: 'assisted' });
    expect(r.risk).toBe('high');
    expect(r.reasons.join(' ')).toMatch(/form/i);
  });

  it('cross-origin links are high risk; same-origin links are low but still confirmed in assisted mode', () => {
    const cross = assessRisk({ action: click, target: el({ tag: 'a', role: 'link', name: 'Partner', href: 'https://other.example.org/' }), pageUrl: PAGE, mode: 'assisted' });
    expect(cross.risk).toBe('high');
    expect(cross.reasons.join(' ')).toMatch(/new origin/i);

    const same = assessRisk({ action: click, target: el({ tag: 'a', role: 'link', name: 'Contact', href: 'https://shop.example.com/contact' }), pageUrl: PAGE, mode: 'assisted' });
    expect(same.risk).toBe('low');
    expect(same.requiresConfirmation).toBe(true); // not a same-page nav
  });

  it('assisted mode auto-runs same-page hash links, tabs and accordions', () => {
    const hash = assessRisk({ action: click, target: el({ tag: 'a', role: 'link', name: 'Details', href: 'https://shop.example.com/products#details' }), pageUrl: PAGE, mode: 'assisted' });
    expect(hash).toMatchObject({ risk: 'low', requiresConfirmation: false });

    const tab = assessRisk({ action: click, target: el({ role: 'tab', name: 'Reviews' }), pageUrl: PAGE, mode: 'assisted' });
    expect(tab.requiresConfirmation).toBe(false);

    const acc = assessRisk({ action: click, target: el({ name: 'Shipping info', expanded: false }), pageUrl: PAGE, mode: 'assisted' });
    expect(acc.requiresConfirmation).toBe(false);
  });

  it('assisted mode never auto-runs typing', () => {
    const r = assessRisk({ action: type('wireless headphones'), target: el({ tag: 'input', inputType: 'search', name: 'Search' }), pageUrl: PAGE, mode: 'assisted' });
    expect(r.risk).toBe('low');
    expect(r.requiresConfirmation).toBe(true);
  });

  it('typing into sensitive / MFA / payment fields is high risk', () => {
    expect(assessRisk({ action: type('x'), target: el({ tag: 'input', inputType: 'password', sensitive: true, name: 'Password' }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
    expect(assessRisk({ action: type('123456'), target: el({ tag: 'input', inputType: 'text', name: 'Verification code' }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
    expect(assessRisk({ action: type('x'), target: el({ tag: 'input', inputType: 'text', name: 'Name', autocomplete: 'cc-number' }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
  });

  it('typed text that looks like a card number or SSN is high risk', () => {
    const t = el({ tag: 'input', inputType: 'text', name: 'Notes' });
    expect(assessRisk({ action: type('4242 4242 4242 4242'), target: t, pageUrl: PAGE, mode: 'safe' }).risk).toBe('high');
    expect(assessRisk({ action: type('123-45-6789'), target: t, pageUrl: PAGE, mode: 'safe' }).risk).toBe('high');
  });

  it('file inputs are high risk', () => {
    expect(assessRisk({ action: click, target: el({ tag: 'input', inputType: 'file', name: 'Choose file' }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
  });

  it('commerce/account context near a button raises risk', () => {
    const r = assessRisk({ action: click, target: el({ name: 'Go', inForm: true, nearbyText: 'Payment details' }), pageUrl: PAGE, mode: 'assisted' });
    expect(r.risk).toBe('high');
  });

  it('non-http schemes and unknown targets are high risk (uncertain → high)', () => {
    expect(assessRisk({ action: click, target: el({ tag: 'a', name: 'Email us', href: 'mailto:a@b.co' }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
    expect(assessRisk({ action: click, target: null, pageUrl: PAGE, mode: 'assisted' })).toMatchObject({ risk: 'high', requiresConfirmation: true });
  });

  it('treats any non-extract action on a read-only content region as high risk', () => {
    const region = el({ tag: 'table', role: 'table', name: 'Prices', extractOnly: true });
    for (const action of [click, type('x')]) {
      const r = assessRisk({ action, target: region, pageUrl: PAGE, mode: 'assisted' });
      expect(r).toMatchObject({ risk: 'high', requiresConfirmation: true });
    }
    const ex: AgentAction = { type: 'extract', targetId: 'el_1', format: 'table', reason: 'r' };
    expect(assessRisk({ action: ex, target: region, pageUrl: PAGE, mode: 'assisted' })).toMatchObject({ risk: 'low', requiresConfirmation: false });
  });

  it('extract of sensitive fields is high; normal extraction is auto in assisted mode', () => {
    const ex: AgentAction = { type: 'extract', targetId: 'el_1', format: 'text', reason: 'r' };
    expect(assessRisk({ action: ex, target: el({ tag: 'div' }), pageUrl: PAGE, mode: 'assisted' }).requiresConfirmation).toBe(false);
    expect(assessRisk({ action: ex, target: el({ sensitive: true }), pageUrl: PAGE, mode: 'assisted' }).risk).toBe('high');
  });
});

describe('autonomous mode', () => {
  const auto = (action: AgentAction, target: ElementDescriptor | null, userGoal = '') =>
    assessRisk({ action, target, pageUrl: PAGE, mode: 'autonomous', userGoal });

  it('runs routine low-risk steps without asking, including typing and same-site links', () => {
    expect(auto(type('wireless headphones'), el({ tag: 'input', inputType: 'search', name: 'Search' })).requiresConfirmation).toBe(false);
    expect(auto(click, el({ tag: 'a', role: 'link', name: 'Contact', href: 'https://shop.example.com/contact' })).requiresConfirmation).toBe(false);
    expect(auto({ type: 'select_option', targetId: 'el_1', value: 'red', reason: 'r' }, el({ tag: 'select', name: 'Colour' })).requiresConfirmation).toBe(false);
  });

  it('still asks before serious actions the prompt did not mention', () => {
    const buy = el({ name: 'Add to cart', visibleText: 'Add to cart' });
    expect(auto(click, buy, 'find headphones under $50')).toMatchObject({ risk: 'high', requiresConfirmation: true });
    expect(auto(click, el({ isSubmit: true, inForm: true, name: 'Go' }), 'fill the form')).toMatchObject({ requiresConfirmation: true });
  });

  it('proceeds without asking when the prompt explicitly names the control', () => {
    const buy = el({ name: 'Add to cart', visibleText: 'Add to cart' });
    const r = auto(click, buy, 'Search for headphones and click "Add to cart"');
    expect(r.risk).toBe('high');
    expect(r.requiresConfirmation).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/explicitly requested/i);
  });

  it('a partial or unrelated mention does not count', () => {
    const buy = el({ name: 'Buy now', visibleText: 'Buy now' });
    expect(auto(click, buy, 'I want to buy headphones').requiresConfirmation).toBe(true);
  });

  it('never waives hard stops, even if the prompt names them', () => {
    const pw = el({ tag: 'input', inputType: 'password', sensitive: true, name: 'Password' });
    expect(auto(type('x'), pw, 'type into Password').requiresConfirmation).toBe(true);
    const file = el({ tag: 'input', inputType: 'file', name: 'Choose file' });
    expect(auto(click, file, 'click Choose file').requiresConfirmation).toBe(true);
    const card = el({ tag: 'input', inputType: 'text', name: 'Notes' });
    expect(auto(type('4242 4242 4242 4242'), card, 'type 4242 4242 4242 4242 into Notes').requiresConfirmation).toBe(true);
    expect(auto(click, null, 'click anything').requiresConfirmation).toBe(true);
    expect(auto(click, el({ tag: 'a', name: 'Email us', href: 'mailto:a@b.co' }), 'click Email us').requiresConfirmation).toBe(true);
  });
});
