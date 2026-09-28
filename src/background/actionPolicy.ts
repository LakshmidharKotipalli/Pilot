import { describeTarget, assessRisk } from '../shared/risk';
import { redactText, truncate } from '../shared/redaction';
import type { AgentAction, ElementDescriptor, Mode, RiskAssessment } from '../shared/schemas';

export interface PolicyDecision {
  assessment: RiskAssessment;
  decision: 'auto' | 'confirm';
}

/**
 * The only place that decides whether an action runs automatically. The model's opinion of risk is
 * never consulted; this uses the local classifier and the user's chosen mode.
 */
export function decide(
  action: AgentAction,
  target: ElementDescriptor | null | undefined,
  pageUrl: string,
  mode: Mode,
  userGoal?: string,
): PolicyDecision {
  const assessment = assessRisk({ action, target, pageUrl, mode, userGoal });
  return { assessment, decision: assessment.requiresConfirmation ? 'confirm' : 'auto' };
}

/** One-line plain-English summary for previews and logs. Typed text is shown literally (unless sensitive). */
export function summarizeAction(action: AgentAction, target?: ElementDescriptor | null): string {
  const t = describeTarget(target);
  switch (action.type) {
    case 'observe':
      return 'Re-read the page';
    case 'click':
      return `Click ${t}`;
    case 'type_text':
      return `Type ${target?.sensitive ? '[hidden]' : `“${truncate(action.text, 200)}”`} into ${t}${action.clearFirst ? ' (replacing existing text)' : ''}`;
    case 'select_option':
      return `Select “${truncate(action.value, 80)}” in ${t}`;
    case 'set_checked':
      return `${action.checked ? 'Check' : 'Uncheck'} ${t}`;
    case 'scroll':
      return `Scroll ${action.direction} (${action.amount})`;
    case 'extract':
      return `Extract ${action.format} from ${t}`;
    case 'complete':
      return 'Finish';
    case 'ask_user':
      return 'Ask you a question';
  }
}

export function modelReason(action: AgentAction): string {
  if (action.type === 'complete') return truncate(redactText(action.result), 500);
  if (action.type === 'ask_user') return truncate(redactText(action.question), 500);
  return truncate(redactText(action.reason), 500);
}

export function literalTextOf(action: AgentAction, target?: ElementDescriptor | null): string | null {
  return action.type === 'type_text' ? (target?.sensitive ? null : action.text) : null;
}
