# Single image running the whole app: Next.js + SSE + Yjs WebSocket (server.ts).

FROM node:22-bookworm-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies ----
FROM base AS deps
COPY package.json package-lock.json ./
# postinstall runs `prisma generate`, which needs the schema.
COPY prisma ./prisma
RUN npm ci

# ---- build ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM base AS runner
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# Keeps node_modules (tsx runs server.ts, prisma CLI runs migrations).
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000
# Apply pending migrations, then exec node so it receives SIGTERM directly
# (open boards are saved on shutdown).
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node --import tsx server.ts"]
