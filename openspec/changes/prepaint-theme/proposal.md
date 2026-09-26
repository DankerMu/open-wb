## Why
#429: users whose stored or system theme is dark get a light first frame on every cold load.
- `web/index.html` has no pre-paint theme script: the stylesheet `<link>` is at `:6` and the module entry at `:11`.
- `data-theme` is first written in `ThemeProvider`'s `useLayoutEffect` (`web/src/features/theme/provider.tsx:91-93`), which only runs after `main.tsx` executes.
- Until then `:root` light tokens apply (`web/src/styles/tokens.css:10`). Native parts follow too, because `color-scheme` only switches under `[data-theme="dark"]` (`web/src/styles.css:31-35`).

Observed in the #423 diagnosis: CDP screencast on `/settings`, first frame at about 6.1 ms without `data-theme`, and `data-theme=dark` at about 7.2 ms. In deployment the flash lasts until the JS bundle is downloaded and run. #423 fixed an orthogonal transition cascade; this is the load-timing half.

## Triage
Issue type: bug (visual, cold-load theme flash)
Fixture level: compact
Upstream suggested level: absent. Compact fits: one inline script, a consistency unit test and one e2e check. `ThemeProvider` runtime sync is unchanged.
Blast radius: every page's first paint. There is no CSP today (`server/src` sets none; the SPA fallback route only sets `Content-Type`), so an inline script is allowed. A future CSP must allow it by hash.
Selected risk packs:
- Legacy compatibility — runtime theme sync (settings switch, cross-tab `storage`, system scheme change under `system`) is unchanged.
- Error handling — storage and `matchMedia` failures must never break page load.
Evidence floor:
- RED-first e2e ordering check (fails without the script);
- a jsdom consistency test across every resolution branch;
- existing theme tests unchanged and green;
- local `make ui-walk` and `make ui-shots` green;
- `make check` green.

## What Changes
- `web/index.html`: a classic inline `<script>` in `<head>` before the stylesheet `<link>`.
  - It reads `localStorage["workbuddy-theme"]` and resolves it like `web/src/lib/theme.ts` plus `provider.tsx` `resolveBrowserTheme`: invalid values and read errors fall back to `system`, and `system` resolves via `matchMedia("(prefers-color-scheme: dark)")`, falling back to light when that is unavailable or throws.
  - It sets `document.documentElement.dataset.theme`.
  - Everything is wrapped in try/catch.
  - Vite keeps a classic inline script as-is in dev and in build. The implementer confirms this in the built `web/dist/index.html`.
- A new jsdom test extracts the inline script from `web/index.html` and runs it over a case table. It asserts equality with `loadTheme` + `resolveTheme` using the provider's `matchMedia` fallback rule.
- `web/e2e/ui-walk.spec.ts` gets a separate `test()` (desktop-light only; helper in `ui-walk-layout.ts`) that checks pre-paint theme in fresh contexts, after React mounts.
  - It uses one `MutationObserver` installed via `addInitScript` from document creation.
  - It asserts that the `data-theme` attribute record precedes the records that insert the stylesheet `<link>` and `#root`.
  - The three cases are: stored `dark` + light scheme, stored `system` + dark scheme, stored `light` + dark scheme.
- Spec: spa-shell ADDED `首帧前主题`. The active parent change has no requirement of that name.

Must preserve:
- `ThemeProvider` behaviour and API;
- the `workbuddy-theme` key and values;
- existing settings and theme tests;
- the ui-walk journey, with its 401 and console-error budgets unaffected;
- the journey test's own 30 s `timeout` and the 150 s `globalTimeout` (`web/playwright.config.ts`).

Out of scope: generating the snippet from `theme.ts` at build time (the issue's alternative); adding a CSP; token changes.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `spa-shell`: ADDED `首帧前主题`.

## Impact
- `web/index.html`
- one new jsdom test file
- `web/e2e/ui-walk.spec.ts` and/or `web/e2e/ui-walk-layout.ts`
