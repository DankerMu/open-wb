## MODIFIED Requirements

### Requirement: 沙箱夹具与 files.hurl
仓库 SHALL 跟踪 `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md, notes.csv, logo.png}`（肉眼可辨：`readme.md` 首行固定为 `# smoke-fixture`，另含二级标题、无序列表、代码块与表格各至少一个；`notes.csv` 表头 `name,value` + 4 行数据，首两行固定为 `alpha,1`、`beta,2`；`logo.png` 为 256×256 的自绘品牌色几何图形 PNG（非上游资产），生成脚本不入库，`smoke/fixtures/README.md` 记录三文件用途与 `logo.png` 的生成方式；`smoke/files.hurl` 以 `file,fixtures/…;` 自引用比对字节，内容变化时自动跟随，不含长度/大小字面断言）。`smoke/files.hurl` SHALL 从空 cookie store 独立可运行且**可重复**（Hurl 无条件分支，重复性以宽容状态码表达）：登录 zhangsan → `POST /api/workspaces {name:"smoke-fixture"}` 断言 status ∈ {201,409}（首跑 201 采用夹具目录，重跑 409）→ `GET /api/workspaces` 以 `captures` 按 name 取 id → `tree` 的 file 类条目包含 `readme.md`、`notes.csv`、`logo.png` → `POST dirs {path:"out"}` 断言 status ∈ {201,409} → 再次 `POST dirs {path:"out"}` 精确 409 `conflict` → `tree?path=../..` 403 `sandbox_denied` → `GET /api/audit?limit=1` 的 `events[0].kind == "sandbox.reject"` → `file?path=readme.md` 200 精确字节 + `text/plain; charset=utf-8` + `nosniff` → `file?path=logo.png` 200 `image/png` → `file?path=notes.csv` 200 → 登出、以 lisi 登录 → 对该空间 `tree` 404 → 登出。`make smoke` SHALL 执行 `public.hurl auth.hurl chat.hurl files.hurl` **四个**文件；`files.hurl` 只在 caller 已把夹具复制到 `<SANDBOX_ROOT>/u1/` 时成立（本切片由两个既有 CI harness job 的共享脚本负责，未来 uid-isolation job 由 #132 负责；本地由 caller 负责，Makefile `smoke` 头注释写明 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`）。

#### Scenario: 用例全绿且可重复
- WHEN 对以夹具预置的服务连续两次执行 `make smoke`
- THEN 两次均通过：创建类 entry 以 status ∈ {201,409} 容忍重跑、id 由 `captures` 从列表取得，重复建目录的精确 409 断言每次成立；越界、审计、预览与他账号 404 断言每次都真实执行；用例结束不留下会话行

#### Scenario: 拒绝记录与当前请求一致
- WHEN the owner records the latest audit state before requesting tree with literal path ../.. and immediately queries audit limit1 afterward
- THEN the newest event SHALL be demonstrably new relative to that pre-request state and have sandbox.reject kind, the captured workspace identity and detail relPath ../.. / op list; even an identical retained rejection from the previous run SHALL NOT satisfy the oracle

### Requirement: 走查 /files 步骤
`make ui-walk` SHALL extend the existing serial journey after four-route traversal and before dialogue with real UI selection or creation of smoke-fixture. The caller SHALL supply tracked readme.md/notes.csv/logo.png and an absent walk-out in an owned fresh sandbox. The journey SHALL wait for loaded workspace selection and actual root file entries, assert rendered smoke-fixture heading and numbered Markdown source containing # smoke-fixture, and assert CSV name/value headers, alpha/1 and beta/2, exactly five table rows (header plus four data rows) and the note `共 4 行 · 大文件仅预览前若干行`, and, after selecting logo.png, a preview image named `logo.png` whose `naturalWidth` and `naturalHeight` are both 256. It SHALL create walk-out at root through the UI and assert a directory row. Reload SHALL retain the same nonempty ws ID, selected workspace and loaded files/walk-out. Existing browser/auth error accounting SHALL remain exact; no existing directory may substitute for creation proof.

#### Scenario: 肉眼可辨夹具的预览
- **WHEN** the journey selects readme.md, notes.csv and logo.png in turn from the replaced tracked fixture
- **THEN** the rendered readme shows level-1 heading `smoke-fixture` and its source view's first numbered line is `# smoke-fixture`; the CSV preview has exactly five rows including `alpha 1` and `beta 2` and the note `共 4 行 · 大文件仅预览前若干行`; the image preview named `logo.png` decodes to 256×256

#### Scenario: 文件面走查全绿
- **WHEN** local or CI runs the full journey against caller-owned real compiled server, tracked fixtures and real omp/fake-upstream
- **THEN** files selection/creation, exact previews, root creation and same-workspace reload all pass, with exactly the existing two unauthorized auth/me events and zero unexpected console/page errors

#### Scenario: 错误预览内容不可假绿
- **WHEN** an isolated caller-owned fixture has an incorrect Markdown heading
- **THEN** the real journey fails its preview assertion; restoring tracked bytes restores the full journey without weakening the error oracle
