import { LOG_LIMIT, STORAGE_KEYS } from '../shared/constants';
import { redactText, truncate } from '../shared/redaction';
import { LogEntrySchema, type LogEntry } from '../shared/schemas';

let cache: LogEntry[] | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<LogEntry[]> {
  if (cache) return cache;
  const raw = (await chrome.storage.local.get(STORAGE_KEYS.log))[STORAGE_KEYS.log];
  const parsed = Array.isArray(raw)
    ? raw.flatMap((r) => {
        const p = LogEntrySchema.safeParse(r);
        return p.success ? [p.data] : [];
      })
    : [];
  cache = parsed;
  return cache;
}

export async function getLog(): Promise<LogEntry[]> {
  return [...(await load())];
}

/** Append an auditable entry. All free text is redacted and length-limited before it is stored. */
export async function appendLog(
  entry: Omit<LogEntry, 'id' | 'ts'> & Partial<Pick<LogEntry, 'id' | 'ts'>>,
): Promise<LogEntry> {
  const full: LogEntry = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    ts: entry.ts ?? Date.now(),
    prompt: entry.prompt ? truncate(redactText(entry.prompt), 500) : null,
    actionSummary: truncate(redactText(entry.actionSummary), 400),
    target: entry.target ? truncate(redactText(entry.target), 200) : null,
    detail: entry.detail ? truncate(redactText(entry.detail), 500) : null,
  };
  writeChain = writeChain.then(async () => {
    const list = await load();
    list.push(full);
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    await chrome.storage.local.set({ [STORAGE_KEYS.log]: list });
  });
  await writeChain;
  return full;
}

/**
 * Create or update one entry by id. A step is one row whose outcome advances in place
 * (proposed, approved, executed...) instead of a new row per stage. The original timestamp is kept.
 */
export async function upsertLog(
  entry: Omit<LogEntry, 'ts'> & Partial<Pick<LogEntry, 'ts'>>,
): Promise<LogEntry> {
  const clean = {
    prompt: entry.prompt ? truncate(redactText(entry.prompt), 500) : null,
    actionSummary: truncate(redactText(entry.actionSummary), 400),
    target: entry.target ? truncate(redactText(entry.target), 200) : null,
    detail: entry.detail ? truncate(redactText(entry.detail), 500) : null,
  };
  let saved: LogEntry | null = null;
  writeChain = writeChain.then(async () => {
    const list = await load();
    const i = list.findIndex((e) => e.id === entry.id);
    saved = { ...entry, ...clean, ts: i >= 0 ? list[i]!.ts : (entry.ts ?? Date.now()) };
    if (i >= 0) list[i] = saved;
    else list.push(saved);
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    await chrome.storage.local.set({ [STORAGE_KEYS.log]: list });
  });
  await writeChain;
  return saved!;
}

export async function clearLog(): Promise<void> {
  cache = [];
  writeChain = writeChain.then(() => chrome.storage.local.set({ [STORAGE_KEYS.log]: [] }));
  await writeChain;
}
