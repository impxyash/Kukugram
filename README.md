# Kukugram

Kukugram is a TypeScript monorepo for a creator-first social platform. Phase 1 establishes a secure API, a dark-first Next.js shell, shared contracts, and a PostgreSQL migration foundation.

## Prerequisites

- Node.js 22+
- pnpm 10+ (Corepack is included with supported Node releases)
- Docker with Compose for local PostgreSQL and Redis

## Start locally

```bash
corepack pnpm install
cp .env.example .env
docker-compose --env-file .env -f infrastructure/containers/compose.yaml up -d
corepack pnpm db:migrate
corepack pnpm dev
```

Open `http://localhost:3000` for the web app, `http://localhost:3001/health` for API health, and `http://localhost:3001/documentation` for OpenAPI documentation.

## Checks

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Layout

- `apps/web`: Next.js consumer application.
- `apps/api`: Fastify modular-monolith API.
- `packages/domain`: shared schemas, types, configuration, and utilities.
- `packages/database`: Drizzle PostgreSQL schema and migrations.
- `packages/api-contract`: OpenAPI contract exports.
- `infrastructure/containers`: local dependency configuration.

Authentication is intentionally an architecture foundation only: password and OAuth provider secrets are configured through environment variables; no insecure or simulated sign-in is included.
