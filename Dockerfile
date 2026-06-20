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

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV HIDOCK_STORAGE_PATH=/data

# Bring built artifacts and pruned node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Default storage volume
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# Tiny built-in healthcheck — no curl/wget needed
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
