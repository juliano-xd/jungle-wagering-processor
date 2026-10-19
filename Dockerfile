# ─── Builder stage ───────────────────────────────────────────────────
FROM oven/bun:1.4.0-alpine AS builder

WORKDIR /app

# Copia manifestos primeiro para aproveitar cache de layers
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copia código e compila
COPY tsconfig.json tsconfig.build.json nest-cli.json mikro-orm.config.ts ./
COPY src ./src
RUN bunx nest build

# ─── Runtime stage ────────────────────────────────────────────────────
FROM oven/bun:1.4.0-alpine AS runtime

WORKDIR /app

# Non-root user (defesa em profundidade)
RUN addgroup -S app && adduser -S app -G app

# Copia apenas o necessário para runtime
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/mikro-orm.config.ts ./mikro-orm.config.ts
COPY --from=builder /app/src/infrastructure/database/migrations ./dist/src/infrastructure/database/migrations

# Troca para non-root
USER app

# Expõe a porta padrão (sobrescrevível via env)
EXPOSE 3000

# Healthcheck nativo do Docker (complementa o /health/ready do NestJS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/live || exit 1

# Executa o build de produção
CMD ["bun", "run", "dist/src/main.js"]
