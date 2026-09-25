## Why
#340 — `server/src/server.ts` `resolveHost` passes any nonempty HOST to `app.listen` unchanged (spec `http-service-skeleton` 服务启动与装配 "其它nonempty string原样交listen"). Fastify 5.12.1 treats exactly `'localhost'` specially (`node_modules/fastify/lib/server.js:74,110` → `multipleBindings`, dns.lookup all): it opens a secondary server per extra loopback address. PR #337's bounded listener shutdown (`server/src/app.ts` `registerListenerShutdown`) only wraps `app.server`; `app.close()` does not await the secondary (`fastify.js:418-423`, `lib/server.js:191-208` `secondaryServer.close(() => {})`). Measured in #340: a keep-alive request on the non-primary binding kept the process alive ~73 s after `app.close()` resolved, beyond the 10 s stop grace, and the DB may close while that request is in flight.

Deployment context (maintainer, #340 comment): target is LAN IP / wildcard single binding; `localhost` is not a target form. The fix removes the secondary binding at the source rather than extending the drain to Fastify's private `kServerBindings`.

## Triage
Issue type: bug
Fixture level: standard
Upstream suggested level: absent (standard: one config normalization + spec wording; startup/shutdown behaviour pinned by existing compiled-entry tests)
Blast radius: startup host resolution; a wrong change could alter binding for non-localhost hosts or break the startup record / models.yml derivation.
Selected risk packs: Config (HOST semantics change for one exact value); Legacy compatibility (all other HOST values byte-for-byte unchanged; default unchanged); Concurrency / ordering (shutdown drain covers the only binding).
Evidence floor: config unit tests; compiled-entry HOST=localhost test (single binding, record host, models.yml, `[::1]` refused, RED before); full suite, lint, typecheck, anti-drift.

## What Changes
- `server/src/server.ts` `resolveHost`: exact `"localhost"` → `"127.0.0.1"` (same as the default). No other value changes (`LOCALHOST`, `::1`, `0.0.0.0`, names, whitespace-bearing values keep current handling).
- `server/test/server-config.test.ts`: new cases — `HOST: "localhost"` resolves to `127.0.0.1`; `LOCALHOST` passes through unchanged; existing cases unchanged.
- Compiled-entry test in `server/test/listener-shutdown.test.ts` (533 lines, already imports `compileServerEntry`/`startCompiledServer`/`reserveWildcardPort`/`openPartialRequest`/`applicationStderr`; `server-startup-order.test.ts` is at 776/800): start with `HOST=localhost`; assert startup record host is exactly `127.0.0.1`, models.yml baseUrl `http://127.0.0.1:<port>/v1`, `127.0.0.1:<port>` connectable, and a connect to `[::1]:<port>` fails with any error (ECONNREFUSED where `::1` exists, EADDRNOTAVAIL/ENETUNREACH where it does not — no skip; macOS `lo0` and ubuntu-latest both have `::1`, so the check really runs). Then SIGTERM → clean exit 0. RED on master (deterministic, milliseconds): on macOS `dns.lookup('localhost')` yields `[::1, 127.0.0.1]`, so the record host is `::1`; where `127.0.0.1` is primary, `::1` still listens as secondary so the `[::1]` connect succeeds. Show the RED output once. Optional regression (not RED evidence): `openPartialRequest` to `127.0.0.1` across SIGTERM is force-closed within the #227 budget with the `listener_force_close` record — note its master behaviour depends on address order.
- Spec delta (MODIFIED 服务启动与装配).

Must preserve: default HOST `127.0.0.1`; validation of empty/whitespace; every non-`localhost` value passed through unchanged; models.yml baseUrl derivation for wildcard hosts; #227 listener shutdown tests; startup record shape.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `http-service-skeleton`: MODIFIED 服务启动与装配 — exact `localhost` normalized to `127.0.0.1` (single binding).

## Impact
`server/src/server.ts`, config + one compiled-entry test. Behaviour change only for `HOST=localhost` (IPv6 `::1` no longer bound in that mode; clients resolving `localhost` to `::1` first rely on Node ≥20 `autoSelectFamily`/happy-eyeballs fallback to `127.0.0.1`). Residual: `reserveWildcardPort` probes only `0.0.0.0`, so a foreign `::1` listener on the same port could make the `[::1]` check fail spuriously (low probability).
