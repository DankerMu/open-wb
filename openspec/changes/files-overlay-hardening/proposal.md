## Why
#383 (PR #381 / #302 round-1 P2 follow-up) — `web/test/files-overlays.test.tsx` passes today but does not pin four behaviors the files-web focus-loop contract relies on:
1. Initial focus is asserted only with `focusedOn` (`:43-45`, a `waitFor` that returns on first success): O1 `:62` `工作空间名称`, O3 `:101` `位置`. Radix Menu/Popover return focus to their trigger in a deferred `onCloseAutoFocus` (setTimeout 0), so `waitFor` can pass before that late refocus and stay green even if the trigger later steals focus back. O2 (`:77-94`, menu path to `新建工作空间`) has no initial-focus assertion at all.
2. No test checks that cancel-class closes leave no `document.body.style.pointerEvents` residue or `aria-hidden` on the app root (`grep pointerEvents|aria-hidden` — none).
3. `aria-modal="true"` is asserted only for `新建工作空间` (O1 `:61`); `新建文件夹` (O3) is not, though `openspec/specs/files-web/spec.md` 创建流程焦点闭环 requires both.
4. Pending-state cancel is tested only via the `取消` button (O4). An overlay press while pending shares `cancelOnClose` (`web/src/features/files/dialogs.tsx`, mounted on both dialogs; `Dialog` default `dismissible` → `closeOnOverlay`, `busy` does not block overlay close) and should abort the request, but nothing pins it.
Current behavior is correct (7/7 at the time of the issue); this is regression protection only.

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: absent (compact: test-only additions in one test area; no `web/src` change)
Blast radius: test-only; a wrong assertion could pass vacuously (e.g. focus checked before the deferred refocus, or `aria-hidden` checked on the wrong node).
Selected risk packs: Concurrency / ordering (deferred Radix `onCloseAutoFocus` vs Dialog `onOpenAutoFocus`; DismissableLayer pointerdown listener registered after mount); Error handling (pending create aborted by overlay press, one POST only); Legacy compatibility (existing O1–O8 assertions unchanged).
Concurrency pack here covers test timing only (deferred refocus, listener registration); no runtime concurrency is touched, so compact is kept.
Evidence floor: mutation self-checks RED then restored (tasks 2.2); `npx vitest run test/files-overlays` green; `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0; `git diff --stat` shows no `web/src` change.
design.md omitted (compact).

## What Changes
- O1 and O2 after the `新建工作空间` dialog opens, and O3 after selecting `新建文件夹`: `await yieldMacrotask()` (lets the deferred `onCloseAutoFocus` run), then assert `document.activeElement` synchronously (`工作空间名称` / `位置`) instead of `focusedOn`. O2 gains the `工作空间名称` initial-focus assertion.
- For at least one menu-path cancel-class close (O2 `取消` and/or O3 `关闭`/overlay) and one switcher-path close (O1 Escape): while the dialog is open, first assert the modal state is set — `view.container.getAttribute("aria-hidden") === "true"` (Radix Dialog is modal by default: `hideOthers` marks RTL's container) and `document.body.style.pointerEvents === "none"` (DismissableLayer `disableOutsidePointerEvents`); then, after the existing focus-return assertion, `document.body.style.pointerEvents === ""` and `view.container.hasAttribute("aria-hidden") === false` (`view` from `renderWorkspace()`/`renderFiles`), following `web/test/ui-menu.test.tsx:140` and `web/test/app-shell-responsive.test.tsx:324`.
- O3: `expect(dialog.getAttribute("aria-modal")).toBe("true")`.
- New case (O9): `新建文件夹` with a held `POST …/dirs`: `yieldMacrotask()` then `pressPointer(overlay)` → dialog closes, the request signal `aborted === true`, focus back on `新建`, exactly one POST. Optionally the same for `新建工作空间`.
- The file is 214 lines (size guard limit 800), so O9 stays in it.

Must preserve: all existing O1–O8 assertions unchanged except O1 `:62` and O3 `:101`, whose `focusedOn` initial-focus checks become `yieldMacrotask` plus an immediate check (1.1) — (focus return targets, two menu items, held-create focus on `关闭`, 409 handling, Escape closing the menu, Button class names, O7 primitive-import contract); no `web/src` change; no timeout/retry/config change. Out of scope: ui-walk real-browser refocus verification; any source change.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `files-web`: ADDED requirement stating the creation-overlay behaviors these tests pin (ADDED rather than MODIFIED because the active `s1e-frontend-parity` change restates 文件界面与键盘可用性).

## Impact
`web/test/files-overlays.test.tsx` (and possibly a new `web/test/files-overlays-pending.test.tsx`). No production or CI change.
