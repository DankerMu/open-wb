# files-harness Specification

## Purpose
Provide tracked sandbox inputs and repeatable independent HTTP evidence for workspace ownership, directory conflicts, traversal auditing and safe file previews on caller-owned running services.
## Requirements
### Requirement: 沙箱夹具与 files.hurl
仓库 SHALL 跟踪 `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md, notes.csv, logo.png}`（readme 含一个 `# ` 标题；csv 表头 + 2 行；png 为最小合法 PNG）。`smoke/files.hurl` SHALL 从空 cookie store 独立可运行且**可重复**（Hurl 无条件分支，重复性以宽容状态码表达）：登录 zhangsan → `POST /api/workspaces {name:"smoke-fixture"}` 断言 status ∈ {201,409}（首跑 201 采用夹具目录，重跑 409）→ `GET /api/workspaces` 以 `captures` 按 name 取 id → `tree` 的 file 类条目包含 `readme.md`、`notes.csv`、`logo.png` → `POST dirs {path:"out"}` 断言 status ∈ {201,409} → 再次 `POST dirs {path:"out"}` 精确 409 `conflict` → `tree?path=../..` 403 `sandbox_denied` → `GET /api/audit?limit=1` 的 `events[0].kind == "sandbox.reject"` → `file?path=readme.md` 200 精确字节 + `text/plain; charset=utf-8` + `nosniff` → `file?path=logo.png` 200 `image/png` → `file?path=notes.csv` 200 → 登出、以 lisi 登录 → 对该空间 `tree` 404 → 登出。`make smoke` SHALL 执行 `public.hurl auth.hurl chat.hurl files.hurl` **四个**文件；`files.hurl` 只在 caller 已把夹具复制到 `<SANDBOX_ROOT>/u1/` 时成立（本切片由两个既有 CI harness job 的共享脚本负责，未来 uid-isolation job 由 #132 负责；本地由 caller 负责，Makefile `smoke` 头注释写明 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`）。

#### Scenario: 用例全绿且可重复
- WHEN 对以夹具预置的服务连续两次执行 `make smoke`
- THEN 两次均通过：创建类 entry 以 status ∈ {201,409} 容忍重跑、id 由 `captures` 从列表取得，重复建目录的精确 409 断言每次成立；越界、审计、预览与他账号 404 断言每次都真实执行；用例结束不留下会话行

#### Scenario: 拒绝记录与当前请求一致
- WHEN the owner records the latest audit state before requesting tree with literal path ../.. and immediately queries audit limit1 afterward
- THEN the newest event SHALL be demonstrably new relative to that pre-request state and have sandbox.reject kind, the captured workspace identity and detail relPath ../.. / op list; even an identical retained rejection from the previous run SHALL NOT satisfy the oracle

### Requirement: 走查 /files 步骤
`make ui-walk` SHALL extend the existing serial journey after four-route traversal and before dialogue with real UI selection or creation of smoke-fixture. The caller SHALL supply tracked readme.md/notes.csv/logo.png and an absent walk-out in an owned fresh sandbox. The journey SHALL wait for loaded workspace selection and actual root file entries, assert rendered smoke-fixture heading and numbered Markdown source containing # smoke-fixture, and assert CSV name/value headers, alpha/1 and beta/2 plus two data rows. It SHALL create walk-out at root through the UI and assert a directory row. Reload SHALL retain the same nonempty ws ID, selected workspace and loaded files/walk-out. Existing browser/auth error accounting SHALL remain exact; no existing directory may substitute for creation proof.

#### Scenario: 文件面走查全绿
- **WHEN** local or CI runs the full journey against caller-owned real compiled server, tracked fixtures and real omp/fake-upstream
- **THEN** files selection/creation, exact previews, root creation and same-workspace reload all pass, with exactly the existing two unauthorized auth/me events and zero unexpected console/page errors

#### Scenario: 错误预览内容不可假绿
- **WHEN** an isolated caller-owned fixture has an incorrect Markdown heading
- **THEN** the real journey fails its preview assertion; restoring tracked bytes restores the full journey without weakening the error oracle

### Requirement: 控制面与 oracle 同步
AGENTS.md Directory Map 的 server/ 描述 SHALL 含沙箱、审计、工作空间并保留对话职责，smoke/ 描述 SHALL 提及沙箱夹具并保留对话链路与深链 exact-byte fixture。Verification Matrix 的 HTTP smoke evidence SHALL 逐一列出 public.hurl、auth.hurl、chat.hurl、files.hurl 四文件真实HTTP断言全绿及退出码0，保持调用方拥有已运行服务；各行命令、UI走查行及其errororacle、十个verification surfaces SHALL 不变。既有四文件Make recipe、八directjob/aggregate、OMP_USER透传、checkout8/setup-node6及已证明UIDdowngrade关闭 SHALL 保持此前已晋升合同。相关文案与source-derived oracle/mutation anchors SHALL 同PR同步，不改解析逻辑或阈值，不固定随轮询变化的请求总数。

#### Scenario: oracle 随控制面文案同步
- **WHEN** make test-guardrails validates the active Directory Map and HTTP evidence after the documentation cutover
- **THEN** exact sandbox-fixture/four-file wording passes; stale or missing wording fails the existing owner-aware oracle, restored baseline passes, and prior controls remain intact

