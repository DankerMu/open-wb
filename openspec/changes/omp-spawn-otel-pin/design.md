# Design — omp-spawn-otel-pin (#1575)

## Governing invariant

A workspace file that omp loads (`<cwd>/.env`) SHALL NOT be able to make the omp child send data off the server through a channel the host does not mediate. The spawn environment pins every variable that is a final switch for such a channel to a non-empty value, because omp's dotenv loader only fills variables that are unset or empty (`packages/utils/src/env.ts`, `!Bun.env[key]`). Existing members: `PI_*` / `OMP_*` config redirection (#802), browser relay / cmux / proxy (#1529). This change adds OTLP telemetry.

## Decisions

- **D1 — one switch, not three.** `OTEL_SDK_DISABLED=true` (checked by `initTelemetryExport` before any signal is resolved) instead of `OTEL_{TRACES,LOGS,METRICS}_EXPORTER=none`: one key, and a future signal added upstream is covered without a host change.
- **D2 — keep the overlay pin.** `telemetry.otlpExportEnabled: false` stays (#1564). The two are independent on v18.12.3 (`!exportEnabled || OTEL_SDK_DISABLED`); the env pin covers a future omp that drops or renames the setting, the overlay pin covers a future omp that ignores the OTel env convention. Both are proven separately by the real-omp case (configuration 2 removes the overlay block; the negative control removes both).
- **D3 — preserve-list position.** `OTEL_SDK_DISABLED` goes after `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` and before `PUPPETEER_EXECUTABLE_PATH`: the always-pinned group stays contiguous, the one conditional key stays last. Deployers' sudoers use `SETENV:` (ADR-0010, `deploy/app/Dockerfile:29`, `.github/scripts/ci-uid-isolation.sh:42-44`), so no sudoers line changes.
- **D4 — real-binary proof uses the pinned v18.12.3 only.** The issue asked for v18.0.10; that version is no longer pinned (`scripts/omp-fetch.sh`), and the brew binary is not a target. The negative control is in-repo (test-only spawn wrapper deletes the key, test-only overlay variant drops the `telemetry:` block — same mechanism as the browser relay case in omp-runtime and the overlay-pin probes of #1570).
- **D5 — liveness of the negative control.** OTLP exporters batch; the negative control waits, bounded, for the first request after the turn or after shutdown (omp flushes on shutdown). If v18.12.3 only flushes on an interval longer than a reasonable test bound, the implementer reports it and the fixture is revised (e.g. a shorter `OTEL_BSP_SCHEDULE_DELAY` in the `.env` of the control only) — no unbounded waits.

## Sibling surfaces

- `server/src/sessions/omp/spawn-env.ts` (`ompSpawnEnv`, `SUDO_PRESERVE_ENV`) — the only definition; `process.ts` is the only spawn path (`runtime.ts` goes through `OmpProcess`).
- Tests that write the whitelist / preserve string literally: `server/test/omp-spawn-dotenv-pins.test.ts`, `omp-process.test.ts`, `omp-process-browser.test.ts`, `session-supervisor-helpers.ts`, `omp-state-layout.test.ts` (check), `server/test/support/omp-official.ts` (pin-drop flags), `server/test/linux/uid-isolation.test.ts` (required keys under sudo).
- Docs: ADR-0012 `:138` (overlay telemetry pin rationale), system.md 9.8 `:452` (spawn env pins paragraph) and `:533` (overlay pin table).
- Not siblings: kbservice / office sidecar spawns (no omp, no `.env` loading).

## Not yet specified

- Whether v18.12.3 exports anything for a single short turn before shutdown (D5 decides the control's wait).
