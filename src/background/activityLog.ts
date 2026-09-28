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

export async function clearLog(): Promise<void> {
  cache = [];
  writeChain = writeChain.then(() => chrome.storage.local.set({ [STORAGE_KEYS.log]: [] }));
  await writeChain;
}
