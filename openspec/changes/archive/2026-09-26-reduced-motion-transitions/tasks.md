## Risk Packs
- Legacy compatibility — selected: reduced-motion animation behaviour of dialog/drawer, toast, and the `ui-*` motion utilities is unchanged; `no-preference` transitions are unchanged → 1.1, 1.2, 2.3, 2.4.
- Accessibility — selected: reduce still suppresses every declared transition → 1.2, 1.3.
- Public API, Config, Schema, File IO, Auth/secrets, Concurrency, Resource limits, Error handling, Documentation, Release — not selected (CSS plus test harness; the checklist row is the only doc).

## 1. Implementation
- [x] 1.1 `web/src/styles.css:115`: delete `transition-duration: 0.01ms;` from the global `*` reduce block. Keep the `animation-duration`, `animation-iteration-count` and `scroll-behavior` lines.
- [x] 1.2 Audit every non-`none` `transition:` declaration in `web/src/**/*.css`:
  - `ui/chip.css:17`, `ui/input.css:13`, `ui/button.css:19`, `ui/menu.css:32`, `ui/switch.css:15,46`
  - `features/chat/messages.css:330`, `features/chat/chat.css:224,316`, `features/files/files.css:165`
  - `routes/shell/sidebar.css:15,73`

  For each rule, confirm or add a same-selector `transition: none` inside a top-level `prefers-reduced-motion: reduce` block in the same file, **placed after the declaring rule in source order**. `@media` adds no specificity, so an earlier override loses. The known gap is `.sidebar-link` (`sidebar.css:63-76`, transition at `:73`). The existing reduce block at `:22-26` precedes it, so adding the override there would be a no-op. Open a new reduce block after `:76` (or at file end). Change no other declaration.
- [x] 1.3 Add a jsdom CSS text guard (new file or an existing guardrail file). It asserts the ui-primitives scenario `全局块不新建过渡、组件过渡各有在后的覆盖`.

  Global block check: the global `*` reduce block in `styles.css` has no `transition[\w-]*\s*:` declaration and still has the three kept lines.

  Per-file check, for every file in `web/src/**/*.css` (enumerated, not a hard-coded selector list):
  1. `stripComments`, then iterate `topLevelBlocks` (`web/test/ui-support.ts:44`), recording each block's index. `blockBody` returns only the first match and would miss a second reduce block.
  2. For each block whose prelude matches `^@media\s*\(prefers-reduced-motion:\s*reduce\)`, run `topLevelBlocks` on its body. Collect the rules whose body matches `transition\s*:\s*none`, split each prelude on commas, and record `selector → block index`.
  3. Any other `@` block whose body contains a `transition` declaration fails the check.
  4. For each plain rule whose body has `transition(-[\w-]+)?\s*:` with a value other than `none`, each comma-split selector must be in the reduce map with a greater block index.
  5. The set of declaring rules is non-empty (12 today).

  Self-proof: run the same checker on three injected samples. `missing override` must fail, `override before declaration` must fail, and `grouped-selector override after declaration` must pass.

  Show the repo check RED on the unchanged CSS (global block and `.sidebar-link`).
- [x] 1.4 `web/e2e/ui-walk-layout.ts` `switchTheme` (`:373`) gets a reduced-motion switch check for both projects, run before the existing `.check()`:
  1. `page.emulateMedia({ reducedMotion: "reduce" })`.
  2. In one `page.evaluate`:
     - record `matchMedia("(prefers-reduced-motion: reduce)").matches` and `dataset.theme` before the click;
     - click the target radio via `element.click()` (not `locator.click()` followed by a separate evaluate, since a frame may pass in between);
     - synchronously read `dataset.theme`, plus `getComputedStyle(el).color` and `el.getAnimations().length` for every `.settings-sec-h`, every `.settings-row-title`, and every `.sidebar-link`.
  3. Assert:
     - `matches === true`; the theme before the click is not the target and after the click is the target;
     - counts: `.settings-sec-h` = 2, `.settings-row-title` = 3, `.sidebar-link` > 0 on `desktop-light` (0 is allowed on `mobile-dark`, where the drawer is closed);
     - heading and row-title colours equal the target theme's `--wb-text-primary` (dark `rgb(255, 255, 255)`, light `rgb(0, 0, 0)`);
     - every read element has an animation count of 0.
  4. Restore `no-preference`.

  The existing `expectTheme` and reload persistence flow stays unchanged, and so does `ui-walk.spec.ts:122`, apart from any helper-signature change. If the in-page click already selects the theme, the following `.check()` must still pass; it is a no-op on a checked radio.
- [x] 1.5 `web/e2e/ui-shots.mjs`:
  - `appSettings` (`:307-310`) additionally waits until the about-card name is visible (the third `.settings-row-title` or its accessible equivalent). Today it never waits for `/api/info`.
  - `assertAppDom` (`:405`), whose signature changes to receive the cell or its theme (update the call at `:492`), asserts for `settings-default`:
    - counts `.settings-sec-h` = 2 and `.settings-row-title` = 3, where the third is the about-card name;
    - computed `color` equals the cell theme's `--wb-text-primary` (dark `rgb(255, 255, 255)`, light `rgb(0, 0, 0)`);
    - `getAnimations().length === 0` on each.

    Failures are reported through the existing `problems` / `断言失败` path. This implements the demo-parity-acceptance MODIFIED requirement.
- [x] 1.6 `docs/acceptance/demo-parity-checklist.md` ST-03 (`:247`) verification column: add the ui-walk step (function name plus `web/e2e/ui-walk-layout.ts:<line>`) and the ui-shots settings assertion (`web/e2e/ui-shots.mjs:<line>`), each with `（@#423）` per the header rule at `:11`.

## 2. Verification
- [x] 2.1 RED on the unchanged CSS (1.1/1.2 not yet applied): the 1.3 guard fails, the 1.4 ui-walk check fails in both projects (record the failing colour and animation count), and a local `make ui-shots` with 1.5 applied fails `settings-default` on dark cells (record which cells). All pass after 1.1/1.2.
- [x] 2.2 Local `make ui-shots` (compiled server + fake upstream, fresh temp dir, CI env recipe) → `截图 60/60，失败 0`. Hand the output dir to the orchestrator.
- [x] 2.3 Local ui-walk (`bash .github/scripts/ci-compiled-server.sh ui-walk` with the CI env) exits 0 for both projects, including the existing `.ui-pulse` reduced-motion toggle.
- [x] 2.4 `make lint`, `make typecheck`, `make test`, `make anti-drift` exit 0. The existing reduced-motion CSS tests (`ui-dialog`, `ui-toast`, `ui-guardrails`, `ui-form`, `ui-popover-tooltip`) pass unchanged. `openspec validate reduced-motion-transitions --strict --no-interactive` and `openspec validate s1e-frontend-parity --strict --no-interactive` pass.
- [x] 2.5 (orchestrator) PR description carries the diagnosis record from proposal.md `Why`: trigger, root cause, experiment results, and the real-user answer.
