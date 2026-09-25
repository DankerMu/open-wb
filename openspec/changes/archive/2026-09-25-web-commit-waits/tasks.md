## Risk Packs
- Concurrency / ordering — selected: router `startTransition` commit after `pushState` (#369); DefaultLane passive-effect cleanup after commit (#375) → 1.1, 1.2, 2.1, 2.2.
- Legacy compatibility — selected: existing assertion semantics kept, no config change → 2.3.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Resource limits, Error handling, Release, Documentation — not selected: two test assertions only, no `web/src`/config change.

## 1. Implementation
- [x] 1.1 `web/test/chat-page.test.tsx` W5: `:445` → `await waitFor(...)` on `快捷任务` group absent; `:446` identity assertion stays after it.
- [x] 1.2 `web/test/login-form.test.tsx` quick-login unmount case: `:607` → `await waitFor(() => expect(infoSignal.aborted).toBe(true))`.

## 2. Verification
- [x] 2.1 #369 seam (not committed): `vi.mock("react", …)` wrapping `importActual` with `startTransition = (cb) => setTimeout(cb, 200)` (25ms stayed green: under `waitFor`'s 50ms poll it commits first; react-router inlined via a temporary vitest config so the mock reaches it), run `-t "W5"`: RED at `:445` on the old assertion, GREEN after 1.1. Output in PR.
- [x] 2.2 #375 seam (not committed): force the passive cleanup after the DOM-observed signal (e.g. a >5ms busy-render child in the protected content plus `setImmediate` delayed via `setTimeout(cb, 20)` before React loads, or an equivalent deterministic delay of the cleanup): RED at `:607` on the old assertion, GREEN after 1.2. If no deterministic seam can be built, say so in the report with what was tried.
- [x] 2.3 `npx vitest run test/chat-page.test.tsx test/login-form.test.tsx` green; `npm test --workspace web` green; `make lint`, `make typecheck`, `make anti-drift` exit 0; `git diff --stat` touches only the two test files.
