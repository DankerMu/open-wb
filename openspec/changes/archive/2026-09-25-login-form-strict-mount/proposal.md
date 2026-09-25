## Why
#328 — `web/src/features/auth/login-form.tsx:16-23`: `mountedRef = useRef(true)` and the only effect is a cleanup that sets it `false`; the effect body never sets it back to `true`. StrictMode simulates unmount→remount (cleanup, then the effect body reruns, refs kept), so after mount `mountedRef.current` is permanently `false`. `performLogin`'s `finally` (`:42-50`) is guarded by `mountedRef.current`, so after the first failed login under StrictMode the password is not cleared, `lockedRef` stays `true` (every later submit and quick-login card returns at `:32`) and `submitting` stays `true` (button disabled) — the form is locked until reload. Production entry (`web/src/main.tsx`) has no StrictMode, so this is latent, but any test that renders the login form under StrictMode (`openLoginPage({ strict: true })`, or `mountAuthenticatedApp(path, fetchMock, true)`) and goes through a failed login hits it. Introduced in `174fc3a` (#14). The repo convention is `footer.tsx:18-23` / `chat/page.tsx`: set `true` in the effect body, `false` in cleanup.

## Triage
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent (compact: one effect in one component; no API/storage/route change)
Blast radius: login form and quick-login cards after a failed login; a wrong fix could write state/DOM after the successful-login unmount.
Selected risk packs: Concurrency / ordering (StrictMode cleanup→rerun ordering of the mount flag); Error handling (recovery after failed login); Legacy compatibility (non-StrictMode behavior and unmount-after-success path unchanged).
Evidence floor: new StrictMode regression tests RED on pre-change source and GREEN after; existing `login-form.test.tsx` and auth-router suites unchanged and green; `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
design.md omitted (compact).

## What Changes
- `login-form.tsx`: the mount effect becomes `useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, [])` (footer.tsx convention). Nothing else in `performLogin`/`submit` changes.
- `web/test/login-form.test.tsx`: StrictMode regressions (via existing `openLoginPage({ strict: true, routes })`):
  1. form submit → `/api/auth/login` 401 → after the `role=alert` error appears: submit button enabled, password field empty; a second submit sends a second `/api/auth/login` request (count 1→2);
  2. quick-login card (dev-stub `/api/info`) → 401 → cards and form usable again, a second card click sends a second login request.

Must preserve: non-StrictMode behavior (existing cases unchanged); successful login unmounts the form without state/DOM writes after unmount and without React warnings; single-flight lock while a login is pending; quick-login abort-on-unmount behavior. Out of scope: submit logic, provider `login` semantics, enabling StrictMode in `web/src/main.tsx`.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `spa-shell`: ADDED requirement that the login form recovers after a failed login under StrictMode's effect rerun (ADDED rather than MODIFIED because the active `s1e-frontend-parity` change restates `登录页与路由守卫` wholesale).

## Impact
`web/src/features/auth/login-form.tsx`, `web/test/login-form.test.tsx`. No server, API or CI change.
