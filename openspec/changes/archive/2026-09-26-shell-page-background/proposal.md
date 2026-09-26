## Why
#420: in the dark theme the main area uses the wrong background token (checklist SH-01 / CH-17).
- **Demo:** the page background comes from `body { background: var(--wb-home-bg-secondary) }` (`resource/workbuddy-live-demo.html:195`; dark `#141414`). The demo's shell and main containers paint nothing (`:210-213`).
- **App:** `.app-shell` and `.app-content > main` paint `--wb-bg-primary` (`web/src/styles.css:149,167`; dark `#1f1f1f`, identical to `--wb-sidebar-bg`). The files page does the same on `.files-layout` and `.files-preview` (`web/src/features/files/files.css:35,185`).
- **Effect:** in dark, the sidebar and main area merge, and the user bubble (`--wb-bg-hover-light`, dark `#1f1f1f`, `web/src/features/chat/messages.css:33`; same as demo `:421`) and composer card (`#1f1f1f`) are the same colour as the main area, so the bubble is invisible. The main area in light is unaffected, because both main-area tokens are `#fff`. `body` itself moves from `--wb-home-bg-primary` (light `#f2f2f2`) to `#fff`. That is visible only where body shows through: ≤760 overscroll and behind the Drawer backdrop. It now matches the main area, and login and auth-loading keep their own `#f2f2f2`.

## Triage
Issue type: bug (demo-parity styling)
Fixture level: compact
Upstream suggested level: absent (compact: CSS-only, four rules plus body; no behavior/API change)
Blast radius: page background of every authenticated route in dark; light unchanged; login and auth-loading pages keep their own backgrounds (`web/src/features/auth/auth.css:9`, `web/src/styles.css:182`).
Selected risk packs: Legacy compatibility (light screenshots unchanged; surfaces that relied on the shell paint, such as the ≤760 Drawer backdrop and 390 overscroll).
Evidence floor:
- RED-first CSS text test;
- local `make ui-shots` dark/light pairs reviewed by the orchestrator;
- `make ui-walk` mobile-dark green;
- `make check` green.

## What Changes
- `web/src/styles.css`:
  - `body` background changes to `var(--wb-home-bg-secondary)`;
  - the `background` line is removed from `.app-shell` and `.app-content > main`.
- `web/src/features/files/files.css`: the `background` line is removed from `.files-layout` and `.files-preview`.
- A new CSS text test in the style of `web/test/ui-tokens.test.ts:114` pins the rule.
- `docs/acceptance/demo-parity-checklist.md`: SH-01 and CH-17 implementation refs are updated with the `（@#420）` suffix.
- Spec: spa-shell ADDED `外壳页面底色`. The active parent change has no requirement for this, so there is no archive conflict.

Must preserve:
- light theme appearance;
- every other `--wb-bg-primary` use (composer, chips, `回到最新`, popovers, dialogs, toasts, login card);
- the `.files-tree` and `.settings-card` backgrounds;
- sidebar tokens;
- no horizontal overflow.

Out of scope: #423 (ST-03 text colour), token value changes.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `spa-shell`: ADDED `外壳页面底色`.

## Impact
`web/src/styles.css`, `web/src/features/files/files.css`, `web/e2e/ui-walk-layout.ts` (`mainBackground` helper reads `main`'s computed background, which becomes transparent; it must read `body` instead — `openspec/specs/verification-harness/spec.md:36` only asserts `data-theme` and localStorage, so no spec delta), one test file, checklist SH-01/CH-17 rows.
