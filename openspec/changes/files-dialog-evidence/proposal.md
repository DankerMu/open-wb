## Why
#422: two checklist rows cite jsdom evidence that does not prove the behaviour they state.

- **FI-15** (`docs/acceptance/demo-parity-checklist.md:221`): the `新建工作空间` dialog explains `将在你的沙箱内创建同名目录`.
  - Rendered at `web/src/features/files/dialogs.tsx:131`, but no test asserts it.
  - The cited cases `files-overlays.test.tsx` O1 and O5 open the dialog without checking the text.
- **FI-30** (`:236`): with zero workspaces, the `＋` menu can still create a workspace.
  - The cited case `files-empty-layout.test.tsx` E3 only asserts the empty-state copy.
  - `files-page.test.tsx:194-199` covers only "the menu exists at zero workspaces", via `新建文件夹`.
  - No test creates a workspace starting from an empty list. The only create-success case (`files-page.test.tsx:230`) starts from `[workspace]`.

Static review found no product defect (`page.tsx:424-428` → `:163-186` → `tree.tsx:266` `CreationMenu`; success branch `page.tsx:351-362`). This is a pure evidence gap: deleting the `<p>` or no-op'ing `onNewWorkspace` on the zero-workspace branch leaves the suite green.

## Triage
Issue type: test gap (evidence for demo-parity sign-off)
Fixture level: compact
Upstream suggested level: absent (compact: test files and doc rows only, no product code)
Blast radius: none at runtime; `web/test/**` and two checklist rows only.
Selected risk packs: none beyond test evidence. Mutation proofs are the core evidence.
Evidence floor:
- temporary mutations, not committed, each turning the new tests red:
  - (FI-15) remove the `dialogs.tsx:131` `<p>`;
  - (FI-30a) replace `onNewWorkspace` on the `EmptyWorkspace` branch (`page.tsx:424-428`) with `() => {}`;
  - (FI-30b) stop rendering `CreationMenu` (`tree.tsx:266`);
- `git diff --stat` limited to `web/test/**`, the checklist and `openspec/**`;
- `make check` green.

## What Changes
- `web/test/files-overlays.test.tsx`:
  - O1 (switcher path) and O2 (menu path) each assert that the open `新建工作空间` dialog contains exactly `将在你的沙箱内创建同名目录`.
  - Both paths render the same `WorkspaceDialog` (`page.tsx:431-438`); asserting on both also pins that neither entry swaps the dialog.
- `web/test/files-empty-layout.test.tsx`: a new case `E3b`. From zero workspaces it goes `新建` → `新建工作空间` → fill the name → `创建`. Routes: `workspaceRoute([], handler)` plus the new space's tree route, per the fixture constraint at `web/test/files-fixture.tsx:35-39`. It asserts:
  - exactly one POST with the expected body;
  - the dialog closes;
  - the URL becomes `?ws=<new id>`;
  - the switcher card shows the new name;
  - `先选择或创建工作空间` disappears.
- `docs/acceptance/demo-parity-checklist.md` FI-15 and FI-30 verification columns cite the new assertions with `（@#422）`. This follows the header rule at `:11`, which since #424 already defines the `@#NNN` suffix, so the SHA note the issue suggested for `:11` is not needed. Sign-off stays `待签`.
- Spec: files-web MODIFIED `工作空间页`.
  - The dialog's "沙箱目录创建提示" is pinned to the exact text.
  - The `无空间空态` scenario THEN spells out the zero-workspace create flow.
  - The active parent change `s1e-frontend-parity` MODIFIES `工作空间页` too; its copy is synced in this fixture with the same two phrase replacements.

Must preserve:
- no product code change;
- existing O1, O2 and E3 assertions unchanged apart from additions;
- other checklist rows untouched.

Out of scope:
- ui-walk (`web/e2e/ui-walk.spec.ts:164-171` conditional branch);
- re-pinning the checklist SHA;
- any product fix. If a new test exposes a defect, report it through a new issue.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `files-web`: MODIFIED `工作空间页` (parent copy synced).

## Impact
- Tests: `web/test/files-overlays.test.tsx`, `web/test/files-empty-layout.test.tsx`.
- Docs: checklist rows FI-15 and FI-30.
- Specs: `openspec/changes/s1e-frontend-parity/specs/files-web/spec.md` (parent sync, done in the fixture).
