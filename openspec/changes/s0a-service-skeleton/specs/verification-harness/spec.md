# Spec: verification-harness

## ADDED Requirements

### Requirement: HTTP smoke（hurl）
`smoke/` 下 SHALL 有 hurl 用例覆盖：healthz、info、登录成功/凭证错误/停用（断言信封 `$.error.message` 逐字文案）、守卫 401、伪造 session id 401、登出、深链 fallback、API 404 信封；`make smoke` SHALL 对运行中的服务执行全部用例；本机缺 hurl 时目标 SHALL 以显式失败退出并打印安装指引。

#### Scenario: 冒烟全绿
- WHEN 服务启动后执行 `make smoke`
- THEN 全部 hurl 用例通过，退出码 0

### Requirement: UI 走查（Playwright）
`make ui-walk` SHALL 以 chromium 执行：登录 → 四路由可达 → 主题切换持久 → 侧栏页脚退出登录；SHALL 断言零**浏览器控制台**错误（服务端 stderr 的 ExperimentalWarning 不计入）。

#### Scenario: 走查通过
- WHEN 执行 `make ui-walk`
- THEN 全部步骤通过，任何页面无 console error，退出码 0

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 进 CI 独立 job（安装 hurl 与 Playwright browser，先 `npm run build --workspace web` 再起服务执行），并纳入 `all-checks-passed` 聚合。控制面 SHALL 四处同步：AGENTS.md Verification Matrix 两条 READINESS GAP 行替换为真实命令 + Enforcement Index 两行升 block + Known blind spots 删除过期 gap 条目 + Directory Map 增 `smoke/`；`constraints.yaml` verification.surfaces 增 smoke 与 ui-walk 两条（command/evidence 齐全）；Makefile 增目标并同步 `.PHONY`（Makefile 头注释"三处同步"契约）。

#### Scenario: CI 聚合覆盖
- WHEN CI 在 PR 上运行
- THEN smoke 与 ui-walk 作为独立 job 出现且为 `all-checks-passed` 的 needs 成员，失败即聚合失败

#### Scenario: 控制面一致
- WHEN 比对 AGENTS.md Verification Matrix、constraints.yaml verification.surfaces 与 Makefile 目标集合
- THEN smoke 与 ui-walk 三处同时存在且命令一致，AGENTS.md 无 READINESS GAP 字样、Known blind spots 无过期条目
