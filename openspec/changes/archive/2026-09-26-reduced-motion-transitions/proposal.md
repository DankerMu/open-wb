## Why
#423: under `prefers-reduced-motion: reduce`, inherited-colour text (`.settings-sec-h`, `.settings-row-title`, the about-card name) is captured in the light theme's black on dark `settings-default` screenshots, which blocks ST-03 sign-off (`docs/acceptance/demo-parity-checklist.md:247`).

Diagnosis (scratch-only, HEAD `1483d9e`, Chromium 151, full 60-shot matrix; scripts in the orchestrator scratchpad `diag-423/`):
- **Repro rate:** baseline 5/30 dark cells black (1440 2/10, 1024 3/10, 390 0/10). The fault is not width-specific; it is a timing race. Without `reducedMotion` it is 0/30. With the global `transition-duration` line deleted it is 0/30.
- **Mechanism:**
  1. The first frame resolves html/body/#root in light, because `data-theme` is written in `useLayoutEffect` (`web/src/features/theme/provider.tsx:91-92`) and `index.html` has no pre-paint script.
  2. Switching to dark changes their `color`.
  3. The reduced-motion rule `*, *::before, *::after { transition-duration: 0.01ms }` (`web/src/styles.css:109-117`) leaves `transition-property` at its initial `all`, so it *creates* a 0.01 ms colour transition on every element.
  4. Descendants inserted during that transition inherit the in-flight start value (light black). When the ancestor's transition ends, their inherited value changes, which starts their own black→white transition. This cascades one frame per tree level.
  5. A screenshot that lands in one of those frames freezes black text.
- **Why the rule helped nothing:** `*` has specificity 0. All 12 component `transition:` declarations are class-selector shorthands, so the line never shortened any existing transition. Its only effect is creating transitions where none were declared.
- **Deterministic repro (theme switch):** on `/settings` under reduce, clicking a theme radio and reading `getComputedStyle(...).color` in the same task returns the *old* theme colour with one running `color` CSSTransition (`currentTime 0`). Baseline is 10/10 red at 390 and at 1440. With the line deleted, or with `transition: none`, it is 10/10 green. Under `no-preference` it is 10/10 green.
- **Screenshot-probe repro:** the synchronous probe run before the ui-shots screenshot reads `rgb(0,0,0)` on 30/30 dark cells at baseline and on 0/15 after the fix.
- **Real users:** with system "reduce motion" on and the dark theme, a full page load shows about one frame of black inherited text (CDP screencast: 3/15 loads baseline, 0/15 fixed). A theme switch lags one or two frames, with background and text transitioning together, so no mismatch is visible. The effect is a real but transient flash, not a stuck state.
- Hypothesis B (theme timing / pre-paint script) alone would not fix it: the switch path is red regardless of load timing. The first-frame light flash itself is filed as #429.
- Issue experiments:
  1. Transition dump: property `color`, `currentTime 0`, `startTime` equal to `document.timeline.currentTime`, 0.01 ms, keyframes black→white.
  2. Dropping `reducedMotion`: 0/30 black.
  3. A demo-free run was not needed: dropping reduce and applying the patch each reach 0/30 with the demo context alive, so the race is page-internal.
  4. `.settings-row-desc` (explicit token) resolves correctly on load while its inherited siblings are black. On a theme switch it also reads the old value synchronously, because its own declared colour change is transitioned too.
  5. MutationObserver and `transitionrun` log: `data-theme=dark` is written about 1 ms after the first frame; `transitionrun` (`color`) fires in per-frame waves html/body/#root → settings subtree → late-inserted nodes.
- The PR description carries this diagnosis record (issue acceptance criterion 1).

## Triage
Issue type: bug (reduced-motion styling)
Fixture level: compact
Upstream suggested level: absent (compact: one CSS line removed, missing per-component overrides added, three guards)
Blast radius: every element under `prefers-reduced-motion: reduce`. After the fix, no element gets an implicit transition; declared component transitions are unaffected by the removed line (specificity), and each gets or keeps its own `transition: none` override.
Selected risk packs:
- Legacy compatibility: reduced-motion animation behaviour (dialog/drawer, toast, `ui-fadein`/`ui-pop`/`ui-pulse`/`ui-caret`/`ui-spin`) is unchanged, because the `animation-*` and `scroll-behavior` lines stay.
- Accessibility: reduced motion must still suppress motion.
Evidence floor:
- RED-first: the ui-walk theme-switch check is red 10/10 on the unchanged CSS; the ui-shots settings assertion is red on dark cells before the fix;
- CSS text guard;
- local `make ui-shots` 60/60 with the new assertion;
- `make ui-walk` both projects green;
- `make check` green.

## What Changes
- `web/src/styles.css:115`: delete `transition-duration: 0.01ms;`. Keep `animation-duration`, `animation-iteration-count` and `scroll-behavior`.
- Audit every non-`none` `transition:` declaration in `web/src/**/*.css`. Each rule that declares one gets a `transition: none` override in a `prefers-reduced-motion: reduce` block of the same file, placed **after** the declaring rule in source order (`@media` adds no specificity; the later rule wins). Known gap: `.sidebar-link` (`web/src/routes/shell/sidebar.css:63-76`). The existing reduce block at `:22-26` precedes it, so the override needs a new reduce block after `:76`; adding it to `:22-26` would be a no-op.
- A CSS text guard (jsdom) asserts:
  - the global `*` reduce block declares no `transition*` property;
  - every rule declaring a non-`none` transition has a matching reduce override later in the same file.

  The guard self-proves on injected samples.
- `web/e2e/ui-walk-layout.ts` `switchTheme`, in both projects, gets a reduced-motion switch check. Under `emulateMedia({reducedMotion:"reduce"})` it clicks the target radio in-page and, in the same `page.evaluate`, reads inherited-colour text and `getAnimations()`. It then restores `no-preference`.
- `web/e2e/ui-shots.mjs`:
  - the app `settings-default` step waits for the about-card name;
  - `assertAppDom` for `settings-default` asserts the inherited-colour elements resolve to the cell theme's `--wb-text-primary` with zero animations.
- `docs/acceptance/demo-parity-checklist.md` ST-03 verification column: add the new ui-walk step and the ui-shots settings assertion, each with `（@#423）`.
- Spec:
  - ui-primitives ADDED `全局 reduced-motion 规则`. The active parent change `s1e-frontend-parity` has no requirement of that name, so there is no archive conflict.
  - demo-parity-acceptance MODIFIED `ui-shots 截图对产物`: adds the `settings-default` pre-screenshot colour and animation assertion, and updates the `六格产物齐全` THEN. The parent change's MODIFIED copy is synced with the same wording (precedent: `archive/2026-09-25-sandbox-path-visibility`).
  - The verification-harness `UI 走查` requirement is not modified. By precedent (#424), new ui-walk steps are specified in the owning capability's scenario.

Must preserve:
- the reduced-motion behaviour of every existing component override and of the `ui-pulse` toggle check (`web/e2e/ui-walk-layout.ts:231-239`);
- `no-preference` transitions unchanged;
- ui-walk and ui-shots flows otherwise unchanged.

Out of scope (report only):
- first-frame light FOUC: the theme is applied after the first paint, and there is no pre-paint script;
- `animation-duration: 0.01ms` has the same specificity limitation, but components carry their own `animation: none`;
- token values.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `ui-primitives`: ADDED `全局 reduced-motion 规则`.
- `demo-parity-acceptance`: MODIFIED `ui-shots 截图对产物` (parent copy synced).

## Impact
- CSS: `web/src/styles.css`, `web/src/routes/shell/sidebar.css`, and any other CSS file whose transition lacks an override;
- specs: `openspec/changes/s1e-frontend-parity/specs/demo-parity-acceptance/spec.md` (parent sync, done in the fixture);
- tests: one jsdom test file (new or an existing guardrail file);
- e2e: `web/e2e/ui-walk-layout.ts`, `web/e2e/ui-shots.mjs`;
- docs: checklist row ST-03.
