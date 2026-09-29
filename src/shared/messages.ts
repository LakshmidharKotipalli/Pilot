import { z } from 'zod';
import {
  ExecutableActionSchema,
  LogEntrySchema,
  PanelStateSchema,
  SettingsPatchSchema,
  TargetIdSchema,
} from './schemas';

/* Side panel / options page -> service worker */
export const UiMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ui/run_prompt'),
    prompt: z.string().trim().min(1).max(2000),
    /** The tab to run on. Pages that know their own tab must send it; the worker never guesses "active". */
    tabId: z.number().int().optional(),
  }),
  z.object({ type: z.literal('ui/approve'), sessionId: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('ui/reject'), sessionId: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('ui/preview'), sessionId: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('ui/continue'), sessionId: z.string() }),
  z.object({ type: z.literal('ui/stop'), sessionId: z.string() }),
  z.object({ type: z.literal('ui/stop_all') }),
  z.object({ type: z.literal('ui/get_state'), tabId: z.number().int().optional() }),
  z.object({ type: z.literal('ui/get_decisions') }),
  z.object({ type: z.literal('ui/get_settings') }),
  z.object({
    type: z.literal('ui/save_settings'),
    settings: SettingsPatchSchema,
    apiKey: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal('ui/clear_api_key') }),
  z.object({ type: z.literal('ui/get_log') }),
  z.object({ type: z.literal('ui/clear_log') }),
  z.object({ type: z.literal('ui/allow_site'), host: z.string().min(1).max(253) }),
  z.object({ type: z.literal('ui/remove_site'), host: z.string().min(1).max(253) }),
  z.object({ type: z.literal('ui/pause_site'), host: z.string().min(1).max(253), paused: z.boolean() }),
  z.object({ type: z.literal('ui/ack_disclosure') }),
  z.object({ type: z.literal('ui/get_diagnostics'), tabId: z.number().int().optional() }),
]);
export type UiMessage = z.infer<typeof UiMessageSchema>;

/* Service worker -> content script (sent with chrome.tabs.sendMessage) */
export const ToContentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cs/ping') }),
  z.object({ type: z.literal('cs/collect_map') }),
  z.object({
    type: z.literal('cs/highlight'),
    targetId: TargetIdSchema,
    fingerprint: z.string(),
    label: z.string().max(200),
  }),
  z.object({ type: z.literal('cs/scroll_to_target'), targetId: TargetIdSchema, fingerprint: z.string() }),
  z.object({ type: z.literal('cs/clear_highlight') }),
  z.object({
    type: z.literal('cs/execute'),
    action: ExecutableActionSchema,
    /** Fingerprint of the target as shown to the user; absent for scroll. */
    fingerprint: z.string().optional(),
  }),
]);
export type ToContentMessage = z.infer<typeof ToContentMessageSchema>;

/* Content script -> service worker */
export const ContentToBgMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content/stale') }),
]);
export type ContentToBgMessage = z.infer<typeof ContentToBgMessageSchema>;

/* Service worker -> side panel (broadcast) */
export const BgToUiMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bg/state'), state: PanelStateSchema }),
  z.object({ type: z.literal('bg/log'), entry: LogEntrySchema }),
  /** Something changed that is not one session's state (settings, a closed tab): re-read your state. */
  z.object({ type: z.literal('bg/refresh') }),
]);
export type BgToUiMessage = z.infer<typeof BgToUiMessageSchema>;

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export const SimpleContentResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);

/** Typed helper for UI pages. */
export async function sendToBackground<T = unknown>(msg: UiMessage): Promise<UiResponse<T>> {
  const parsed = UiMessageSchema.parse(msg);
  try {
    return (await chrome.runtime.sendMessage(parsed)) as UiResponse<T>;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
