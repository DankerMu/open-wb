# Design — omp-spawn-otel-pin (#1575)

## Governing invariant

A workspace file that omp loads (`<cwd>/.env`) SHALL NOT be able to make the omp child send data off the server through a channel the host does not mediate. The spawn environment pins every variable that is a final switch for such a channel to a non-empty value, because omp's dotenv loader only fills variables that are unset or empty (`packages/utils/src/env.ts`, `!Bun.env[key]`). Existing members: `PI_*` / `OMP_*` config redirection (#802), browser relay / cmux / proxy (#1529). This change adds OTLP telemetry.

## Decisions

- **D1 — one switch, not three.** `OTEL_SDK_DISABLED=true` (checked by `initTelemetryExport` before any signal is resolved) instead of `OTEL_{TRACES,LOGS,METRICS}_EXPORTER=none`: one key, and a future signal added upstream is covered without a host change.
- **D2 — keep the overlay pin.** `telemetry.otlpExportEnabled: false` stays (#1564). The two are independent on v18.12.3 (`!exportEnabled || OTEL_SDK_DISABLED`); the env pin covers a future omp that drops or renames the setting, the overlay pin covers a future omp that ignores the OTel env convention. Each is proven alone by the real-omp case: configuration 2 drops the overlay block (env pin alone), configuration 3 drops the env key (overlay pin alone); configuration 4 drops both (negative control).
- **D3 — preserve-list position.** `OTEL_SDK_DISABLED` goes after `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` and before `PUPPETEER_EXECUTABLE_PATH`: the always-pinned group stays contiguous, the one conditional key stays last. Deployers' sudoers use `SETENV:` (ADR-0010, `deploy/app/Dockerfile:29`, `.github/scripts/ci-uid-isolation.sh:42-44`, `.github/scripts/ci-browser-image.sh:89`), so no sudoers line changes.
- **D4 — real-binary proof uses the pinned v18.12.3 only.** The issue asked for v18.0.10; that version is no longer pinned (`scripts/omp-fetch.sh`), and the brew binary is not a target. The negative control is in-repo (test-only spawn wrapper deletes the key, test-only overlay variant drops the `telemetry:` block — same mechanism as the browser relay case in omp-runtime and the overlay-pin probes of #1570).
- **D5 — observation window, not shutdown.** The host's shutdown never flushes: `#runRetire` closes stdin, v18.12.3 `modes/rpc/rpc-mode.ts:2686-2701` then `disposeAndExit` and `process.exit(0)` (`:1737`); the `exit` cleanup in `packages/utils/src/postmortem.ts` is fire-and-forget, so `provider.shutdown()`'s HTTP export cannot finish. Requests only leave while the process lives: BatchSpanProcessor, BatchLogRecordProcessor (logs from `registerProviders`' log sink), PeriodicExportingMetricReader, and omp's own 30 s `flushTelemetryExport` (`telemetry-export-otlp.ts:51,191-194`). So every configuration keeps the child alive after `agent_end` for the same bounded window and asserts before shutdown (as `omp-official-overlay-pins.test.ts`'s `launch()` does: shutdown only in teardown). All four `.env` files carry the same short batch delays (`OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BLRP_SCHEDULE_DELAY`, `OTEL_METRIC_EXPORT_INTERVAL`, e.g. 500 ms) so the four differ only in the two pins; the window is one constant shared by all four configurations, at least 5 s, and checked to be at least twice the control's recorded time to first request. If the SDK ignores the short delays, the window falls back to 35 s (covers omp's 30 s flush); the implementer records which applied.
- **D6 — accepted side effect.** omp does not strip inherited `OTEL_*` from its child shells (`filterChildShellEnv` only removes keys that came from the project dotenv), so programs the assistant runs through bash / eval see `OTEL_SDK_DISABLED=true` and a workspace program that uses the OTel SDK stops exporting. Same class as `PUPPETEER_PROXY=direct://` reaching child shells (#1529); accepted, recorded in system.md 9.8.

## Sibling surfaces

- `server/src/sessions/omp/spawn-env.ts` (`ompSpawnEnv`, `SUDO_PRESERVE_ENV`) — the only definition; `process.ts` is the only spawn path (`runtime.ts` goes through `OmpProcess`).
- Tests that write the whitelist / preserve string literally: `server/test/omp-spawn-dotenv-pins.test.ts`, `omp-process.test.ts`, `omp-process-browser.test.ts`, `session-supervisor-helpers.ts`, `omp-state-layout.test.ts` (check), `server/test/support/omp-official.ts` (pin-drop flags), `server/test/linux/uid-isolation.test.ts` (required keys under sudo).
- Docs: ADR-0012 `:138` (overlay telemetry pin rationale), system.md 9.8 `:452` (spawn env pins paragraph) and `:533` (overlay pin table).
- Not siblings: kbservice / office sidecar spawns (no omp, no `.env` loading).

## Not yet specified

- Whether v18.12.3 exports anything for a single short turn before shutdown (D5 decides the control's wait).
