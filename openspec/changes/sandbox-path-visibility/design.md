# Design: sandbox-path-visibility (#386, ADR-0011)

Change surface: `web/e2e/ui-shots.mjs` (`assertAppDom`, `runState`); spec deltas (demo-parity-acceptance, workspaces, chat-stream, chat-web); two lines in the active parent delta; one server and one web unit test.

Must preserve:
- ui-shots: `probeOverflow` for every app state; console/pageerror oracle; STATES/CELLS matrix and file naming; demo source path; exit codes.
- files-web presentation rule and its tests (`root` never rendered in UI text/title/aria).
- Workspaces DTO five fields and web strict parse; audit event shape; step detail truncation/single-line rules.

Must add/change:
- `assertAppDom(page, state)`: `const leaks = state.startsWith("chat-") ? [] : await page.evaluate(probeRootLeaks, workspaceRoots);`. `workspaceRoots` is still collected in preflight (used for redaction of messages at `:70`).
- Spec wording per proposal; parent delta clause edited identically.

Governing invariant: absolute sandbox paths may reach the owner's browser through API data and chat content, but the non-chat UI surfaces (login, files, settings) never display a workspace root; ui-shots enforces exactly that split.

Sibling surfaces:
- Producers of browser-visible paths: workspaces DTO (`server/src/workspaces/store.ts` `toWorkspace`), audit (`store.ts` `workspace.create`), step detail (`server/src/sessions/events.ts` `summarize`), assistant text (model-controlled).
- Checks: ui-shots `probeRootLeaks` (this change narrows scope); files-web jsdom tests (unchanged); ui-walk (no root check).
- Specs that restate the rule: demo-parity-acceptance main + parent delta (body sentence and THEN clause); files-web (unchanged); chat-web Step cards (ADDED companion); ADR-0011.

Seams under test:
- ui-shots forward run against a locally started compiled server (same env shape as the CI ui-walk job + fake upstream), plus temporary DOM injections.
- `server/test/session-events.test.ts` mapper case; `web/test/chat-steps.test.tsx` step-card case.

Required evidence (recipe and injection method in tasks §2):
- E4 pre-change contrast, run first: original `assertAppDom` + root injected before the assertion in `chat-done` → chat-done cells fail. Shows the change is what exempts chat.
- E1 forward: `make ui-shots` against the locally started compiled server → exit 0, `截图 60/60，失败 0`, 60 PNG + index.html. Fake upstream only emits `echo workbuddy-smoke`, whose step detail carries no path, so E1 does not exercise the exemption; E2–E4 do.
- E2 chat exemption: same injection in `chat-done` with the change → exit 0, 60/60.
- E3 non-chat guard kept: same injection in `files-readme` → non-zero with `workspace root 绝对路径出现在 <body> title 属性` for that state; output and index.html do not contain the injected root value.
- Injection: temporary line in `runState` before `assertAppDom`, `document.body.title = workspaceRoots[0]` (attribute not managed by React, zero layout so no 390-width overflow noise — a text node would overflow narrow cells because long unhyphenated paths do not wrap; independent of appChatDone's first-cell early return). Reverted; `git diff --stat web/e2e` shows only 1.1.
- E5 unit pins: server mapper case (detail contains the path verbatim) and web chat-steps case (`原始输出` contains the path verbatim); `npm test --workspace server` / `--workspace web` exit 0.
Non-goals: a unit-test harness for ui-shots (none exists; the script is manual per the demo-parity spec); changing what the fake upstream emits.

Review focus:
1. Only the root-leak probe is scoped; overflow and console oracles still cover chat states.
2. The parent delta clause matches the MODIFIED requirement text exactly, so s1e's archive does not revert it.
3. Spec wording is consistent with ADR-0011 and does not loosen credential/owner-scope rules.
4. No product code changed.
