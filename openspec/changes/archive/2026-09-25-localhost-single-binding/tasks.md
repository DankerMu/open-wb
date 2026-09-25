## Risk Packs
- Config — selected: exact `localhost` normalized; other values unchanged → 1.1, 2.1.
- Legacy compatibility — selected: default and all other HOST values unchanged; #227 tests unchanged → 2.3.
- Concurrency / ordering — selected: SIGTERM drain covers the only binding → 1.2, 2.2.
- Public API, Schema, File IO, Auth/secrets, Resource limits, Error handling, Release, Documentation — not selected: single config normalization; no doc names `localhost` as a deployment form.

## 1. Implementation
- [x] 1.1 `resolveHost`: exact `localhost` → `127.0.0.1`.
- [x] 1.2 Config unit cases + compiled-entry HOST=localhost test in `listener-shutdown.test.ts`.

## 2. Verification
- [x] 2.1 Config tests green; `LOCALHOST` and existing cases unchanged.
- [x] 2.2 Compiled-entry test green; RED on master shown once (record host `::1` on macOS, or `[::1]` connect succeeds).
- [x] 2.3 `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
