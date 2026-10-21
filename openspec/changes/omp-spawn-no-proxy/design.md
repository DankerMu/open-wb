# Design — omp-spawn-no-proxy (#1615)

## Governing invariant

Same as #1575: a workspace file that omp loads (`<cwd>/.env`) SHALL NOT be able to make the omp child send data off the server through a channel the host does not mediate. The spawn environment pins every variable that is a final switch for such a channel to a non-empty value, because omp's dotenv loader only fills variables that are unset or empty. Existing members: `PI_*` / `OMP_*` (#802), browser relay / cmux / proxy (#1529), OTLP (#1575). This change adds the model-request proxy path.

## Decisions

- **D1 — pin the exemption, not the proxy variables.** Bun's `fetch` takes any non-empty `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` as a proxy URL; there is no "direct" value like Chromium's `direct://`, and an empty pin is overwritten by dotenv (issue case B5). `no_proxy=*` makes every host exempt, so whatever proxy `.env` names is never used. `*` instead of a host list: no need to follow `models-yml.ts`'s host spellings (`127.0.0.1`, `[::1]`; the IPv6 list form is untested).
- **D2 — both cases.** Bun reads lowercase `no_proxy` first: with only `NO_PROXY=*` pinned, a `.env` line `no_proxy=example.invalid` fills the unset lowercase key and the proxy is used again (issue case B7). With `no_proxy=*` pinned, a `.env` `NO_PROXY=…` does not matter (B8). Pinning both covers implementations that read only uppercase. The real-omp case runs both mismatching-exemption variants.
- **D3 — preserve-list position.** `no_proxy,NO_PROXY` go after `OTEL_SDK_DISABLED` and before `PUPPETEER_EXECUTABLE_PATH`: the always-pinned group stays contiguous, the one conditional key stays last. sudo matches `--preserve-env` names case-sensitively and sudoers use `SETENV:` (ADR-0010, `deploy/app/Dockerfile:29`, `.github/scripts/ci-uid-isolation.sh:42-44`, `.github/scripts/ci-browser-image.sh:89`); `*` contains no `%` or `/`, so sudo's env checks keep it. No sudoers line changes.
- **D4 — real-binary proof on the pinned v18.12.3 with an in-repo negative control.** The control deletes both pins in a test-only spawn wrapper (as #1575's `launch(world, overlay, otelPin)` deletes `OTEL_SDK_DISABLED`) and keeps case (1)'s `.env`. The proxy listener records request lines and never forwards, so in the control the turn cannot complete: the control waits (bounded) for the first proxy request instead of `agent_end`, and the runtime is shut down in teardown. The five pinned cases wait for `agent_end` and assert the reply came from the fake upstream and the proxy saw nothing.
- **D5 — accepted side effect.** omp does not strip inherited variables from its child shells (`filterChildShellEnv` only removes keys that came from the project dotenv), so programs the assistant runs through bash / eval see `no_proxy=*` / `NO_PROXY=*` and tools that honour them (curl etc.) ignore any environment proxy. The host's closed whitelist never gave the child a proxy, so no existing deployment changes; recorded in the spec and system.md 9.8.
- **D6 — no other knob.** `PI_PROXY` (omp's own proxy, exempts loopback, `proxy.ts:24-66`) and the TLS variables are not on the plain-http model path; listed under the proposal's 不做.

## Sibling surfaces

- `server/src/sessions/omp/spawn-env.ts` (`ompSpawnEnv`, `SUDO_PRESERVE_ENV`) — the only definition; `process.ts` is the only spawn path.
- Tests that write the whitelist / preserve string literally (as in #1575): `server/test/omp-spawn-dotenv-pins.test.ts`, `omp-process.test.ts`, `omp-process-browser.test.ts`, `session-supervisor-helpers.ts`, `omp-state-layout.test.ts`, `server/test/linux/uid-isolation.test.ts` (required keys under sudo); `omp-official-overlay-pins.test.ts` (#1575's OTLP case asserts the env pin value, check it is unaffected).
- Docs: system.md 9.8 spawn-env pins paragraph; ADR-0012 `.env` entry notes (#1529 item).
- Not siblings: kbservice / office sidecar spawns (no omp, no `.env` loading); the model proxy itself (server side, not affected by the child's env).

## Not yet specified

- Whether omp makes any non-model request at startup that the control's proxy sees first (the THEN asks for at least one absolute-URI request to the fake upstream, so others are allowed).
