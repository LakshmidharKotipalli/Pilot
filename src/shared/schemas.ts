import { z } from 'zod';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_BLOCKED_DOMAIN_PATTERNS,
  MAX_TYPE_TEXT_CHARS,
} from './constants';

/* ------------------------------------------------------------------ */
/* Agent actions (the ONLY thing the model may produce)                */
/* ------------------------------------------------------------------ */

const reason = z.string().trim().min(1).max(500);
export const TargetIdSchema = z.string().regex(/^el_\d{1,7}$/, 'targetId must be an id from the page map, like "el_42"');

export const ObserveActionSchema = z.object({ type: z.literal('observe'), reason }).strict();

export const ClickActionSchema = z
  .object({ type: z.literal('click'), targetId: TargetIdSchema, reason })
  .strict();

export const TypeTextActionSchema = z
  .object({
    type: z.literal('type_text'),
    targetId: TargetIdSchema,
    text: z.string().max(MAX_TYPE_TEXT_CHARS),
    clearFirst: z.boolean().default(true),
    reason,
  })
  .strict();

export const SelectOptionActionSchema = z
  .object({ type: z.literal('select_option'), targetId: TargetIdSchema, value: z.string().min(1).max(300), reason })
  .strict();

export const SetCheckedActionSchema = z
  .object({ type: z.literal('set_checked'), targetId: TargetIdSchema, checked: z.boolean(), reason })
  .strict();

export const GoBackActionSchema = z.object({ type: z.literal('go_back'), reason }).strict();

export const ScrollActionSchema = z
  .object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.enum(['small', 'medium', 'large']),
    reason,
  })
  .strict();

export const ExtractActionSchema = z
  .object({
    type: z.literal('extract'),
    targetId: TargetIdSchema,
    format: z.enum(['text', 'table', 'links']),
    reason,
  })
  .strict();

export const CompleteActionSchema = z
  .object({ type: z.literal('complete'), result: z.string().trim().min(1).max(4000) })
  .strict();

export const AskUserActionSchema = z
  .object({ type: z.literal('ask_user'), question: z.string().trim().min(1).max(1000), reason })
  .strict();

/** Every action the model may return. Exactly one object; arrays / extra keys are rejected. */
export const ActionSchema = z.discriminatedUnion('type', [
  ObserveActionSchema,
  GoBackActionSchema,
  ClickActionSchema,
  TypeTextActionSchema,
  SelectOptionActionSchema,
  SetCheckedActionSchema,
  ScrollActionSchema,
  ExtractActionSchema,
  CompleteActionSchema,
  AskUserActionSchema,
]);

/** The subset that the content script is able to execute. */
export const ExecutableActionSchema = z.discriminatedUnion('type', [
  ClickActionSchema,
  TypeTextActionSchema,
  SelectOptionActionSchema,
  SetCheckedActionSchema,
  ScrollActionSchema,
  ExtractActionSchema,
]);

export type AgentAction = z.infer<typeof ActionSchema>;
export type ExecutableAction = z.infer<typeof ExecutableActionSchema>;

/* ------------------------------------------------------------------ */
/* Page interaction map                                                 */
/* ------------------------------------------------------------------ */

export const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export const ElementDescriptorSchema = z.object({
  id: TargetIdSchema,
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  visibleText: z.string(),
  label: z.string().nullable(),
  inputType: z.string().nullable(),
  placeholder: z.string().nullable(),
  autocomplete: z.string().nullable(),
  href: z.string().nullable(),
  value: z.string().nullable(), // redacted; always null for sensitive fields
  checked: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  options: z.array(z.string()).nullable(),
  disabled: z.boolean(),
  visible: z.boolean(),
  inViewport: z.boolean(),
  inForm: z.boolean(),
  isSubmit: z.boolean(),
  sensitive: z.boolean(),
  /** Read-only content region (table, article, list...). Only valid target for `extract`. */
  extractOnly: z.boolean(),
  rect: RectSchema,
  riskHints: z.array(z.string()),
  safePathHint: z.string(),
  nearbyText: z.string(),
  /** Identity check used to detect stale targets. Not sent to the model. */
  fingerprint: z.string(),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

export const PageMapSchema = z.object({
  url: z.string(),
  title: z.string(),
  capturedAt: z.number(),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    scrollY: z.number(),
    scrollHeight: z.number(),
  }),
  textSnippets: z.array(z.string()),
  elements: z.array(ElementDescriptorSchema),
  truncated: z.boolean(),
});
export type PageMap = z.infer<typeof PageMapSchema>;

export const ExtractedDataSchema = z.object({
  targetId: TargetIdSchema,
  format: z.enum(['text', 'table', 'links']),
  text: z.string().optional(),
  rows: z.array(z.array(z.string())).optional(),
  links: z.array(z.object({ text: z.string(), href: z.string() })).optional(),
  truncated: z.boolean(),
});
export type ExtractedData = z.infer<typeof ExtractedDataSchema>;

/* ------------------------------------------------------------------ */
/* Risk / policy                                                        */
/* ------------------------------------------------------------------ */

export const RiskAssessmentSchema = z.object({
  risk: z.enum(['low', 'high']),
  reasons: z.array(z.string()),
  requiresConfirmation: z.boolean(),
  /** Autonomous mode only: a hard limit was hit, so the action is skipped instead of asking. */
  blocked: z.boolean().default(false),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const ModeSchema = z.enum(['safe', 'assisted', 'autonomous']);
export type Mode = z.infer<typeof ModeSchema>;

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

export const SettingsSchema = z.object({
  apiBaseUrl: z.string().trim().url().default(DEFAULT_API_BASE_URL),
  modelId: z.string().trim().max(200).default(''),
  mode: ModeSchema.default('autonomous'),
  dryRun: z.boolean().default(false),
  debug: z.boolean().default(false),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)).default([]),
  pausedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)).default([]),
  blockedDomainPatterns: z
    .array(z.string().trim().toLowerCase().min(1).max(253))
    .default([...DEFAULT_BLOCKED_DOMAIN_PATTERNS]),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* ------------------------------------------------------------------ */
/* Run state, activity log                                              */
/* ------------------------------------------------------------------ */

export const RunStatusSchema = z.enum([
  'idle',
  'collecting_page_context',
  'calling_model',
  'validating_action',
  'awaiting_confirmation',
  'paused_loop',
  'executing',
  'observing_result',
  'completed',
  'stopped',
  'error',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SiteVerdictSchema = z.object({
  host: z.string().nullable(),
  code: z.enum(['ok', 'unsupported', 'blocked', 'not_allowlisted', 'paused', 'unknown']),
  allowed: z.boolean(),
  paused: z.boolean(),
  message: z.string(),
});
export type SiteVerdict = z.infer<typeof SiteVerdictSchema>;

export const ProposalSchema = z.object({
  actionId: z.string(),
  action: ActionSchema,
  summary: z.string(),
  targetDescription: z.string().nullable(),
  modelReason: z.string(),
  literalText: z.string().nullable(),
  risk: RiskAssessmentSchema,
  autoExecute: z.boolean(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const LogOutcomeSchema = z.enum([
  'run_started',
  'proposed',
  'approved',
  'rejected',
  'auto_executed',
  'executed',
  'failed',
  'blocked',
  'stopped',
  'completed',
  'info',
]);

export const LogEntrySchema = z.object({
  id: z.string(),
  ts: z.number(),
  runId: z.string().nullable(),
  prompt: z.string().nullable(),
  actionType: z.string(),
  actionSummary: z.string(),
  target: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  outcome: LogOutcomeSchema,
  detail: z.string().nullable(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** What a session is waiting on the user for. */
export const DecisionKindSchema = z.enum(['approval', 'loop', 'question']);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/** One row of the side panel's session list. Never contains page content. */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  tabId: z.number(),
  host: z.string().nullable(),
  prompt: z.string(),
  status: RunStatusSchema,
  step: z.number(),
  needsYou: DecisionKindSchema.nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const PanelStateSchema = z.object({
  /** The session this state describes, or null for a tab that has no session. */
  sessionId: z.string().nullable(),
  tabId: z.number().nullable(),
  /** The origin this session is confined to, once it has started. */
  scopeOrigin: z.string().nullable(),
  sessions: z.array(SessionSummarySchema),
  status: RunStatusSchema,
  runId: z.string().nullable(),
  prompt: z.string(),
  step: z.number(),
  mode: ModeSchema,
  modelId: z.string(),
  dryRun: z.boolean(),
  apiKeySet: z.boolean(),
  disclosureAcknowledged: z.boolean(),
  site: SiteVerdictSchema,
  proposal: ProposalSchema.nullable(),
  pageChanged: z.boolean(),
  extracted: z.array(ExtractedDataSchema),
  statusDetail: z.string().nullable(),
  lastError: z.string().nullable(),
  finalResult: z.string().nullable(),
  question: z.string().nullable(),
  dryRunPayload: z.string().nullable(),
  /** The panel's own binding: which tab it belongs to and whether the user approved Pilot there. */
  binding: z
    .object({
      bindingId: z.string(),
      ownerTabId: z.number(),
      ownerWindowId: z.number().nullable(),
      approved: z.boolean(),
      title: z.string().nullable(),
      /** Host last seen on this tab; shown when the live address can no longer be read. */
      lastKnownHost: z.string().nullable(),
    })
    .nullable(),
});
export type PanelState = z.infer<typeof PanelStateSchema>;

/** A pending decision as shown in the decision popup. Contains only what the user needs to decide. */
export const DecisionViewSchema = z.object({
  sessionId: z.string(),
  tabId: z.number(),
  kind: DecisionKindSchema,
  host: z.string().nullable(),
  prompt: z.string(),
  status: RunStatusSchema,
  proposal: ProposalSchema.nullable(),
  pageChanged: z.boolean(),
  question: z.string().nullable(),
  loopSummary: z.string().nullable(),
});
export type DecisionView = z.infer<typeof DecisionViewSchema>;

/** Persisted (chrome.storage.session) subset of one run. Never contains DOM references or page content. */
/** One panel and tab pairing. The owner never changes; navigation changes only the metadata. */
export const TabBindingSchema = z.object({
  bindingId: z.string(),
  ownerTabId: z.number(),
  ownerWindowId: z.number().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  /** Origin the user approved for this tab's session, or null when access has not been (or is no longer) approved. */
  approvedOrigin: z.string().nullable(),
  /** Bumped on every navigation so stale work for an older document can be recognised. */
  generation: z.number(),
  createdAt: z.number(),
});
export type TabBinding = z.infer<typeof TabBindingSchema>;

export const PersistedRunSchema = z.object({
  sessionId: z.string(),
  status: RunStatusSchema,
  runId: z.string().nullable(),
  tabId: z.number(),
  prompt: z.string(),
  step: z.number(),
  lastError: z.string().nullable(),
});
export type PersistedRun = z.infer<typeof PersistedRunSchema>;

/* ------------------------------------------------------------------ */
/* Results returned by the content script                               */
/* ------------------------------------------------------------------ */

export const ExecCodeSchema = z.enum([
  'NOT_FOUND',
  'STALE_TARGET',
  'NOT_VISIBLE',
  'DISABLED',
  'COVERED',
  'SENSITIVE',
  'UNSUPPORTED',
  'VERIFY_FAILED',
  'STALE_DOCUMENT',
  'BAD_MESSAGE',
  'ERROR',
]);
export type ExecCode = z.infer<typeof ExecCodeSchema>;

export const ExecResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    message: z.string(),
    extracted: ExtractedDataSchema.optional(),
    navigating: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), code: ExecCodeSchema, message: z.string() }),
]);
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const MapResponseSchema = z.discriminatedUnion('ok', [
  /** `docId` identifies the document the map came from; actions are pinned to it. */
  z.object({ ok: z.literal(true), map: PageMapSchema, docId: z.string() }),
  z.object({ ok: z.literal(false), code: ExecCodeSchema, message: z.string() }),
]);
export type MapResponse = z.infer<typeof MapResponseSchema>;
