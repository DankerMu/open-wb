# Project Profile: open-workbuddy

Profile base: Generic, specialized for a Node/TypeScript app-server, React SPA, and Python kb-service. This is a living Phase 0.5 artifact.

## Entry surfaces
- app-server: Fastify assembly, REST routes, startup CLI, static SPA fallback.
- web: Vite browser entry, route shell, API client, Playwright walk.
- kb-service: Python package and future HTTP API.
- operator: Make targets, GitHub Actions, hurl smoke.

## Contracts
- HTTP errors use one JSON envelope; server/web/smoke must agree on fields and status semantics.
- SQLite migrations and persisted auth/session rows must remain deterministic and backward-compatible.
- Module imports follow `http -> feature -> core`; services share only network contracts.
- Sandbox, credentials, tenant isolation, and audit invariants come from `AGENTS.md` and `CONTEXT.md`.

## Risk axes
- Public HTTP/CLI behavior, auth/session state, SQLite schema/migrations, static/file paths.
- Process lifecycle, async ordering, persisted/shared state, and server/web contract drift.
- Credentials and private deployment data must not enter source, logs, artifacts, or child environments.

## Typical evidence
- Fastify `app.inject()` and direct public-seam Vitest tests with real in-memory/temp SQLite.
- Real process plus hurl for HTTP; Playwright plus zero browser-console errors for UI.
- Schema/version queries, negative auth cases, compatibility assertions, and full repository gates.

## Command entry points
- Setup: `make setup`; full gate: `make check`; guard self-test: `make test-guardrails`.
- Focused: `npm test --workspace server`, `npm test --workspace web`, `cd kbservice && uv run pytest`.
- Static/type/drift: `make lint`, `make typecheck`, `make anti-drift`.

## Verification matrix
- TypeScript source/tests/config -> `make lint && make typecheck` -> exit 0.
- Server behavior/SQLite/HTTP -> `npm test --workspace server` -> exit 0 and server coverage >=80%.
- Web behavior -> `npm test --workspace web` -> exit 0 and web coverage >=80%.
- Python behavior -> `cd kbservice && uv run pytest` -> exit 0 and coverage >=80%.
- Cross-repository compatibility -> `make check` -> exit 0.
- Guard/control-plane changes -> `make test-guardrails` plus the affected Make/CI command -> all PASS.
- HTTP runtime or static fallback -> `make smoke` once available; until then review plus `app.inject()` evidence.
- Browser UI -> `make ui-walk` once available; until then review plus Vitest/jsdom evidence.

## Domain risk packs
- Tenant/sandbox isolation; auth/session lifecycle; process and child-environment isolation.
- Server/web HTTP-envelope compatibility; SQLite migration/seed compatibility; offline deployability.

## Domain expanded triggers
- Fastify assembly/routes/hooks, session cookies/TTL, SQLite migrations/seed, sandbox or static paths.
- Process spawn/listen/shutdown, cross-service contracts, smoke/UI harness, CI/production configuration.
