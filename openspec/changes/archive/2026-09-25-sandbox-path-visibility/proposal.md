## Why
#386 — decision recorded 2026-09-25 (issue comment) and in `docs/adr/0011-sandbox-paths-not-browser-secret.md` (PR #394): absolute sandbox paths are not a browser secret, so all three channels choose option A — the workspaces DTO `root`, the `workspace.create` audit `detail.root`, and chat step detail are kept verbatim; UI presentation keeps logical `<account>/<dir>` paths (#292). What remains is to make the specs say so and to align the one check that currently contradicts it: `web/e2e/ui-shots.mjs:389-407` (`probeRootLeaks` inside `assertAppDom`, called for every app state at `:488`) fails any shot — including `chat-done` — whose DOM text contains a workspace root, which the demo-parity-acceptance spec repeats ("截图前 DOM 含 workspace `root` 值…时非零", `openspec/specs/demo-parity-acceptance/spec.md:11`, and the active parent delta `openspec/changes/s1e-frontend-parity/specs/demo-parity-acceptance/spec.md:10`). Under ADR-0011 a chat shot showing tool output with a path is legitimate; the check guards the presentation rule on the non-chat pages only.

## Triage
Issue type: refactor (spec alignment + harness scope)
Fixture level: expanded
Upstream suggested level: absent (expanded: touches the ui-shots UI harness script — a project expanded-trigger — and the acceptance spec that gates #301's sign-off; the change itself is small)
Blast radius: `make ui-shots` pass/fail for #301 sign-off; a wrong scope would either keep failing chat shots or stop guarding files/settings/login shots.
Selected risk packs: Public API / script entry (`make ui-shots` behavior per state); Documentation / migration notes (four spec surfaces plus the active parent delta must agree with ADR-0011); Legacy compatibility (overflow checks and all other ui-shots behavior unchanged; server/web product code unchanged).
Evidence floor: local `make ui-shots` forward run exit 0 with 60 PNGs + index.html (CI does not run it); temporary injection mutations (see tasks); a server unit test pinning verbatim path in detail; `npm test --workspace server`, `make lint`, `make typecheck`, `make anti-drift` exit 0.

## What Changes
- `web/e2e/ui-shots.mjs`: `assertAppDom(page, state)` runs `probeRootLeaks` only for non-chat states (`!state.startsWith("chat-")`); `probeOverflow` still runs for every app state; `runState` passes `state`. Header/comment updated to cite ADR-0011.
- Specs (this change): demo-parity-acceptance MODIFIED `ui-shots 截图对产物` (root-leak clause limited to non-chat states); workspaces ADDED `绝对 root 不属于对浏览器保密的信息`; chat-stream ADDED `步骤 detail 不做路径改写`; chat-web ADDED `步骤卡原始输出不做路径改写` (ADR-0011 Consequences names chat-web; the existing Step cards sentence requires full raw detail but says nothing about paths). The demo-parity MODIFIED block splits its body sentence: overflow for every app shot, root-leak only for `login-default`/`files-readme`/`settings-default`.
- Active parent delta `openspec/changes/s1e-frontend-parity/specs/demo-parity-acceptance/spec.md:10`: the same clause edited identically, because that delta MODIFIES `ui-shots 截图对产物` and would otherwise restore the old wording when s1e archives.
- `web/test/chat-steps.test.tsx`: one case — a done step whose detail contains an absolute sandbox-shaped path → `原始输出` text contains it verbatim.
- `server/test/session-events.test.ts`: one case — `tool_execution_start` args containing an absolute sandbox-shaped path (short enough to stay under the detail cap) → `step.start` detail contains the path verbatim.

Must preserve: ui-shots overflow assertions, console/pageerror oracle, 60-shot matrix, demo side untouched; files-web presentation rule (no `root` in UI text/title/aria) and its jsdom tests; workspaces DTO shape and web strict parse (`web/src/lib/api.ts` `hasExactlyKeys`); no product code change in `server/src` or `web/src`. Out of scope: #367 detail/output redesign (it will inherit ADR-0011); removing `root` from the DTO (ADR-0011 upgrade path).

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `demo-parity-acceptance`: MODIFIED `ui-shots 截图对产物`.
- `workspaces`: ADDED `绝对 root 不属于对浏览器保密的信息`.
- `chat-stream`: ADDED `步骤 detail 不做路径改写`.
- `chat-web`: ADDED `步骤卡原始输出不做路径改写`.

## Impact
`web/e2e/ui-shots.mjs`, `server/test/session-events.test.ts`, `web/test/chat-steps.test.tsx`, `openspec/changes/s1e-frontend-parity/specs/demo-parity-acceptance/spec.md` (one clause), this change's spec deltas. No product, API or CI change.
