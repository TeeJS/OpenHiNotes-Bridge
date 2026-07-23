import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const STORAGE_PATH = process.env.HIDOCK_STORAGE_PATH ?? '/data';
const PROCESS_CMD = process.env.HIDOCK_PROCESS_CMD ?? '';
const MAX_UPLOAD_BYTES = Number(process.env.HIDOCK_MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024); // 1 GiB
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const here = path.dirname(fileURLToPath(import.meta.url));
// In production, dist/server/index.js sits next to dist/client/. In dev
// (tsx), server/src/index.ts → resolves up two levels to repo root then
// into dist/client/ — which only exists after `npm run build:client`.
const CLIENT_DIR = path.resolve(here, '../client');
const CLIENT_DIR_DEV = path.resolve(here, '../../dist/client');

type JobStatus = 'idle' | 'running' | 'success' | 'error';

interface JobState {
  id: string;
  status: JobStatus;
  command: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  pid: number | null;
}

const MAX_LOG_BYTES = 256 * 1024;
let currentJob: JobState = {
  id: '',
  status: 'idle',
  command: '',
  startedAt: null,
  completedAt: null,
  exitCode: null,
  stdout: '',
  stderr: '',
  pid: null,
};

function isSafeFilename(name: string): boolean {
  if (!name) return false;
  if (name.length > 255) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

async function ensureStoragePath(): Promise<void> {
  await fs.mkdir(STORAGE_PATH, { recursive: true });
}

async function pickClientDir(): Promise<string> {
  try {
    await fs.access(path.join(CLIENT_DIR, 'index.html'));
    return CLIENT_DIR;
  } catch {
    // Dev fallback
    return CLIENT_DIR_DEV;
  }
}

async function startServer(): Promise<void> {
  await ensureStoragePath();
  const clientDir = await pickClientDir();

  const app = Fastify({
    logger: { level: LOG_LEVEL },
    bodyLimit: 1024 * 1024, // JSON bodies — file uploads use multipart limits below
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 4,
    },
  });

  try {
    await fs.access(path.join(clientDir, 'index.html'));
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      decorateReply: false,
    });
    app.log.info({ clientDir }, 'serving static SPA');
  } catch {
    app.log.warn(
      { clientDir },
      'no built client found — run `npm run build:client` (or `npm run dev` for hot-reload)',
    );
  }

  // ---- API ----

  app.get('/api/health', async () => ({
    ok: true,
    storage: STORAGE_PATH,
    processConfigured: PROCESS_CMD.length > 0,
  }));

  app.get('/api/config', async () => ({
    storage: STORAGE_PATH,
    processConfigured: PROCESS_CMD.length > 0,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  }));

  app.get('/api/files', async () => {
    const entries = await fs.readdir(STORAGE_PATH, { withFileTypes: true });
    const out: Array<{ name: string; size: number; mtime: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(STORAGE_PATH, entry.name));
      out.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
    }
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return { files: out };
  });

  app.post('/api/upload', async (req, reply) => {
    const part = await req.file();
    if (!part) {
      return reply.code(400).send({ error: 'no file uploaded' });
    }

    const rawName = part.filename ?? '';
    const safeName = path.basename(rawName);
    if (!isSafeFilename(safeName)) {
      return reply.code(400).send({ error: `invalid filename: ${rawName}` });
    }

    const dest = path.join(STORAGE_PATH, safeName);
    const tmpDest = `${dest}.partial`;

    try {
      await pipeline(part.file, createWriteStream(tmpDest));
      if (part.file.truncated) {
        await fs.unlink(tmpDest).catch(() => {});
        return reply.code(413).send({ error: 'file exceeds max upload size' });
      }
      await fs.rename(tmpDest, dest);
      const stat = await fs.stat(dest);
      app.log.info({ file: safeName, size: stat.size }, 'uploaded');
      return { name: safeName, size: stat.size, mtime: stat.mtime.toISOString() };
    } catch (err) {
      await fs.unlink(tmpDest).catch(() => {});
      app.log.error({ err, file: safeName }, 'upload failed');
      return reply.code(500).send({ error: 'upload failed' });
    }
  });

  // Stream a single file from STORAGE_PATH. ?download=1 forces a "Save As"
  // disposition; without it the browser will inline-play known audio types.
  app.get<{ Params: { name: string }; Querystring: { download?: string } }>(
    '/api/files/:name',
    async (req, reply) => {
      const safeName = path.basename(req.params.name);
      if (!isSafeFilename(safeName)) {
        return reply.code(400).send({ error: 'invalid filename' });
      }
      const target = path.join(STORAGE_PATH, safeName);
      let stat;
      try {
        stat = await fs.stat(target);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reply.code(404).send({ error: 'not found' });
        throw err;
      }
      if (!stat.isFile()) return reply.code(404).send({ error: 'not a file' });

      const ext = path.extname(safeName).toLowerCase();
      const mime =
        ext === '.wav'  ? 'audio/wav'   :
        ext === '.mp3'  ? 'audio/mpeg'  :
        ext === '.m4a'  ? 'audio/mp4'   :
        ext === '.ogg'  ? 'audio/ogg'   :
        ext === '.flac' ? 'audio/flac'  :
        ext === '.json' ? 'application/json' :
        ext === '.txt'  ? 'text/plain'  :
        'application/octet-stream';

      reply.header('Content-Type', mime);
      reply.header('Content-Length', String(stat.size));
      if (req.query.download) {
        // RFC 5987 encoding handles names with spaces or non-ASCII characters.
        reply.header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        );
      }
      return reply.send(createReadStream(target));
    },
  );

  // Size + SHA-256 of a stored file, hashed from disk. The /sync page uses
  // this to prove a pushed copy is byte-identical before deleting the
  // original from the device (data-integrity criterion #1 in PROJECT.md).
  app.get<{ Params: { name: string } }>('/api/files/:name/hash', async (req, reply) => {
    const safeName = path.basename(req.params.name);
    if (!isSafeFilename(safeName)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const target = path.join(STORAGE_PATH, safeName);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return reply.code(404).send({ error: 'not found' });
      throw err;
    }
    if (!stat.isFile()) return reply.code(404).send({ error: 'not a file' });

    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) {
      hash.update(chunk as Buffer);
    }
    return { name: safeName, size: stat.size, sha256: hash.digest('hex') };
  });

  app.delete<{ Params: { name: string } }>('/api/files/:name', async (req, reply) => {
    const safeName = path.basename(req.params.name);
    if (!isSafeFilename(safeName)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const target = path.join(STORAGE_PATH, safeName);
    try {
      await fs.unlink(target);
      return { ok: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return reply.code(404).send({ error: 'not found' });
      app.log.error({ err, file: safeName }, 'delete failed');
      return reply.code(500).send({ error: 'delete failed' });
    }
  });

  app.post<{ Body?: { threshold?: number; files?: string[] } }>('/api/process', async (req, reply) => {
    if (!PROCESS_CMD) {
      return reply.code(412).send({
        error: 'HIDOCK_PROCESS_CMD is not configured. Set this env var to a shell command and restart.',
      });
    }
    if (currentJob.status === 'running') {
      return reply.code(409).send({ error: 'a job is already running', job: jobView() });
    }

    // Optional per-run overrides. Validated here so a bad value fails fast at
    // the API boundary instead of getting silently passed through to the script.
    const extraEnv: Record<string, string> = {};
    const body = req.body ?? {};
    if (body.threshold !== undefined) {
      const t = Number(body.threshold);
      if (!Number.isFinite(t) || t < 0.1 || t > 0.9) {
        return reply.code(400).send({
          error: `threshold must be a number between 0.1 and 0.9 (got ${body.threshold})`,
        });
      }
      extraEnv.DIARIZER_THRESHOLD = String(t);
    }

    // Optional explicit work list. When present, the script processes only
    // these files instead of every *.wav. Each name is validated with the same
    // safety check as the download/delete endpoints, and must exist on disk, so
    // nothing unsafe or bogus reaches the spawned shell command.
    if (body.files !== undefined) {
      if (!Array.isArray(body.files)) {
        return reply.code(400).send({ error: 'files must be an array of filenames' });
      }
      const validated: string[] = [];
      for (const raw of body.files) {
        if (typeof raw !== 'string') {
          return reply.code(400).send({ error: `each file must be a string (got ${typeof raw})` });
        }
        const safeName = path.basename(raw);
        if (safeName !== raw || !isSafeFilename(safeName) || /[\r\n]/.test(safeName)) {
          return reply.code(400).send({ error: `invalid filename: ${raw}` });
        }
        try {
          const st = await fs.stat(path.join(STORAGE_PATH, safeName));
          if (!st.isFile()) {
            return reply.code(400).send({ error: `not a file: ${safeName}` });
          }
        } catch {
          return reply.code(404).send({ error: `file not found: ${safeName}` });
        }
        validated.push(safeName);
      }
      // Empty list → leave HIDOCK_FILES unset so the script falls back to all
      // files (the client disables the button at 0 selected, so this is just
      // defensive).
      if (validated.length > 0) {
        extraEnv.HIDOCK_FILES = JSON.stringify(validated);
      }
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentJob = {
      id,
      status: 'running',
      command: PROCESS_CMD,
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      pid: null,
    };

    const child = spawn(PROCESS_CMD, {
      shell: true,
      cwd: STORAGE_PATH,
      env: { ...process.env, HIDOCK_STORAGE_PATH: STORAGE_PATH, ...extraEnv },
    });

    currentJob.pid = child.pid ?? null;

    const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
      const cur = currentJob[key];
      const next = cur + chunk.toString('utf8');
      currentJob[key] = next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
    };

    child.stdout.on('data', (c: Buffer) => append('stdout', c));
    child.stderr.on('data', (c: Buffer) => append('stderr', c));
    child.on('error', (err) => {
      app.log.error({ err }, 'process spawn error');
      currentJob.status = 'error';
      currentJob.stderr += `\n[spawn error] ${err.message}\n`;
      currentJob.completedAt = new Date().toISOString();
    });
    child.on('close', (code) => {
      currentJob.exitCode = code;
      currentJob.status = code === 0 ? 'success' : 'error';
      currentJob.completedAt = new Date().toISOString();
      app.log.info({ id, code }, 'process finished');
    });

    return reply.code(202).send({ job: jobView() });
  });

  app.get('/api/status', async () => ({ job: jobView() }));

  // ---- Sync request (panel → extension handoff) ----
  // The touch panel can't reach the meeting PC directly, so the "Sync P1"
  // button just raises a flag here; the browser extension on the meeting PC
  // polls it every ~30 s, claims it with DELETE, and starts the sync.
  // Requests expire after 10 minutes so a press made while the meeting PC is
  // off doesn't fire a surprise sync hours later.
  const SYNC_REQUEST_TTL_MS = 10 * 60 * 1000;
  let syncRequestedAt: number | null = null;

  const syncRequestView = () => {
    if (syncRequestedAt !== null && Date.now() - syncRequestedAt > SYNC_REQUEST_TTL_MS) {
      syncRequestedAt = null; // expired
    }
    return {
      pending: syncRequestedAt !== null,
      requestedAt: syncRequestedAt === null ? null : new Date(syncRequestedAt).toISOString(),
    };
  };

  app.post('/api/sync-request', async () => {
    syncRequestedAt = Date.now();
    app.log.info('sync requested');
    return { ok: true, ...syncRequestView() };
  });

  app.get('/api/sync-request', async () => syncRequestView());

  app.delete('/api/sync-request', async () => {
    const claimed = syncRequestView().pending;
    syncRequestedAt = null;
    if (claimed) app.log.info('sync request claimed');
    return { ok: true, claimed };
  });

  app.setNotFoundHandler(async (req, reply) => {
    // SPA fallback: serve index.html for any non-/api/* GET that isn't an asset
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      try {
        const html = await fs.readFile(path.join(clientDir, 'index.html'), 'utf8');
        return reply.type('text/html').send(html);
      } catch {
        return reply.code(404).send({ error: 'client not built' });
      }
    }
    return reply.code(404).send({ error: 'not found' });
  });

  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    { port: PORT, host: HOST, storage: STORAGE_PATH, processConfigured: PROCESS_CMD.length > 0 },
    'OpenHiNotes-Bridge ready',
  );
}

function jobView(): JobState {
  return { ...currentJob };
}

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
