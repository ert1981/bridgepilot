# BridgePilot routing API (OpenSea Tools listing). Render free plan: Docker web service.
# Only the API is built and shipped; the testnet bridge protocol (contracts/, protocol/) is not in the image.
# All configuration (X402_PAY_TO, TOOL_CREATOR_ADDRESS, PUBLIC_BASE_URL, optional keys) comes from the
# host's environment at runtime, never from the image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.docker.json ./
COPY src ./src
COPY apps ./apps
RUN npx tsc -p tsconfig.docker.json

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    PROVIDER_MODE=live
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Optional durable storage: set STORAGE_PATH (e.g. /data/bridgepilot.sqlite) when a disk is mounted.
# On Render's free plan there is no disk, so leave it unset (in-memory records and payment nonces).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 10000
CMD ["node", "dist/apps/api/server.js"]
