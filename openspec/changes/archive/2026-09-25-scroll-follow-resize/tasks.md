## Risk Packs
- Concurrency / ordering — selected: layout effect vs observer callback vs scroll events; no write loop → 1.1, 2.1 (R1–R3), 2.3.
- Resource limits / lifecycle — selected: observer disconnect on unmount / session `key` remount; content-root rebinding → 1.1, 2.1 (R4).
- Legacy compatibility — selected: F1–F7 unchanged, D8 parameters, environments without `ResizeObserver` → 2.1 (R5), 2.2.
- Public API / CLI / script entry — selected: ui-walk harness steps in both projects, exact browser-error oracle intact → 1.3, 2.3.
- Config, Schema, File IO/path safety, Auth/secrets, Error handling, Release, Documentation — not selected: presentation-only hook change; no request/storage/route/config change.

## 1. Implementation
- [x] 1.1 `scroll-follow.tsx`: shared read-only `settle(el)`; `ResizeObserver` (feature-detected) on the scroll container plus the current content root re-bound in the `[content]` layout effect; `disconnect()` on cleanup; `pinned` writers unchanged.
- [x] 1.2 `web/test/chat-scroll-follow.test.tsx`: spy `ResizeObserver` cases R1–R5 per design.md (spy installed on `globalThis` before mount, restored in `afterEach`; R5 deletes it; trigger is a no-op without an instance).
- [x] 1.3 `web/e2e/ui-walk.spec.ts`: W-scroll steps 1–3 per design.md inside `walkHeldDialogue`'s `try` before `clickRoute("设置")`, `withViewport`-style save/restore (height only), measured heights with overflow/no-page-scroll preconditions asserted before every distance assertion; Step 3 unpins via an awaited real `scroll` event inside one `evaluate`, then shrinks further from the Step 1 height (never grows).

## 2. Verification
- [x] 2.1 R1–R4 RED on pre-change source (no observer) and GREEN after; R5 GREEN both. Paste excerpts.
- [x] 2.2 F1–F7 and all `chat-page*` suites unchanged and green; `npm test --workspace web` exit 0.
- [x] 2.3 `make ui-walk` against a locally started server (see AGENTS.md / CI `ui-walk` job for the start recipe: built `web/dist`, fresh DB, fake upstream, fixture sandbox) green in both projects; show the W-scroll steps executing. If a local run is impossible, state exactly why; CI `ui-walk` is then the gate. Also show W-scroll RED on pre-change source for at least the container-resize or `原始输出` step if a local run is possible.
- [x] 2.4 `make lint`, `make typecheck`, `make anti-drift` exit 0.
