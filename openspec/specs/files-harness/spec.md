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
