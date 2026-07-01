# syntax=docker/dockerfile:1.7

# ---------- 1) build ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps with full devDeps for the build
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy sources
COPY tsconfig.json* ./
COPY client ./client
COPY server ./server

# Build client (Vite → dist/client) and server (tsc → dist/server)
RUN npm run build

# Prune to runtime deps only
RUN npm prune --omit=dev


# ---------- 2) runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# python3 runs server/scripts/process-meetings.py (the diarizer batch driver);
# docker-cli lets that script start/stop the meeting-diarizer container via a
# bind-mounted /var/run/docker.sock so the GPU is only loaded while a job runs.
# tzdata provides the zoneinfo db so timestamps use the local zone (below).
RUN apk add --no-cache python3 docker-cli tzdata

# Local timezone. Alpine/musl reads $TZ and /etc/localtime; installing tzdata
# plus this symlink is the Alpine equivalent of the Debian tzdata reconfigure
# (no dpkg-reconfigure/DEBIAN_FRONTEND on Alpine).
ENV TZ=America/Denver
RUN ln -fs /usr/share/zoneinfo/$TZ /etc/localtime

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV HIDOCK_STORAGE_PATH=/data
ENV HIDOCK_PROCESS_CMD="python3 /app/scripts/process-meetings.py"
ENV DIARIZER_URL="http://192.168.1.25:10301/transcribe"
ENV DIARIZER_OUTPUT_DIR=/output
ENV DIARIZER_THRESHOLD=0.35
ENV MEETING_DIARIZER_CONTAINER=meeting-diarizer

# Bring built artifacts and pruned node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY server/scripts ./scripts

# Default storage volume + diarizer output mountpoint
RUN mkdir -p /data /output
VOLUME ["/data", "/output"]

EXPOSE 3000

# Tiny built-in healthcheck — no curl/wget needed
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
