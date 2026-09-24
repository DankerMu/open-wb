# Spec delta: verification-harness（S0b 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement（共享 Vitest ESM 边界、Node 24 action、size-guard 诊断、System Bash 守卫、ServiceInfo 泄漏 oracle）不变。

## MODIFIED Requirements

### Requirement: HTTP smoke（hurl）
`smoke/` 下 SHALL 有彼此独立、无需跨文件 cookie 或文件顺序的 Hurl 用例：`public.hurl` 覆盖 healthz、info、默认守卫 401、显式伪造 session id 401 与深链 fallback；`auth.hurl` 覆盖登录成功/凭证错误/停用（逐字断言 `$.error.message`）、已认证 API 404、登出与登出后 401；`chat.hurl` 覆盖 chat-harness 规定的对话链路（创建会话、prompt 受理、轮询至 done、正文与步骤断言、他账号 404、`/v1` 无 bearer 401）。`make smoke` SHALL 只对已运行服务执行这**三个** top-level 文件：唯一输入 `SMOKE_BASE_URL` 缺省为 `http://127.0.0.1:3000`，并作为 `base_url` 传给单 job、全局 `--retry 0` 的 test-mode Hurl（`chat.hurl` 的轮询以文件内 per-entry `[Options] retry` 实现，不改全局值）；目标不得 build/start/stop 服务或安装工具。Hurl SHALL 仅从 caller PATH 发现并在只含 PATH 的 clean child environment 中运行，不能继承 ambient Hurl option/variable、credential、proxy 或 config/home state。深链 exact-byte 合同只在 caller 以 `STATIC_ROOT=<repo>/smoke/fixtures/static` 启动服务时成立，不以 default `make dev`/`web/dist` 为绿路径；`chat.hurl` 只在 caller 以真实 v18.0.10 omp（`OMP_BIN`）与假上游（`MODEL_UPSTREAM_BASE_URL`）启动服务时成立。本机缺 Hurl 时目标 SHALL 在任何请求前非零退出并打印命名 `hurl` 的官方安装指引。`make smoke-live` SHALL 在 `MODEL_UPSTREAM_BASE_URL` 或 `MODEL_UPSTREAM_API_KEY` 缺失时显式失败并打印缺失变量名，否则对已运行服务只执行 `chat.hurl` 并以 hurl 变量放宽为形状断言（`content_pattern='^.+$'`、`min_bash_steps=0`：status done、正文非空）；`make smoke` 对同一文件传 `content_pattern='^你好，这是 WorkBuddy 的第一条流式回复。$'`、`min_bash_steps=1`。

#### Scenario: 独立公开面与深链用例全绿
- **GIVEN** production entry 以临时 DB、free loopback port 和包含 tracked `index.html` 的 smoke fixture static root 运行
- **WHEN** 对该 origin 执行 `make smoke SMOKE_BASE_URL=<origin>`
- **THEN** healthz/info 返回 exact 200 JSON，`GET /files?smoke=deep-link` 返回 200、exact `Content-Type: text/html; charset=utf-8` 与 tracked `smoke/fixtures/static/index.html` bytes，独立 public 用例不产生或消费另一文件的 cookie

#### Scenario: 认证状态链全绿且可重复
- **GIVEN** 同一 Hurl 文件从空 cookie store 开始，并使用固定 dev seed 凭证
- **WHEN** 顺序执行凭证错误、停用账号、成功登录、已认证未知 API、无 body 登出和登出后受保护请求
- **THEN** 分别得到 exact 401 invalid_credentials 中文 message、403 account_disabled 中文 message、200 exact Principal + session cookie、404 not_found 信封、204 empty/no-store + exact `Set-Cookie: workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`、401 unauthorized，且两次完整运行均通过且不留下 live session row

#### Scenario: 无会话与伪造会话均 fail closed
- **WHEN** protected unknown API 分别收到无 cookie 与显式伪造的 64-lowercase-hex `workbuddy_session`
- **THEN** 两者均返回 exact 401 unauthorized 信封，伪造 cookie 不成为任何后续 entry 或另一 Hurl 文件的状态

#### Scenario: 对话链路用例全绿
- **GIVEN** 服务以真实 v18.0.10 omp 与假上游运行，`chat.hurl` 从空 cookie store 开始
- **WHEN** 登录 → `POST /api/sessions`（201）→ prompt（202）→ per-entry retry 轮询 messages 直到 assistant `status=="done"`
- **THEN** 正文匹配 `make smoke` 传入的精确锚定 `content_pattern`（即等于假上游固定文本）、`bash` 步骤数 ≥1 且无非 `done` 步骤、会话 `status=="done"`；另一账号访问该会话为 404；`POST /v1/chat/completions` 无 bearer 为 401；用例不留下运行中的回合

#### Scenario: 工具或被测服务失败显式传播
- **WHEN** Hurl 不在 controlled `PATH`，service 不可达，static root/任一 HTTP status、body、message、cookie 合同错误，`SMOKE_BASE_URL` 或 PATH component 含 shell/Make metacharacter 与 command-substitution-shaped bytes，或 parent environment 含 no-assert/infinite-retry/user/proxy/config 等 Hurl option state，或 `make smoke-live` 缺上游 env
- **THEN** `make smoke`/`make smoke-live` 非零；缺工具路径在任何请求前打印 `错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html`，缺 env 路径打印缺失变量名，不得 silent skip、下载工具或接管服务/DB/temp cleanup；base URL 与 PATH 完整值只能作为 inert data，不能执行副作用或吞掉 Hurl nonzero；Hurl child 只含 PATH，assertions 保持启用、全局 retry 固定 0、请求不带 ambient Authorization/proxy/config

### Requirement: UI 走查（Playwright）
`make ui-walk` SHALL 只消费由 caller 启动、可从 `UI_WALK_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务；目标不得 build、start、stop、安装浏览器或拥有 DB/temp cleanup。目标 SHALL 以 Playwright 管理的全新 Chromium context 串行执行一条生产路径：从 `/files` 登录 dev-stub 账号 → 经真实侧栏逐项访问四个受支持路由 → 在 `/` 新建会话、发送固定提示、等待步骤卡出现并变为 done、**在回合进行中（步骤卡出现后、turn.end 前）reload 页面并续到同一完整结果**、正文最终等于假上游固定文本且状态 done、回合结束后再次 reload 消息列表仍完整 → 在 `/settings` 切换深色主题并 reload 验证持久化 → 从侧栏页脚确认退出并 reload 验证会话仍为未登录。走查 SHALL 从首个 navigation 前开始收集并最终断言零非预期浏览器 `console.error` 和零 uncaught page error；本 journey 必须同时观测恰两次 `GET /api/auth/me` → 401（初始未登录、退出后 reload），仅与这两次响应同源、location pathname 恰为 `/api/auth/me` 且文本恰为 Chromium 固定 401 transport diagnostic 的 console 事件不计入错误预算，任何额外/不匹配 401 或其他 console error 仍失败；对话步骤中的 `EventSource` 重连不得产生 console error。服务端 stderr（包括 `node:sqlite` ExperimentalWarning）不属于该浏览器 oracle。

#### Scenario: 登录、四路由、对话、主题持久与退出全绿
- **GIVEN** caller 以 fresh 临时 DB、真实 `web/dist`、真实 v18.0.10 omp 与假上游启动 production server，且 Playwright context 初始无 cookie/localStorage
- **WHEN** 对 `/files` 执行 `make ui-walk`，以 `zhangsan`/`demo` 登录，再依次访问 `/`、`/files`、`/center`、`/settings`，并在 `/` 完成对话步骤
- **THEN** 登录后仍在 `/files`，每一路由显示对应页面标题且恰有一个当前导航项；页脚显示 exact `zhangsan`/`成员`
- **AND** 在 `/` 新建会话后 URL 含 `?session=<id>`，发送提示后出现 `bash` 步骤卡并变为 done；回合中 reload 后同一会话被恢复且最终正文等于假上游固定文本、状态 done；回合后 reload 消息列表仍含 user 与 assistant 两条
- **AND** 选择 `深色` 后根元素 `data-theme=dark`、`workbuddy-theme=dark`，reload 后仍选中深色且显示 `当前生效：深色`
- **AND** 点击 `退出登录`、在 `alertdialog` 中点击 `退出` 后原 `/settings` 显示 `登录 WorkBuddy`，session cookie 被清除，reload 后仍未登录
- **AND** 恰有两次 expected `/api/auth/me` 401；除与其 exact path/text 绑定的 Chromium transport diagnostic 外无 browser console error，且无 page error，Playwright 退出码为 0

#### Scenario: 目标边界与失败传播
- **WHEN** Playwright/Chromium 缺失、`UI_WALK_BASE_URL` 不可达、任一 UI/API/持久化/对话/退出断言失败，或页面产生 console/page error
- **THEN** `make ui-walk` 非零且不得 silent skip、下载依赖、启动/停止服务、创建或清理 caller 的 DB/temp/static root
- **AND** `make test` 不发现或执行 `web/e2e/**`；`make typecheck` 仍检查 Playwright 配置与走查源码

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch`（每次从 GitHub release 下载固定 v18.0.10 资产并按 SHA256 校验；不引入新的第三方 action，`第三方 CI action 使用 Node 24 runtime` 的四 action 白名单不变）并启动 job-owned 假上游进程（`.github/scripts/ci-fake-upstream.sh`，loopback 随机/固定端口），然后以 job-owned fresh runner-temp SQLite DB、`OMP_BIN`、`OMP_STATE_DIR`、`SANDBOX_ROOT`（均在 runner temp）、`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<假上游端口>/v1`、`MODEL_UPSTREAM_API_KEY=fake` 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与任何 omp 子进程）与临时状态；`ci-compiled-server.sh` 的进程组、取消与清理契约不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。真实上游 URL 与任何 secret 引用 SHALL 不出现在任一 workflow。工具安装、omp 拉取校验、假上游启动、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential/bearer。

控制面 SHALL 同步：AGENTS.md Verification Matrix 含 exact `make smoke` / `make ui-walk` + evidence，并新增 `make omp-fetch`（前置，evidence：`var/omp/omp --version` = `omp/18.0.10`）与 `make smoke-live`（手动，evidence：退出码 0，真实上游）两行；Enforcement Index smoke/ui-walk 两行为 `block`，`smoke-live` 为 `review-only`（手动目标不进 CI）；Directory Map 含 `smoke/` 且 `server/` 描述含对话链路。`constraints.yaml` `verification.surfaces` 含 `smoke`、`ui-walk`、`omp-fetch`、`smoke-live` 四条，command 分别逐字为 `make smoke` / `make ui-walk` / `make omp-fetch` / `make smoke-live` 且 evidence 齐全；`downgrades` 含 S0b 同 uid 窗口的 `/proc` 凭证读取向量一条（ADR-0010 于 S1a 关闭）。Makefile 的同名 targets 与 `.PHONY`/头注释 SHALL 保持一致；source-derived oracle SHALL 拒绝 `smoke :` / `ui-walk :` / `omp-fetch :` / `smoke-live :` 等 GNU Make 等价 duplicate/redefinition，使 canonical recipe 不得被保留文本旁路。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。unit-tests、secret-scan、sast 的 timeout 与步骤，smoke/ui-walk 的 timeout，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

#### Scenario: 两个真实 harness job 独立全绿并进入聚合
- **GIVEN** fresh Ubuntu runners、受 lockfile 约束的 Node dependencies、固定 Hurl archive digest、固定 omp v18.0.10 release digest 与 Playwright Chromium revision
- **WHEN** CI 分别运行 `smoke` 与 `ui-walk`
- **THEN** 两者都先 build Web/server、完成 omp 拉取（下载 + SHA256 校验）、启动各自的假上游，分别用 isolated DB/process/static root/omp state 启动 production server；`make smoke` 的三个 hurl 文件（public/auth/chat）与 `make ui-walk` 的完整 Chromium journey（含对话步骤）全绿，cleanup 后无残留 omp/假上游进程，job 退出 0
- **AND** `all-checks-passed.needs` 同时包含两个 job；任一 job failure/cancelled/skipped 时 aggregate 非零；smoke/ui-walk 两 job 不含真实模型上游 URL 或 `secrets.` 引用；既有 secret-scan 的 GITHUB_TOKEN 按 canonical action 契约保留（#105 用户确认的范围澄清）

#### Scenario: 工具、服务或测试失败不得假绿或污染 sibling job
- **WHEN** Hurl archive digest/解压/执行失败、omp 资产 digest 不符、假上游启动失败、Chromium 安装/启动失败、server 未 ready/提前退出、任一 harness assertion 失败或 cleanup 失败
- **THEN** 所属 job 非零并输出不含凭证/session/bearer 的必要诊断；另一 job 的 DB、port、static root、omp state、browser/cookie state 与结果不被读取、停止或删除

#### Scenario: 控制面一致
- **WHEN** 比对 AGENTS.md Verification Matrix、constraints.yaml verification.surfaces 与 Makefile target/grammar 集合，注入 `smoke :` / `ui-walk :` / `omp-fetch :` / `smoke-live :` duplicate-recipe mutation，并检查 CI jobs/aggregate
- **THEN** 四个目标的命令逐字一致、command/evidence/等级齐全（smoke/ui-walk `block`，omp-fetch 前置，smoke-live `review-only`），AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot，Directory Map 含 `smoke/`，`constraints.yaml downgrades` 含 `/proc` 向量条目，Makefile `.PHONY` 与 canonical targets 同步，四个等价 duplicate mutation 均使 source-derived oracle 非零，CI 使用且无法旁路原 recipes

#### Scenario: 安装高尾不再抢占全部质量检查预算
- **GIVEN** 历史 `npm ci` 高尾为 300–302 秒，fast-checks 后续步骤约 4–6 秒、anti-drift 后续步骤约 2–3 秒，且 10 分钟 unit-tests 在相同高尾后完成
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置运行 fast-checks 与 anti-drift
- **THEN** 两 job 各有 10 分钟总预算，`npm ci` 之后的 Biome/Ruff/typecheck 或 knip/jscpd/naming/size 步骤实际执行且成功，不以 cancelled/skipped 结束，`all-checks-passed` 成功

#### Scenario: timeout 与质量步骤不可漂移或旁路
- **WHEN** source-derived fixture 分别把任一目标 timeout 改回 5、删除或错配任一 constraints mirror、删除/替换 `npm ci` 或任一下游质量步骤、加入 job/step skip/continue/custom-shell 绕过，或使 aggregate 不再拒绝 failure/cancelled/skipped
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 与无关 legacy job 演进控制组仍通过
