# Spec: files-harness

## ADDED Requirements

### Requirement: 沙箱夹具与 files.hurl
仓库 SHALL 跟踪 `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md, notes.csv, logo.png}`（readme 含一个 `# ` 标题；csv 表头 + 2 行；png 为最小合法 PNG）。`smoke/files.hurl` SHALL 从空 cookie store 独立可运行且**可重复**（Hurl 无条件分支，重复性以宽容状态码表达）：登录 zhangsan → `POST /api/workspaces {name:"smoke-fixture"}` 断言 status ∈ {201,409}（首跑 201 采用夹具目录，重跑 409）→ `GET /api/workspaces` 以 `captures` 按 name 取 id → `tree` 的 file 类条目包含 `readme.md`、`notes.csv`、`logo.png` → `POST dirs {path:"out"}` 断言 status ∈ {201,409} → 再次 `POST dirs {path:"out"}` 精确 409 `conflict` → `tree?path=../..` 403 `sandbox_denied` → `GET /api/audit?limit=1` 的 `events[0].kind == "sandbox.reject"` → `file?path=readme.md` 200 精确字节 + `text/plain; charset=utf-8` + `nosniff` → `file?path=logo.png` 200 `image/png` → `file?path=notes.csv` 200 → 登出、以 lisi 登录 → 对该空间 `tree` 404。`make smoke` SHALL 执行 `public.hurl auth.hurl chat.hurl files.hurl` **四个**文件；`files.hurl` 只在 caller 已把夹具复制到 `<SANDBOX_ROOT>/u1/` 时成立（三个 CI harness job 的脚本各自负责；本地由 caller 负责，Makefile `smoke` 头注释写明 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`）。

#### Scenario: 用例全绿且可重复
- WHEN 对以夹具预置的服务连续两次执行 `make smoke`
- THEN 两次均通过：创建类 entry 以 status ∈ {201,409} 容忍重跑、id 由 `captures` 从列表取得，重复建目录的精确 409 断言每次成立；越界、审计、预览与他账号 404 断言每次都真实执行；用例结束不留下会话行

### Requirement: 走查 /files 步骤
`make ui-walk` 的 journey SHALL 在四路由访问之后、对话步骤之前增加：在 `/files` 打开切换器选择 `smoke-fixture`（URL 含 `?ws=`）→ 树中出现 `readme.md`、`notes.csv`、`logo.png` → 点击 `readme.md` 看到渲染后的一级标题与 `查看源码` 按钮，点击后看到行号表 → 点击 `notes.csv` 看到表格与 `共 2 行` → `＋` → `新建文件夹`，位置选根、名称 `walk-out`，创建后树中出现 `walk-out`（dir）→ reload 后 `?ws=` 保持且 `walk-out` 仍在。console error oracle 与两次 401 预算不变。CI ui-walk job 的脚本 SHALL 同样预置夹具，并保证 `smoke-fixture` 空间存在（走查自行创建：不存在则先经 `＋ → 新建工作空间` 创建 `smoke-fixture`）。

#### Scenario: 文件面走查全绿
- WHEN CI `ui-walk` 运行完整 journey
- THEN 上述步骤全部通过，零非预期 console/page error，退出码 0

### Requirement: 控制面与 oracle 同步
AGENTS.md Directory Map 的 `server/` 描述 SHALL 含沙箱/审计/工作空间，`smoke/` 描述 SHALL 提及沙箱夹具；`constraints.yaml verification.surfaces` 不新增条目（无新 make 目标），`downgrades` 按 omp-uid-isolation 删除 `/proc` 条目；`scripts/test-ci-harness.sh` 的 `make smoke` recipe 期望行（四文件）、AGENTS 行、workflow 形状（新 job、八 direct job、aggregate needs）、`ci-compiled-server.sh` 的 `OMP_USER` 透传期望行与 `scripts/inspect-ci-workflow.js` 的 `WANT`（checkout 8、setup-node 6）SHALL 与改动同 PR 更新，`make test-guardrails` 绿。

#### Scenario: oracle 随改动同步
- WHEN 合并任一改动 Makefile smoke recipe / AGENTS.md / ci.yml 的 PR
- THEN 该 PR 的 `make test-guardrails` 绿，且 baseline/mutation 控制组仍分别 PASS/FAIL
