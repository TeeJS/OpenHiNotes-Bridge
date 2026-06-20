# OpenHiNotes-Bridge

A bare-bones **WebUSB bridge for the HiDock P1**. Connects to the device in
your browser, lists recordings, plays them, downloads them, deletes them, and
pushes them to a server-side share where your own scripts can pick them up.

Single Docker container. No database. No transcription. No LLM. No auth (yet).

Salvaged from the WebUSB driver in
[ghecko/OpenHiNotes](https://github.com/ghecko/OpenHiNotes) (Jordan OVRE's
project); the rest of that project — auth, FastAPI backend, Postgres,
transcription queue, sharing — was scrapped on purpose.

## Architecture in one picture

```
                                +----- Docker container -----+
                                |  node:20-alpine            |
   Browser ----WebUSB----> P1   |  Fastify on :3000          |
       |                        |   ├── serves built SPA     |
       |  fetch /api/upload --->|   ├── POST /api/upload     |
       |                        |   ├── POST /api/process    |
       +-- HTTPS via NPMPlus ---|   └── GET  /api/files etc. |
                                |                            |
                                |  bind mount $HIDOCK_STORAGE_PATH (default /data)
                                +----------------------------+
                                            |
                                +-- your Python scripts on the host
                                    pick up files from the share
                                    (HIDOCK_PROCESS_CMD is whatever
                                     shell command starts that)
```

The browser does the WebUSB part (only it can). The container holds the SPA,
the upload endpoint, and a `Run process` button that spawns whatever shell
command you put in `HIDOCK_PROCESS_CMD`.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `HIDOCK_STORAGE_PATH` | `/data` | Directory where pushed recordings land (bind-mount this!) |
| `HIDOCK_PROCESS_CMD` | _(unset)_ | Shell command spawned by `POST /api/process`. Run from `$HIDOCK_STORAGE_PATH` |
| `HIDOCK_MAX_UPLOAD_BYTES` | `1073741824` | Max single-file upload size (1 GiB) |
| `LOG_LEVEL` | `info` | Fastify log level |

## Run it (local sanity check)

```bash
npm install
npm run build
HIDOCK_STORAGE_PATH=./_data \
HIDOCK_PROCESS_CMD='echo "would process files in $HIDOCK_STORAGE_PATH"; ls -la' \
  npm start
```

Open <http://localhost:3000>. WebUSB needs HTTPS or `localhost` — both work.

For hot-reload development:

```bash
npm run dev
```

That serves the client on <http://localhost:5173> with `/api/*` proxied to
the Fastify server on `:3000`.

## Build and run the container

```bash
docker build -t openhinotes-bridge:dev .

docker run -d --name openhinotes-bridge \
  -p 3000:3000 \
  -v /mnt/user/appdata/openhinotes-bridge:/data \
  -e HIDOCK_STORAGE_PATH=/data \
  -e HIDOCK_PROCESS_CMD='/scripts/process.sh' \
  openhinotes-bridge:dev
```

Put it behind your existing reverse proxy (NPMPlus) for HTTPS. WebUSB
requires a secure context.

> **The Process button** spawns `HIDOCK_PROCESS_CMD` with `cwd = $HIDOCK_STORAGE_PATH`
> and `HIDOCK_STORAGE_PATH` available in the child's env. It can be any
> shell command — `python3 /scripts/ingest.py`, `curl -X POST …`, whatever.
> If you need bigger scripts, either bake them into a derived image or
> bind-mount them at `/scripts`.

## API

| Method | Path | What |
|---|---|---|
| `GET` | `/api/health` | `{ ok, storage, processConfigured }` |
| `GET` | `/api/config` | client bootstrap config |
| `GET` | `/api/files` | files currently in `$HIDOCK_STORAGE_PATH` |
| `POST` | `/api/upload` | multipart upload (field name `file`), filename stays as-sent |
| `DELETE` | `/api/files/:name` | remove a file from the server share |
| `POST` | `/api/process` | spawn `HIDOCK_PROCESS_CMD` (one at a time) |
| `GET` | `/api/status` | state of the last/current process job |

## Project layout

```
.
├── client/        # Vite + React + TypeScript SPA
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── hooks/useDeviceConnection.ts
│       ├── services/deviceService.ts     # salvaged WebUSB protocol
│       └── types/index.ts
├── server/        # Fastify + tsx/tsc
│   ├── tsconfig.json
│   └── src/index.ts
├── Dockerfile
├── PROJECT.md     # charter
├── package.json
└── README.md
```

## What's deliberately missing

- Auth — front it with NPMPlus (LAN-only access list) until phase 2.
- A database — server state is just files in `$HIDOCK_STORAGE_PATH`.
- Transcription, LLM, summarization — handled by your external scripts.
- WebSockets / streaming logs — `/api/status` is polled; good enough.

## License

MIT (matches upstream OpenHiNotes).
