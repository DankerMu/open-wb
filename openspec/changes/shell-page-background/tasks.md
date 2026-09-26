## Risk Packs
- Legacy compatibility — selected: light unchanged; ≤760 Drawer backdrop / 390 overscroll show the body color → 1.1, 2.2, 2.3.
- Public API, Config, Schema, File IO, Auth/secrets, Concurrency, Resource limits, Error handling, Documentation, Release — not selected: CSS-only change (spec + checklist rows are the only docs).

## 1. Implementation
- [x] 1.1 `web/src/styles.css`: `body { background: var(--wb-home-bg-secondary) }`; delete `background` from `.app-shell` (:149) and `.app-content > main` (:167). `web/src/features/files/files.css`: delete `background` from `.files-layout` (:35) and `.files-preview` (:185). Keep every other rule.
- [x] 1.1b `web/e2e/ui-walk-layout.ts:56-58` `mainBackground`: read the computed background of `body` (the page background source) instead of `main`, so the theme step (`ui-walk.spec.ts:86`, `expectTheme` `ui-walk-layout.ts:391-394`) still observes a light→dark change; rename if the name no longer fits, and update the assertion message at `ui-walk-layout.ts:393` to match.
- [x] 1.2 CSS text test (new or in `web/test/ui-tokens.test.ts`): asserts the spec scenario `外壳容器不自涂底色` (body uses `--wb-home-bg-secondary`; the four base rule bodies have no `background`, anchored to the base rules such as `/^\.files-layout \{/m`, not same-name rules inside `@media` blocks). Write it first and show it RED on the unchanged CSS.
- [x] 1.3 `docs/acceptance/demo-parity-checklist.md` SH-01 (`:98`) / CH-17 (`:182`) implementation column: add the `styles.css` body-background ref with `（@#420）` per the header rule at `:11` (the bubble rule `messages.css:28-34` is unchanged, so CH-17 cites the body line, not the bubble).

## 2. Verification
- [x] 2.1 RED: 1.2 test fails before 1.1 (record the failing assertion); passes after.
- [x] 2.2 Local `make ui-shots` (compiled server + fake upstream, fresh temp dir; same recipe as `.github/scripts/ci-compiled-server.sh` env) → `截图 60/60，失败 0`; hand the output dir to the orchestrator, who reviews app vs demo `settings-default`, `files-readme`, `chat-done` @1440-dark, `chat-done` @390-dark, and the light counterparts for no change.
- [x] 2.3 Local ui-walk (`bash .github/scripts/ci-compiled-server.sh ui-walk` with the CI env) exit 0 for both projects.
- [x] 2.4 `make lint`, `make typecheck`, `make test`, `make anti-drift` exit 0; `openspec validate shell-page-background --strict --no-interactive` passes.
