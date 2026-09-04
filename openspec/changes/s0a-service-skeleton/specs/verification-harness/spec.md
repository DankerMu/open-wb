# Spec: verification-harness

## ADDED Requirements

### Requirement: HTTP smoke（hurl）
`smoke/` 下 SHALL 有彼此独立、无需跨文件 cookie 或文件顺序的 Hurl 用例：`public.hurl` 覆盖 healthz、info、默认守卫 401、显式伪造 session id 401 与深链 fallback；`auth.hurl` 覆盖登录成功/凭证错误/停用（逐字断言 `$.error.message`）、已认证 API 404、登出与登出后 401。`make smoke` SHALL 只对已运行服务执行这两个 top-level 文件：唯一输入 `SMOKE_BASE_URL` 缺省为 `http://127.0.0.1:3000`，并作为 `base_url` 传给单 job、zero-retry test-mode Hurl；目标不得 build/start/stop 服务或安装工具。Hurl SHALL 仅从 caller PATH 发现并在只含 PATH 的 clean child environment 中运行，不能继承 ambient Hurl option/variable、credential、proxy 或 config/home state。深链 exact-byte 合同只在 caller 以 `STATIC_ROOT=<repo>/smoke/fixtures/static` 启动服务时成立，不以 default `make dev`/`web/dist` 为绿路径。本机缺 Hurl 时目标 SHALL 在任何请求前非零退出并打印命名 `hurl` 的官方安装指引。Makefile 的 target 先于 #18 的 AGENTS/constraints/CI 镜像落地，是此 shared change 明文批准的阶段性例外；#18 SHALL 原子完成同步。

#### Scenario: 独立公开面与深链用例全绿
- **GIVEN** #7 production entry 以临时 DB、free loopback port 和包含 tracked `index.html` 的 smoke fixture static root 运行
- **WHEN** 对该 origin 执行 `make smoke SMOKE_BASE_URL=<origin>`
- **THEN** healthz/info 返回 exact 200 JSON，`GET /files?smoke=deep-link` 返回 200、exact `Content-Type: text/html; charset=utf-8` 与 tracked `smoke/fixtures/static/index.html` bytes，独立 public 用例不产生或消费另一文件的 cookie

#### Scenario: 认证状态链全绿且可重复
- **GIVEN** 同一 Hurl 文件从空 cookie store 开始，并使用固定 dev seed 凭证
- **WHEN** 顺序执行凭证错误、停用账号、成功登录、已认证未知 API、无 body 登出和登出后受保护请求
- **THEN** 分别得到 exact 401 invalid_credentials 中文 message、403 account_disabled 中文 message、200 exact Principal + session cookie、404 not_found 信封、204 empty/no-store + exact `Set-Cookie: workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`、401 unauthorized，且两次完整运行均通过且不留下 live session row

#### Scenario: 无会话与伪造会话均 fail closed
- **WHEN** protected unknown API 分别收到无 cookie 与显式伪造的 64-lowercase-hex `workbuddy_session`
- **THEN** 两者均返回 exact 401 unauthorized 信封，伪造 cookie 不成为任何后续 entry 或另一 Hurl 文件的状态

#### Scenario: 工具或被测服务失败显式传播
- **WHEN** Hurl 不在 controlled `PATH`，service 不可达，static root/任一 HTTP status、body、message、cookie 合同错误，`SMOKE_BASE_URL`或PATH component含shell/Make metacharacter与command-substitution-shaped bytes，或parent environment含no-assert/infinite-retry/user/proxy/config等Hurl option state
- **THEN** `make smoke` 非零；缺工具路径在任何请求前打印 `错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html`，不得 silent skip、下载工具或接管服务/DB/temp cleanup；base URL与PATH完整值只能作为 inert data，不能执行副作用或吞掉 Hurl nonzero；Hurl child只含PATH，assertions保持启用、retry固定0、请求不带ambient Authorization/proxy/config

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
