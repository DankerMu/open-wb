# Spec: files-harness

## MODIFIED Requirements

### Requirement: 走查 /files 步骤
`make ui-walk` SHALL extend the existing serial journey after four-route traversal and before dialogue with real UI selection or creation of smoke-fixture. The caller SHALL supply tracked readme.md/notes.csv/logo.png and an absent walk-out in an owned fresh sandbox. The journey SHALL wait for loaded workspace selection and actual root file entries, assert rendered smoke-fixture heading and numbered Markdown source containing # smoke-fixture, and assert CSV name/value headers, alpha/1 and beta/2, exactly five table rows (header plus four data rows) and the note `共 4 行 · 大文件仅预览前若干行`, and, after selecting logo.png, a preview image named `logo.png` whose `naturalWidth` and `naturalHeight` are both 256. It SHALL create walk-out at root through the UI and assert a directory row: after choosing the root location and name in the page-scoped `新建文件夹` dialog it SHALL hold `POST /api/workspaces/<id>/dirs` with a Playwright route, submit by pressing Enter on the focused `创建` button, first assert that the request was actually held, then assert that the dialog's `关闭` button is focused and that after Tab, Shift+Tab and Tab the active element is each time inside the dialog; it SHALL then release the request (awaiting the forwarded continue before unrouting) and assert the directory row. The switcher, both creation dialogs and the `新建文件夹` menu item SHALL be located at page scope because the primitives portal them outside `main`. Reload SHALL retain the same nonempty ws ID, selected workspace and loaded files/walk-out. Existing browser/auth error accounting SHALL remain exact; no existing directory may substitute for creation proof.

#### Scenario: 肉眼可辨夹具的预览
- **WHEN** the journey selects readme.md, notes.csv and logo.png in turn from the replaced tracked fixture
- **THEN** the rendered readme shows level-1 heading `smoke-fixture` and its source view's first numbered line is `# smoke-fixture`; the CSV preview has exactly five rows including `alpha 1` and `beta 2` and the note `共 4 行 · 大文件仅预览前若干行`; the image preview named `logo.png` decodes to 256×256

#### Scenario: 文件面走查全绿
- **WHEN** local or CI runs the full journey against caller-owned real compiled server, tracked fixtures and real omp/fake-upstream
- **THEN** files selection/creation, exact previews, root creation and same-workspace reload all pass, with exactly the existing two unauthorized auth/me events and zero unexpected console/page errors

#### Scenario: 错误预览内容不可假绿
- **WHEN** an isolated caller-owned fixture has an incorrect Markdown heading
- **THEN** the real journey fails its preview assertion; restoring tracked bytes restores the full journey without weakening the error oracle

#### Scenario: 目录创建挂起期焦点留在模态内
- **WHEN** the journey submits walk-out creation by keyboard while `POST /api/workspaces/<id>/dirs` is held
- **THEN** the held request is observed, then the dialog's `关闭` button is focused and Tab/Shift+Tab/Tab keep the active element inside the `新建文件夹` dialog, and after release the `展开 walk-out` row is visible with the existing reload and browser-error oracle unchanged
