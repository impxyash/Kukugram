# ADR-001: pnpm modular monorepo

Kukugram uses a pnpm workspace with independently deployable applications and shared TypeScript packages. PostgreSQL migrations are committed SQL through Drizzle; schema synchronization is not used. The API is a Fastify modular monolith, leaving explicit domain seams for later extraction.
