## Risk Packs
- Concurrency / ordering — selected (test timing only, no runtime concurrency touched): deferred Radix refocus vs Dialog initial focus; DismissableLayer listener registered after mount → 1.1, 1.4, 2.2.
- Error handling — selected: pending create aborted by overlay press, single POST → 1.4, 2.2.
- Legacy compatibility — selected: existing O1–O8 assertions unchanged → 2.3.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Resource limits, Release, Documentation — not selected: test-only, no `web/src` change.

## 1. Implementation
- [x] 1.1 O1/O2/O3 initial focus: `await yieldMacrotask()` then synchronous `expect(document.activeElement).toBe(...)`; O2 adds `工作空间名称`.
- [x] 1.2 Modal set-then-cleared for ≥1 menu-path and ≥1 switcher-path cancel-class close: while open `view.container.getAttribute("aria-hidden") === "true"` and `document.body.style.pointerEvents === "none"`; after close and focus return `document.body.style.pointerEvents === ""` and `view.container.hasAttribute("aria-hidden") === false` (`view` from `renderWorkspace()`/`renderFiles`).
- [x] 1.3 O3 asserts `aria-modal="true"` on `新建文件夹`.
- [x] 1.4 O9: held `POST …/dirs` → `yieldMacrotask()` → `pressPointer(overlay)` → dialog gone, `signal.aborted === true`, focus on `新建`, exactly 1 POST.

## 2. Verification
- [x] 2.1 `cd web && npx vitest run test/files-overlays` green (and the new file if created).
- [x] 2.2 Mutation self-checks (temporary source edits, each reverted after; report command + RED excerpt for each):
  - (a) pass `modal={false}` to `DialogPrimitive.Root` (`web/src/ui/dialog.tsx:133`) **and** move `DialogPrimitive.Content` out of `DialogPrimitive.Overlay` to render as its sibling (Radix `DialogOverlay` returns `null` when non-modal, and the content currently lives inside it, `dialog.tsx:136-137`) → the dialog renders without modal behavior or focus trap. Expected RED on the 1.2 open-state `aria-hidden`/`pointerEvents` checks and on the 1.1 post-`yieldMacrotask` synchronous focus checks (Menu/Popover deferred `onCloseAutoFocus` returns focus to the trigger). The RED excerpt must show those assertions failing; a `findByRole("dialog")` timeout does not count. If 1.1 stays green under (a), report it and where focus ends.
  - (b) in `onCloseAutoFocus` (`dialog.tsx:36-41`, runs after Radix cleanup) temporarily set `document.body.style.pointerEvents = "none"` → the 1.2 after-close pointer-events check RED.
  - (c) make `cancelOnClose` (`web/src/features/files/dialogs.tsx`) ignore the close → O9 RED (dialog stays open).
  - (d) remove `folderMutationRef.current?.abort()` in `closeFolderDialog` (`web/src/features/files/tree.tsx:~536`) → the O9 (and O4) `signal.aborted === true` checks RED while the dialog still closes.
- [x] 2.3 Existing O1–O8 assertions unchanged except O1 `:62` / O3 `:101` initial-focus form (1.1); `git diff --stat` shows only test files (no `web/src`) after all mutations are reverted.
- [x] 2.4 `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
