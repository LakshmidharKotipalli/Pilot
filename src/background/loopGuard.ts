import { LOOP_REPEATS, LOOP_WINDOW } from '../shared/constants';
import type { AgentAction, ElementDescriptor, PageMap } from '../shared/schemas';

/** FNV-1a, 32 bit. Only used to compare steps with each other, never for security. */
function fnv(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Hash of what is on the page: URL, title, scroll position and the state of every mapped element. */
function pageState(map: PageMap): string {
  const els = map.elements
    .map((e) => `${e.fingerprint}|${e.name}|${e.value ?? ''}|${e.checked ?? ''}|${e.expanded ?? ''}|${e.disabled}`)
    .join('\n');
  return fnv(`${map.url}\n${map.title}\n${map.viewport.scrollY}\n${els}`);
}

/**
 * Identity of one step: what the agent is about to do, to which element, on which page state.
 * Typed text is hashed, so it never leaves this function in the clear.
 */
export function stepSignature(action: AgentAction, target: ElementDescriptor | null, map: PageMap): string {
  const args: string[] = [action.type];
  if ('targetId' in action) args.push(target?.fingerprint ?? action.targetId);
  switch (action.type) {
    case 'type_text':
      args.push(action.text, String(action.clearFirst));
      break;
    case 'select_option':
      args.push(action.value);
      break;
    case 'set_checked':
      args.push(String(action.checked));
      break;
    case 'scroll':
      args.push(action.direction, action.amount);
      break;
    case 'extract':
      args.push(action.format);
      break;
  }
  return `${fnv(args.join('\u0001'))}:${pageState(map)}`;
}

/**
 * Detects an agent that keeps doing the same thing: the same signature `repeats` times within the
 * last `window` steps. There is no step limit, so this is what stops a run from spinning forever.
 */
export class LoopGuard {
  private recent: string[] = [];

  constructor(
    private readonly window = LOOP_WINDOW,
    private readonly repeats = LOOP_REPEATS,
  ) {}

  /** Record a step; returns true when it makes the run look stuck. */
  record(signature: string): boolean {
    this.recent.push(signature);
    if (this.recent.length > this.window) this.recent.shift();
    return this.recent.filter((s) => s === signature).length >= this.repeats;
  }

  /** Forget the history (after the user chose to continue). */
  reset(): void {
    this.recent = [];
  }
}
