# OpenHiNotes-Bridge — Project Charter

A bare-bones WebUSB bridge for the HiDock P1. Salvaged from the WebUSB driver
inside [ghecko/OpenHiNotes](https://github.com/ghecko/OpenHiNotes) (Jordan OVRE's
project); the rest of that project (auth, DB, transcription, LLM, queue,
sharing) has been scrapped.

## 1. What this one thing must do

Provide a web UI that:

- Connects to a HiDock P1 over **WebUSB** (browser-driven; the device plugs
  into whatever machine has the browser open, not the server).
- Lists recordings on the device (filename, size, duration, date).
- Plays recordings inline.
- Deletes recordings from the device.
- Downloads recordings to the user's browser-local Downloads folder.
- **"Push to server"** — uploads a selection (or all) of the device's
  recordings to a server-side share at `$HIDOCK_STORAGE_PATH`.
- **"Process"** — triggers a configured external command
  (`$HIDOCK_PROCESS_CMD`) so the user's separate Python pipeline can pick
  the files up and do whatever it does. The Bridge does not know or care
  what that script does.

## 2. What would be wrong if shipped "working" without

- Real WebUSB working against a real HiDock P1 (list, download, delete must
  work end-to-end on actual hardware).
- Pushed recordings landing in `$HIDOCK_STORAGE_PATH` byte-for-byte intact
  (the .hda → .wav header repair logic from `deviceService.ts` must be
  preserved so server-side processing sees playable audio).
- The Process button actually spawning `$HIDOCK_PROCESS_CMD` and reporting
  its exit code back to the UI. A "fake" success that doesn't actually
  invoke the command is a failure.
- Everything runs inside **one** Docker container. Splitting backend/
  frontend/proxy into multiple containers is a failure.

## 3. Off-limits

- Any embedded transcription, LLM call, or speech-to-text inside this
  project. That's a separate concern handled by the user's external scripts.
- Any database (SQLite, Postgres, anything). State lives in env + filesystem.
- Multi-container deployments. No Caddy sidecar, no Postgres sidecar, no
  Redis. One image, one process.
- Server-side USB access. The Docker host does not need to see the device;
  the browser does the USB work.
- Embedded auth. Phase 2 will add auth; for now the user restricts to LAN
  at the reverse proxy (NPMPlus).
- Bundling a reverse proxy. NPMPlus is already in place; the container
  serves plain HTTP on a single port.

## 4. Deployment target & storage

- **Host:** Unraid box (SchmitzMegaplex).
- **Reverse proxy:** existing NPMPlus, which terminates HTTPS.
- **Image registry:** GHCR (`ghcr.io/teejs/openhinotes-bridge`). Workflow
  to publish it will be added in a follow-up.
- **Storage:** a single bind-mounted directory inside the container at the
  path given by env var `HIDOCK_STORAGE_PATH` (default `/data`). The user
  maps a host share path to that mountpoint at `docker run` time.
- **No backup of the container's own state needed** — the only state is
  the recordings under `$HIDOCK_STORAGE_PATH`, which lives on the host
  share and is the user's responsibility to back up via existing infra.

## 5. How we verify "done"

Manual verification against a real HiDock P1:

1. Container starts, web UI loads behind NPMPlus over HTTPS.
2. "Connect device" prompts the WebUSB picker; selecting the P1 connects.
3. The recordings list populates with filenames, sizes, durations.
4. Clicking a row plays the recording inline (audio element).
5. "Download" saves a playable `.wav` to the browser Downloads folder.
6. "Delete" removes the file from the device; the list refreshes without it.
7. "Push to server" uploads a recording; the file appears in
   `$HIDOCK_STORAGE_PATH` on the host and is byte-equivalent to the
   downloaded blob.
8. "Process" spawns `$HIDOCK_PROCESS_CMD`; the UI shows exit code and the
   tail of stdout/stderr.
9. After a container restart, all functionality returns; pushed recordings
   are still present in `$HIDOCK_STORAGE_PATH`.

## Architecture summary

```
+-- Single Docker container ------------------------------+
|  node:20-alpine                                         |
|                                                         |
|  Fastify (one process, one port — default 3000)         |
|   |                                                     |
|   +-- GET  /             -> Vite-built static SPA       |
|   +-- GET  /api/files    -> list files in storage       |
|   +-- POST /api/upload   -> multipart, writes to        |
|   |                          $HIDOCK_STORAGE_PATH       |
|   +-- POST /api/process  -> spawn $HIDOCK_PROCESS_CMD,  |
|   |                          stream stdout/stderr       |
|   +-- GET  /api/status   -> last process job state      |
|                                                         |
|  Bind mount: $HIDOCK_STORAGE_PATH                       |
+---------------------------------------------------------+
                          |
                       HTTP :3000
                          |
                      NPMPlus  (TLS termination, LAN restrict)
                          |
                      browser  --[ WebUSB ]-->  HiDock P1
```

## Phase 2 — One-button P1 sync (approved 2026-07-23)

**Goal:** press one button and have everything on the P1 copied to the server
share and deleted from the device — then hand the P1 back to HiNotes
automatically so meeting audio (incl. the P1↔earbud Bluetooth link) resumes
without the user remembering anything.

Non-negotiable criteria (user-stated):

1. **Data integrity is #1.** A file may be deleted from the P1 only after its
   copy on the server has been verified byte-for-byte (size + SHA-256, hashed
   server-side from disk). Any error at any step = no delete, file flagged,
   nothing lost. If this cannot be guaranteed, manual tab-switching wins.
2. **HiNotes must come back ≥99% of the time.** The browser extension restores
   the HiNotes tab unconditionally (success, failure, or hang — watchdog), so
   auto-record of meetings resumes. If this bar can't be met, manual wins.
3. Nice-to-have: trigger the sync from `/panel.html` (touch panel, different
   machine) — implemented via a server-side sync-request flag the extension
   polls.

Components:

- `/sync` page in the SPA — auto-connects, per-file download → upload →
  hash-verify → delete, reports status via `document.title`
  (`SYNC-RUNNING` / `SYNC-DONE` / `SYNC-FAILED` / `SYNC-NEEDS-ATTENTION`).
- Server: `GET /api/files/:name/hash` (size + SHA-256), and
  `POST|GET|DELETE /api/sync-request` (panel-button trigger, 10-min expiry).
- `extension/` — Chrome MV3 extension on the meeting PC: closes HiNotes
  tab(s) (and any connected OpenHiNotes SPA tab), opens `/sync?auto=1`,
  waits for the title verdict, then **always** closes the sync tab and
  reopens HiNotes. State persisted in `chrome.storage.session` so even a
  service-worker restart still restores HiNotes.
- `panel.html`: native `confirm()` dialogs replaced with a large
  touch-friendly in-page modal; "Sync P1" button posts a sync request.

Explicitly dropped for now: any change to the NPMPlus login behaviour
(needs more discussion).

## Salvaged from upstream

- `frontend/src/services/deviceService.ts` — entire HiDock USB protocol.
- `frontend/src/hooks/useDeviceConnection.ts` — thin React wrapper.
- 3 type interfaces from `frontend/src/types/index.ts`
  (`HiDockDevice`, `StorageInfo`, `AudioRecording`).

Everything else from the upstream repo was discarded.
