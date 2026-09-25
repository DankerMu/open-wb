## Risk Packs
- Concurrency / ordering — selected: StrictMode cleanup→effect-rerun ordering of `mountedRef` → 1.1, 2.1, 2.2.
- Legacy compatibility — selected: non-StrictMode cases, successful-login unmount (no post-unmount writes/warnings), single-flight lock, quick-login abort unchanged → 2.3.
- Error handling — selected: recovery after a failed login is the defect itself → 2.1, 2.2.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Resource limits, Release, Documentation — not selected: one effect in one component; auth semantics and provider untouched.

## 1. Implementation
- [x] 1.1 `web/src/features/auth/login-form.tsx`: mount effect sets `mountedRef.current = true` in its body and `false` in cleanup.

## 2. Verification
- [x] 2.1 New StrictMode test (form submit → 401 → button enabled, password empty, 2nd submit sends 2nd login request) in `web/test/login-form.test.tsx`; RED on pre-change source, GREEN after.
- [x] 2.2 New StrictMode test (dev-stub routes): click a quick-login card → `/api/auth/login` 401 → `waitFor` every quick card and the submit button `disabled === false` and the password field empty; then click a card again → `calls(fetchMock, "/api/auth/login")` has length 2 (count login calls only: StrictMode issues two `/api/info` reads; follow `login-form.test.tsx:627-646`). RED on pre-change source (cards stay disabled, wait times out), GREEN after.
- [x] 2.3 Existing `web/test/login-form.test.tsx`, `web/test/auth-router.test.tsx` cases pass without assertion changes; no act() warnings introduced (check stderr of the file run; React 19 has no unmounted-update warning, so the post-unmount guarantee rests on the existing successful-login cases).
- [x] 2.4 `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
