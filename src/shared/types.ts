import type { Settings } from './schemas';
// Types are derived from the Zod schemas so runtime validation and static types cannot drift.
export type {
  AgentAction,
  ExecutableAction,
  ElementDescriptor,
  PageMap,
  ExtractedData,
  RiskAssessment,
  Mode,
  Settings,
  SettingsPatch,
  RunStatus,
  SiteVerdict,
  Proposal,
  LogEntry,
  PanelState,
  PersistedRun,
  ExecCode,
  ExecResult,
  MapResponse,
} from './schemas';

export type { UiMessage, ToContentMessage, ContentToBgMessage, BgToUiMessage, UiResponse } from './messages';

/** Compact history handed back to the model on the next step. */
export interface HistoryItem {
  step: number;
  action: string;
  outcome: string;
}

/** Settings as seen by UI pages: the API key itself is never included. */
export type PublicSettings = Settings & { apiKeySet: boolean };
