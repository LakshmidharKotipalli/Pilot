import type { RunStatus } from './schemas';

const ACTIVE: RunStatus[] = [
  'collecting_page_context',
  'calling_model',
  'validating_action',
  'awaiting_confirmation',
  'executing',
  'observing_result',
];

export const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  idle: ['collecting_page_context', 'error'],
  collecting_page_context: ['calling_model', 'error', 'stopped'],
  calling_model: ['validating_action', 'completed', 'error', 'stopped'], // completed = dry run
  validating_action: [
    'awaiting_confirmation',
    'executing',
    'collecting_page_context', // observe / feedback loop
    'completed',
    'error',
    'stopped',
  ],
  awaiting_confirmation: ['executing', 'error', 'stopped'],
  executing: ['observing_result', 'error', 'stopped'],
  observing_result: ['collecting_page_context', 'completed', 'error', 'stopped'],
  completed: ['idle', 'collecting_page_context'],
  stopped: ['idle', 'collecting_page_context'],
  error: ['idle', 'collecting_page_context'],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isActiveStatus(s: RunStatus): boolean {
  return ACTIVE.includes(s);
}
