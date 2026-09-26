## Risk Packs
- Public API, Config, Schema, File IO, Auth/secrets, Concurrency, Resource limits, Error handling, Accessibility, Legacy compatibility, Documentation, Release — not selected (test-only; no runtime change). Mutation proofs are in 2.1.

## 1. Implementation
- [x] 1.1 FI-15: `web/test/files-overlays.test.tsx`. In O1 (`:66`, switcher path) and O2 (`:94`, menu path), both of which already hold a `dialog` variable (`:72`, `:106`), while the `新建工作空间` dialog is open, assert `within(dialog).getByText("将在你的沙箱内创建同名目录", { exact: true })`. Add the assertion only; leave the existing ones as they are.
- [x] 1.2 FI-30: `web/test/files-empty-layout.test.tsx`. Add case `E3b` after E3 (`:74`).
  - Setup:
    - Start from `authenticatedFilesRoutes([])`.
    - Override `/api/workspaces` with `workspaceRoute([], handler)`, where the handler records each POST body and returns a new workspace.
    - Provide the new workspace's tree route. Follow the success pattern of `web/test/files-page.test.tsx:230-320`.
  - Start by awaiting `未选择工作空间` and `先选择或创建工作空间` (as in `files-page.test.tsx:197`). `新建` does not exist before the page settles, and this also makes the final "gone" assertion meaningful.
  - Flow: `新建` → `新建工作空间` via `openWorkspaceDialogFromMenu()` (`web/test/files-fixture.tsx:100`) → fill `工作空间名称` → `创建`.
  - **Use the menu entry only.** The switcher's `＋ 新建工作空间` calls `openWorkspaceDialog` directly and still works under mutation 2.1(b), so using it would make that proof vacuous. Say so in a comment on the test.
  - Assert:
    - exactly one POST, with the expected JSON body;
    - the dialog is gone;
    - `expectLocation` gives the full `/files?ws=<new id>` (it compares pathname + search + hash, `files-fixture.tsx:76-81`);
    - the switcher card (`选择工作空间`) shows the new name;
    - `先选择或创建工作空间` and `未选择工作空间` are gone.
  - Helpers such as `workspaceCard` (`files-page.test.tsx:39`) and `posts`/`dialogGone` (`files-overlays.test.tsx:38,48`) are file-local. Inline minimal equivalents, or move them into `files-fixture.tsx`, which is still `web/test/**`. Do not copy the `files-page.test.tsx:230-320` block verbatim, since jscpd scans tests at a 3% threshold. Add no product code.
- [x] 1.3 `docs/acceptance/demo-parity-checklist.md`.
  - FI-15 (`:221`) verification column: append the O1 and O2 assertion lines, e.g. `web/test/files-overlays.test.tsx:<line>`.
  - FI-30 (`:236`) verification column: append the E3b line (`web/test/files-empty-layout.test.tsx:<line>`).
  - Each appended ref carries `（@#422）` and a case id (O1/O2/E3b), so it stays findable after line drift.
  - Keep the existing refs and `待签`.

## 2. Verification
- [x] 2.1 Mutation proofs. Each is temporary: revert it and confirm with `git diff --stat web/src` empty. Record the failing output for the PR.
  - (a) Delete the `<p>将在你的沙箱内创建同名目录</p>` at `web/src/features/files/dialogs.tsx:131` → the O1 and O2 additions fail.
  - (b) On the `EmptyWorkspace` branch (`web/src/features/files/page.tsx:424-428`), pass `onNewWorkspace={() => {}}` → E3b fails.
  - (c) Stop rendering `CreationMenu` at `web/src/features/files/tree.tsx:266` → E3b fails. `files-page.test.tsx:195` is expected to fail too, and so are the other `新建`-menu users (O2–O5, `openDirectoryDialog` callers, `files-logical-path`). In the PR, cite the E3b and `:195` failures and list the collateral ones.
- [x] 2.2 `git diff --stat` touches only `web/test/**`, `docs/acceptance/demo-parity-checklist.md` and `openspec/**`.
- [x] 2.3 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. `openspec validate files-dialog-evidence --strict --no-interactive` and `openspec validate s1e-frontend-parity --strict --no-interactive` pass. Precondition: this change archives before the parent.
