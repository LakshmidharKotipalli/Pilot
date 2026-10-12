#!/usr/bin/env node
/**
 * Local run-log collector for Pilot (development aid).
 *
 * The extension cannot write into a project folder, so while this server is running it POSTs every
 * activity-log row here and the server keeps one JSON file per run in ./logs (git-ignored).
 * Nothing is ever sent anywhere else; it listens on 127.0.0.1 only and accepts only requests that
 * come from a browser extension.
 *
 *   npm run logs            (default port 8787, folder ./logs)
 *   LOG_PORT=9000 LOG_DIR=/some/dir npm run logs
 */
import { createServer } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 256 * 1024;
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

/** @param {{ dir: string }} options */
export function createLogServer({ dir }) {
  /** runId -> { meta, entries: Map<entryId, entry> } */
  const runs = new Map();
  /** Serialises writes per run so a slow disk cannot reorder updates. */
  const chains = new Map();

  const fileFor = (runId, run) => {
    const day = new Date(run.meta.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const host = String(run.meta.host ?? 'unknown').replace(/[^a-z0-9.-]/gi, '_').slice(0, 60);
    return join(dir, `${day}_${host}_${runId.slice(0, 8)}.json`);
  };

  async function persist(runId) {
    const run = runs.get(runId);
    const file = fileFor(runId, run);
    const body = JSON.stringify({ ...run.meta, updatedAt: new Date().toISOString(), entries: [...run.entries.values()] }, null, 2);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file); // never leave a half-written file behind
    return file;
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? '';
    const fromExtension = typeof origin === 'string' && origin.startsWith('chrome-extension://');
    const cors = fromExtension
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {};
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain', ...cors });
      res.end(text);
    };

    if (req.method === 'OPTIONS') return send(fromExtension ? 204 : 403, '');
    if (!fromExtension) return send(403, 'Only browser extensions may post logs.'); // blocks web pages
    if (req.method !== 'POST' || req.url !== '/log') return send(404, 'POST /log');

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        send(413, 'Too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, 'Invalid JSON');
      }
      const entry = msg?.entry;
      const runId = entry?.runId;
      if (typeof runId !== 'string' || !RUN_ID.test(runId) || typeof entry?.id !== 'string') return send(400, 'Bad entry');

      let run = runs.get(runId);
      if (!run) {
        run = { meta: { runId, host: msg.host ?? null, prompt: entry.prompt ?? null, startedAt: Date.now() }, entries: new Map() };
        runs.set(runId, run);
      }
      run.entries.set(entry.id, entry); // an update replaces its row: one row per step
      const next = (chains.get(runId) ?? Promise.resolve()).then(() => persist(runId));
      chains.set(runId, next.catch(() => undefined));
      next.then(
        () => send(204, ''),
        (e) => send(500, String(e?.message ?? e)),
      );
    });
  });

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.LOG_PORT ?? 8787);
  const dir = resolve(process.env.LOG_DIR ?? 'logs');
  createLogServer({ dir }).listen(port, '127.0.0.1', () => {
    console.log(`Pilot log server: http://127.0.0.1:${port}/log  ->  ${dir}`);
  });
}
