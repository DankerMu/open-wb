## Risk Packs
- Legacy compatibility — selected: `ThemeProvider` runtime sync (settings switch, cross-tab `storage` event, system scheme change under `system`) is unchanged; existing theme tests stay green → 1.1, 2.3.
- Error handling — selected: every storage and `matchMedia` access is wrapped in try/catch; a throwing store or a missing or throwing `matchMedia` must not break load → 1.1, 1.2.
- Public API, Config, Schema, File IO, Auth/secrets, Concurrency, Resource limits, Accessibility, Documentation, Release — not selected.

## 1. Implementation
- [x] 1.1 `web/index.html`: add a classic inline `<script>` (no `type="module"`, no `src`) **inside `<head>`**, right after `<meta charset>` and before the source stylesheet `<link>` (`:6`). It must never go in `<body>`: Vite appends the built module script and stylesheet `<link>` before `</head>`, so any script in `<body>` would land after the link. Keep it small and dependency-free, and add a short comment pointing at `web/src/lib/theme.ts` as the rule source.
  - Read `localStorage.getItem("workbuddy-theme")` inside try/catch.
  - Normalise: `light`, `dark` and `system` pass through; anything else, including `null` or a throw, becomes `system`.
  - Resolve `system` with `window.matchMedia("(prefers-color-scheme: dark)").matches` inside try/catch. A missing function or a throw means light, matching `provider.tsx` `resolveBrowserTheme` and `getMediaQuery`.
  - Set `document.documentElement.dataset.theme`.
  - Leave `provider.tsx` unchanged.
  - After `npm run build` (web), confirm that `web/dist/index.html` has this shape: `<meta charset>` → inline classic script → … → built `<script type="module">` and `<link rel="stylesheet">` before `</head>`. If the link lands ahead of the script, stop and report.
- [x] 1.2 Add a jsdom test (e.g. `web/test/prepaint-theme.test.ts`).
  - Import `THEME_STORAGE_KEY` from `web/src/features/theme` and assert that the script source contains it (catches key drift). Reuse `web/test/media-query-support.ts` for the `matchMedia` stubs where it fits.
  - Read `web/index.html` through the existing `readRepoFile` helper and extract the single inline classic script. Assert there is exactly one, and that it sits before the stylesheet `<link>` in source order.
  - For each case, run the script (e.g. `new Function` with a stub `window`/`localStorage`/`matchMedia`/`document`, or by setting jsdom globals) and compare the written `data-theme` with `resolveTheme(loadTheme(read), mm)`. Here `mm` mirrors the provider rule: throw or missing gives `{ matches: false }`.
  - Cases: stored `light` / `dark` / `system` / `"bogus"` / `null` / a throwing `getItem`, each combined with system dark, system light, `matchMedia` throwing and `matchMedia` undefined.
  - Assert that no exception escapes the script.
- [x] 1.3 e2e pre-paint check in `make ui-walk`. Put it in a **separate `test()`** in `web/e2e/ui-walk.spec.ts`, with the helper in `web/e2e/ui-walk-layout.ts`.
  - The file already runs serially with `workers: 1`, so the separate test gets its own 30 s `timeout` and stays outside the journey's oracles.
  - Skip it on `mobile-dark` via `testInfo.project.name`.
  - Do not reuse the journey context: `addInitScript` would re-seed storage on every navigation and interfere with `switchTheme` persistence, and each case needs its own `colorScheme`.
  - For each of the three spec cases (stored `dark` + `colorScheme: "light"`, stored `system` + `colorScheme: "dark"`, stored `light` + `colorScheme: "dark"`):
    1. `browser.newContext({ colorScheme })`. It inherits the project's `baseURL`.
    2. `addInitScript` for (a) and (b):
       - (a) seed `workbuddy-theme`, skipping `about:`;
       - (b) a single `MutationObserver` on `document` with `{ subtree: true, childList: true, attributes: true, attributeFilter: ["data-theme"] }`. It appends ordered entries to a window array: attribute entries with the current `data-theme` value, and added-node entries for a `LINK` with `rel="stylesheet"` or an element with `id="root"`.
    3. Collect `pageerror` and console errors for this page.
    4. `goto("/files")`. Signed out, the guard renders the login page, as `ui-walk.spec.ts:78-79` does; `/login` is not an SPA route and would render the router's 404. Wait only for the heading `登录 WorkBuddy` to be visible. `web/src/features/auth/guard.tsx:8-18` leaves `loading` only after the `/api/auth/me` response, so the heading implies React has mounted and the 401 has arrived. Do not add a separate `waitForResponse` after `goto`; it can miss a response that arrived before `goto` returned.
    5. Read the array.
    6. Assert:
       - the first `data-theme` entry comes before both the stylesheet `LINK` and the `#root` entries, with the expected value (`dark` / `dark` / `light`);
       - every later `data-theme` entry has the same value;
       - there is no `pageerror`;
       - there is at most one console error, and it must match the ui-walk oracle's 401 `/api/auth/me` allowance. Export and reuse that predicate from `web/e2e/ui-walk-oracle.ts` rather than duplicating it.
    7. Close the context.
  - Write this step first and show it RED before 1.1.

## 2. Verification
- [x] 2.1 RED: before 1.1, the 1.3 check fails. Record the record order and values, e.g. `LINK` and `#root` before any `data-theme`. The 1.2 test fails because there is no inline script. After 1.1, both pass.
- [x] 2.2 Local ui-walk with the CI recipe (fresh temp dir) exits 0 for both projects. Local `make ui-shots` gives `截图 60/60，失败 0`; hand the output dir to the orchestrator.
- [x] 2.3 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. The existing settings and theme tests (`web/test/settings-page.test.tsx`, theme provider tests) pass unchanged. `openspec validate prepaint-theme --strict --no-interactive` passes.
