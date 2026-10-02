# Spec delta: files-harness（#539，父 tasks 8.1）

> 两条 Requirement 按主规格现文整段重述，只把 `make smoke` 的文件数与文件清单从四文件改为五文件（追加 `session-meta.hurl`）；其余字句逐字不变。父 delta 没有这两条——父 change 归档前 rebase 时须带上。

## MODIFIED Requirements

### Requirement: 沙箱夹具与 files.hurl
仓库 SHALL 跟踪 `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md, notes.csv, logo.png}`（肉眼可辨：`readme.md` 首行固定为 `# smoke-fixture`，另含二级标题、无序列表、代码块与表格各至少一个；`notes.csv` 表头 `name,value` + 4 行数据，首两行固定为 `alpha,1`、`beta,2`；`logo.png` 为 256×256 的自绘品牌色几何图形 PNG（非上游资产），生成脚本不入库，`smoke/fixtures/README.md` 记录三文件用途与 `logo.png` 的生成方式；`smoke/files.hurl` 以 `file,fixtures/…;` 自引用比对字节，内容变化时自动跟随，不含长度/大小字面断言）。`smoke/files.hurl` SHALL 从空 cookie store 独立可运行且**可重复**（Hurl 无条件分支，重复性以宽容状态码表达）：登录 zhangsan → `POST /api/workspaces {name:"smoke-fixture"}` 断言 status ∈ {201,409}（首跑 201 采用夹具目录，重跑 409）→ `GET /api/workspaces` 以 `captures` 按 name 取 id → `tree` 的 file 类条目包含 `readme.md`、`notes.csv`、`logo.png` → `POST dirs {path:"out"}` 断言 status ∈ {201,409} → 再次 `POST dirs {path:"out"}` 精确 409 `conflict` → `tree?path=../..` 403 `sandbox_denied` → `GET /api/audit?limit=1` 的 `events[0].kind == "sandbox.reject"` → `file?path=readme.md` 200 精确字节 + `text/plain; charset=utf-8` + `nosniff` → `file?path=logo.png` 200 `image/png` → `file?path=notes.csv` 200 → 登出、以 lisi 登录 → 对该空间 `tree` 404 → 登出。`make smoke` SHALL 执行 `public.hurl auth.hurl chat.hurl files.hurl session-meta.hurl` **五个**文件；`files.hurl` 只在 caller 已把夹具复制到 `<SANDBOX_ROOT>/u1/` 时成立（本切片由两个既有 CI harness job 的共享脚本负责，未来 uid-isolation job 由 #132 负责；本地由 caller 负责，Makefile `smoke` 头注释写明 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`）。

#### Scenario: 用例全绿且可重复
- WHEN 对以夹具预置的服务连续两次执行 `make smoke`
- THEN 两次均通过：创建类 entry 以 status ∈ {201,409} 容忍重跑、id 由 `captures` 从列表取得，重复建目录的精确 409 断言每次成立；越界、审计、预览与他账号 404 断言每次都真实执行；用例结束不留下会话行

#### Scenario: 拒绝记录与当前请求一致
- WHEN the owner records the latest audit state before requesting tree with literal path ../.. and immediately queries audit limit1 afterward
- THEN the newest event SHALL be demonstrably new relative to that pre-request state and have sandbox.reject kind, the captured workspace identity and detail relPath ../.. / op list; even an identical retained rejection from the previous run SHALL NOT satisfy the oracle

### Requirement: 控制面与 oracle 同步
AGENTS.md Directory Map 的 server/ 描述 SHALL 含沙箱、审计、工作空间并保留对话职责，smoke/ 描述 SHALL 提及沙箱夹具并保留对话链路与深链 exact-byte fixture。Verification Matrix 的 HTTP smoke evidence SHALL 逐一列出 public.hurl、auth.hurl、chat.hurl、files.hurl、session-meta.hurl 五文件真实HTTP断言全绿及退出码0，保持调用方拥有已运行服务；各行命令、UI走查行及其errororacle、十个verification surfaces SHALL 不变。既有五文件Make recipe、八directjob/aggregate、OMP_USER透传、checkout8/setup-node6及已证明UIDdowngrade关闭 SHALL 保持此前已晋升合同。相关文案与source-derived oracle/mutation anchors SHALL 同PR同步，不改解析逻辑或阈值，不固定随轮询变化的请求总数。

#### Scenario: oracle 随控制面文案同步
- **WHEN** make test-guardrails validates the active Directory Map and HTTP evidence after the documentation cutover
- **THEN** exact sandbox-fixture/five-file wording passes; stale or missing wording fails the existing owner-aware oracle, restored baseline passes, and prior controls remain intact
