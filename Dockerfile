# syntax=docker/dockerfile:1
# Self-hosted image: Next.js standalone output behind Caddy (see docker-compose.prod.yml, docs/DEPLOY-AWS.md).
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-only placeholders: the build never contacts the database. Real values arrive at runtime.
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
# Inline on the RUN line (not ENV) so the placeholders never land in image metadata.
RUN DATABASE_URL=postgresql://build:build@localhost/build \
    BETTER_AUTH_SECRET=build-only-secret-build-only-secret-build-only \
    BETTER_AUTH_URL=http://localhost:3000 \
    npm run build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
