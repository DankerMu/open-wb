## ADDED Requirements

### Requirement: 走查 /files 步骤
`make ui-walk` SHALL extend the existing serial journey after four-route traversal and before dialogue with real UI selection or creation of smoke-fixture. The caller SHALL supply tracked readme.md/notes.csv/logo.png and an absent walk-out in an owned fresh sandbox. The journey SHALL wait for loaded workspace selection and actual root file entries, assert rendered smoke-fixture heading and numbered Markdown source containing # smoke-fixture, and assert CSV name/value headers, alpha/1 and beta/2 plus two data rows. It SHALL create walk-out at root through the UI and assert a directory row. Reload SHALL retain the same nonempty ws ID, selected workspace and loaded files/walk-out. Existing browser/auth error accounting SHALL remain exact; no existing directory may substitute for creation proof.

#### Scenario: 文件面走查全绿
- **WHEN** local or CI runs the full journey against caller-owned real compiled server, tracked fixtures and real omp/fake-upstream
- **THEN** files selection/creation, exact previews, root creation and same-workspace reload all pass, with exactly the existing two unauthorized auth/me events and zero unexpected console/page errors

#### Scenario: 错误预览内容不可假绿
- **WHEN** an isolated caller-owned fixture has an incorrect Markdown heading
- **THEN** the real journey fails its preview assertion; restoring tracked bytes restores the full journey without weakening the error oracle
