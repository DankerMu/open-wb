## Risk Packs
- Public API / CLI / script entry — selected: `make ui-shots` per-state behavior → 1.1, 2.1–2.5.
- Documentation / migration notes — selected: four spec surfaces + parent delta aligned with ADR-0011 → 1.2, 1.3, 2.7.
- Legacy compatibility — selected: overflow/console checks, matrix, DTO shape, files-web presentation tests unchanged; no product code → 2.5–2.7.
- Config, Schema, File IO/path safety, Auth/secrets, Concurrency, Resource limits, Error handling, Release — not selected: no config/schema/IO change; Auth/secrets explicitly unchanged (ADR-0011 keeps credentials/owner scope secret; no API change).

## 1. Implementation
- [x] 1.1 `web/e2e/ui-shots.mjs`: `assertAppDom(page, state)` skips `probeRootLeaks` for `chat-*` states; `runState` passes `state`; comment cites ADR-0011.
- [x] 1.2 Spec deltas in this change (already drafted): demo-parity-acceptance MODIFIED (body sentence and THEN clause both split overflow vs root-leak); workspaces ADDED; chat-stream ADDED; chat-web ADDED.
- [x] 1.3 Parent delta `openspec/changes/s1e-frontend-parity/specs/demo-parity-acceptance/spec.md` (body sentence :6 and THEN clause :10): identical new wording; the `ui-shots 截图对产物` block in parent and this change are byte-identical, and differ from main only in those two lines.
- [x] 1.4 `server/test/session-events.test.ts`: verbatim absolute-path detail case.
- [x] 1.5 `web/test/chat-steps.test.tsx`: done step with `{"path":"/srv/workbuddy/sandbox/u1/demo/a.md"}` detail → `原始输出` `<details>` text contains the path verbatim; summary `path: /srv/workbuddy/sandbox/u1/demo/a.md`.

## 2. Verification
Local ui-shots recipe (CI does not run ui-shots; all state in a fresh `mktemp -d` dir `$T` under the session scratch dir; ports 18017/19017):
1. `npx playwright install chromium` (ui-shots does not download a browser), then `npm run build --workspace web && npm run build --workspace server && make omp-fetch`.
2. `mkdir -p "$T/sandbox/u1" && cp -R smoke/fixtures/sandbox/u1/. "$T/sandbox/u1/"`.
3. `FAKE_UPSTREAM_PORT=19017 node server/test/support/fake-upstream.mjs >"$T/upstream.log" 2>&1 &` and wait until the log contains `"port":19017`.
4. `HOST=127.0.0.1 PORT=18017 DB_PATH="$T/app.db" STATIC_ROOT="$PWD/web/dist" OMP_BIN="$PWD/var/omp/omp" OMP_STATE_DIR="$T/omp-state" SANDBOX_ROOT="$T/sandbox" MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:19017/v1 MODEL_UPSTREAM_API_KEY=fake node server/dist/server.js >"$T/server.log" 2>&1 &` and wait for `curl -fsS http://127.0.0.1:18017/api/healthz`.
5. `make ui-shots UI_SHOTS_BASE_URL=http://127.0.0.1:18017 UI_SHOTS_OUT="$T/shots-<label>"`; record exit code and the `截图 N/60，失败 M` line.
6. E1 runs against its own fresh `$T` and server pair (fresh DB, per the `六格产物齐全` WHEN); E2–E4 may share another server pair (each run's first chat-done cell creates a new session). Kill every started process when done.

Injection method (temporary, never committed): in `runState`, immediately before the `assertAppDom` call, add `if (source === "app" && state === "<target>") await page.evaluate((r) => { document.body.title = r; }, workspaceRoots[0]);` — sets a `title` attribute on `<body>` (React does not manage body attributes, so no re-render drops it; it takes no layout, so `probeOverflow` is unaffected at 390 width; `probeRootLeaks` walks `querySelectorAll("*")`, which includes `<body>`). It runs for every cell (appChatDone's first-cell early return is irrelevant because this is in `runState`). The expected hit message is `workspace root 绝对路径出现在 <body> title 属性`.

- [x] 2.1 E4 first (pre-change contrast, before 1.1 is applied or with 1.1 temporarily reverted): injection target `chat-done` + original `assertAppDom` → non-zero, chat-done cells fail with `workspace root 绝对路径出现在 <body> title 属性` and no overflow message.
- [x] 2.2 E1 forward (1.1 applied, no injection): exit 0, `截图 60/60，失败 0`, 60 PNG + index.html. The fake upstream only emits `echo workbuddy-smoke`, so E1 alone cannot prove the exemption — E2–E4 do.
- [x] 2.3 E2 chat exemption: injection target `chat-done` with 1.1 → exit 0, 60/60.
- [x] 2.4 E3 non-chat guard kept: injection target `files-readme` with 1.1 → non-zero, files-readme cells fail with `workspace root 绝对路径出现在 <body> title 属性` (no overflow message), all other cells shot; grep the stdout/stderr and `index.html` for the injected root value → no match (failure output does not echo it).
- [x] 2.5 All injections reverted; `git diff --stat web/e2e` shows only the 1.1 change.
- [x] 2.6 E5 `npm test --workspace server` and `npm test --workspace web` exit 0 with the new cases; RED claim not required (behavior already verbatim; the tests pin it).
- [x] 2.7 `openspec validate sandbox-path-visibility --strict --no-interactive` and `openspec validate s1e-frontend-parity --strict --no-interactive` pass; `make lint`, `make typecheck`, `make anti-drift` exit 0.
