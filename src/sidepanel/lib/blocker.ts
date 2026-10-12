import type { PanelState } from '../../shared/schemas';

export type BlockerAction = 'ack' | 'allow' | 'resume' | 'instructions' | 'settings' | null;

export interface Blocker {
  message: string;
  action: BlockerAction;
  actionLabel?: string;
  /** Longer explanation shown in an expandable "Details" view. */
  details?: string;
}

/** The single thing standing between the user and a run, or null when they can run. */
export function getBlocker(state: PanelState): Blocker | null {
  const host = state.site.host ?? 'this page';

  if (!state.disclosureAcknowledged) {
    return {
      message: 'Review what Pilot sends before you start.',
      action: 'ack',
      actionLabel: 'I understand',
      details:
        'Your instructions and a compact list of the page’s interactive elements (names, labels, visible text snippets, URL, title) are sent to the LLM provider you configure. Password and other sensitive field values are never included; card numbers and IDs are redacted on a best-effort basis. The extension only runs on sites you allow, never on banking, healthcare, identity or password-manager sites by default, and asks before consequential actions. Your API key is kept in this browser’s extension storage, which is not a secure vault.',
    };
  }

  if (!state.site.allowed) {
    switch (state.site.code) {
      case 'not_allowlisted':
        return {
          message: `Allow Pilot on ${host}?`,
          action: 'allow',
          actionLabel: 'Allow',
          details: `This session works only on this tab${state.binding?.title ? ` (“${state.binding.title}”)` : ''} and keeps working on it if you switch to another tab. Nothing on the page is read, and nothing is sent to your model provider, until you allow it. Navigating to a different site withdraws the approval.`,
        };
      case 'paused':
        return { message: `Pilot is paused on ${host}.`, action: 'resume', actionLabel: 'Resume', details: state.site.message };
      case 'unknown':
        return {
          message: state.binding?.lastKnownHost ? `Page access needed (last seen on ${state.binding.lastKnownHost}).` : 'Page access needed.',
          action: 'instructions',
          actionLabel: 'Fix access',
          details: `${state.site.message}\n\nClick the Pilot toolbar icon on this tab to grant access again. Pilot never reads or acts on another tab in its place.`,
        };
      default:
        return { message: 'Pilot can’t run on this page.', action: null, details: state.site.message };
    }
  }

  if (!state.dryRun && !state.apiKeySet) return { message: 'Add an API key to get started.', action: 'settings', actionLabel: 'Open settings' };
  if (!state.dryRun && !state.modelId) return { message: 'Add a model ID to get started.', action: 'settings', actionLabel: 'Open settings' };
  return null;
}
