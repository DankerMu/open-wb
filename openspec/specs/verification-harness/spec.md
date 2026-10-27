# verification-harness Specification

## Purpose
Defines HTTP smoke and browser walk-through surfaces plus their CI/control-plane wiring, shared test-harness invariants, and guard/oracle contracts.

## Requirements

### Requirement: HTTP smoke（hurl）
`smoke/` 下 SHALL 有彼此独立、无需跨文件 cookie 或文件顺序的 Hurl 用例：`public.hurl` 覆盖 healthz、info、默认守卫 401、显式伪造 session id 401 与深链 fallback；`auth.hurl` 覆盖登录成功/凭证错误/停用（逐字断言 `$.error.message`）、已认证 API 404、登出与登出后 401；`chat.hurl` 独立覆盖登录、创建201、prompt202、完成正文与步骤、他账号404及代理无 bearer401。`make smoke` SHALL 只对已运行服务执行public/auth/chat/files/session-meta 五个 top-level 文件：唯一输入 `SMOKE_BASE_URL` 缺省为 `http://127.0.0.1:3000`，并作为 `base_url` 传给单 job、全局 retry0 的 test-mode Hurl（仅 messages GET 允许有界 per-entry retry）；目标不得 build/start/stop 服务或安装工具。Hurl SHALL 仅从 caller PATH 发现并在只含 PATH 的 clean child environment 中运行，不能继承 ambient Hurl option/variable、credential、proxy 或 config/home state。深链 exact-byte 合同只在 caller 以 `STATIC_ROOT=<repo>/smoke/fixtures/static` 启动服务时成立，不以 default `make dev`/`web/dist` 为绿路径。本机缺 Hurl 时目标 SHALL 在任何请求前非零退出并打印命名 `hurl` 的官方安装指引。`make smoke` SHALL 传入 `content_pattern=^你好，这是 WorkBuddy 的第一条流式回复。$` 与 `min_bash_steps=1`；手动 smoke-live 保持其既有形状档契约不变。

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
- **THEN** `make smoke` 非零；缺工具路径在任何请求前打印 `错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html`，不得 silent skip、下载工具或接管服务/DB/temp cleanup；base URL与PATH完整值只能作为 inert data，不能执行副作用或吞掉 Hurl nonzero；Hurl child只含PATH，assertions保持启用、全局retry固定0、请求不带ambient Authorization/proxy/config

#### Scenario: Real runtime chat and isolation
- **WHEN** real pinned omp v18.12.3 and the controlled upstream serve the five-file smoke twice
- **THEN** both runs pass; captured assistant is done with exact configured text, at least one bash step and no non-done step, session is done; another account gets404 for the session and bearer-free model POST gets401; chat.hurl needs no earlier file cookie and leaves no live authentication session

#### Scenario: 文件烟测独立且可重复
- WHEN tracked sandbox fixtures are copied by the caller and the same running service/DB/sandbox receives two complete make smoke runs followed by standalone files.hurl with empty cookie state
- THEN files-harness assertions execute on every run, all five top-level files pass, no service is restarted/reseeded by make, and no live authentication sessions remain

### Requirement: UI 走查（Playwright）
`make ui-walk` SHALL 只消费由 caller 启动、可从 `UI_WALK_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务；目标不得 build、start、stop、安装浏览器或拥有 DB/temp cleanup。目标 SHALL 以两个 Playwright project（`desktop-light`：viewport 1440×900、`colorScheme: light`；`mobile-dark`：viewport 390×844、`colorScheme: dark`；各自全新 Chromium context，`workers: 1` 串行，共用 caller 的同一服务与沙箱，各自生成独立 gate UUID）执行同一条生产路径；每个 project 在每一路由断言 `document.documentElement.scrollWidth <= window.innerWidth` 且主区可见；布局断言按 project 分支：`desktop-light` 断侧栏宽 ≥160 且主区起点不小于侧栏右缘，在四路由遍历中对每个路由（含 `/center`）临时将 viewport 设为 1024×768 断言无横向溢出后恢复，并在 `/files` 临时将 viewport 设为 880×800 断言目录树与预览仍左右并排（预览区起点不小于目录树区右缘）且无横向溢出后恢复；`mobile-dark` 断覆盖层默认关闭、`打开导航` 在含 `/` 欢迎态的每个路由可见，并经该按钮打开覆盖层完成每次路由点击。project 私有资源以 project 名区分：创建的目录名为 `walk-out-<project>` 补齐至 ≥48 字符（同时断言该行截断且 `title` 为全名）。主题步骤按 project 分支：`desktop-light` 在 `/settings` 选 `深色` 断 `data-theme=dark`、`workbuddy-theme=dark`；`mobile-dark` 选 `浅色` 断 `data-theme=light`、`workbuddy-theme=light`；二者 reload 后持久。`desktop-light` 另在受控回合运行中对运行中会话的状态标记（`[data-status-mark="running"]`；旧的 `.ui-pulse` 工具类已随 s1f-legacy-layer-removal 删除）断言 reduced-motion 切换（见 ui-primitives「动效与图标」），并在 journey 末断言静态资源（resourceType `image|font|stylesheet|script`）零 `requestfailed`（导航/SSE 取消的 `net::ERR_ABORTED` 不计）与零非 `baseURL` 源请求——唯一的例外是隔离预览来源（preview-origin）：走查里每次 `POST /api/workspaces/<id>/preview-token` 响应的 `base` 所在的来源记为允许，发往它的请求不计入，其它任何来源仍为零。路径：从 `/files` 登录 dev-stub 账号 → 经真实侧栏逐项访问四个受支持路由 → 在 `/` 完成受控真实回合中的新建/发送/步骤/刷新续流/精确完成/完成后刷新 → 在 `/settings` 切换主题并 reload 验证持久化 → 经侧栏用户区触发按钮 `用户菜单` 打开用户菜单、选择 `退出登录` 并确认，reload 验证会话仍为未登录。`mobile-dark` 在每次断言用户区文本前先打开覆盖层。走查 SHALL 从首个 navigation 前开始收集并最终断言零非预期浏览器 `console.error` 和零 uncaught page error；本 journey 必须同时观测恰两次 `GET /api/auth/me` → 401（初始未登录、退出后 reload），仅与这两次响应同源、location pathname 恰为 `/api/auth/me` 且文本恰为 Chromium 固定 401 transport diagnostic 的 console 事件不计入错误预算，任何额外/不匹配 401 或其他 console error 仍失败。服务端 stderr（包括 `node:sqlite` ExperimentalWarning）不属于该浏览器 oracle。

#### Scenario: 登录、四路由、主题持久与退出全绿
- **GIVEN** caller 以 fresh 临时 DB 和真实 `web/dist` 启动 production server，且 Playwright context 初始无 cookie/localStorage
- **WHEN** 对 `/files` 执行 `make ui-walk`，以 `zhangsan`/`demo` 登录，再依次访问 `/`、`/files`、`/center`、`/settings`
- **THEN** 登录后仍在 `/files`，每一路由的 level-1 heading 符合 spa-shell 顶栏三态（`/` 欢迎态为 `WorkBuddy，我帮你`，其余为 `工作空间`/`中心`/`设置`）且恰有一个当前导航项；侧栏用户区（`mobile-dark` 在覆盖层打开后）显示 exact `zhangsan`/`成员`
- **AND** `desktop-light` 选择 `深色` 后根元素 `data-theme=dark`、`workbuddy-theme=dark`，reload 后仍选中深色且显示 `当前生效：深色`；`mobile-dark` 选择 `浅色` 后 `data-theme=light`、`workbuddy-theme=light`，reload 后仍选中浅色且显示 `当前生效：浅色`
- **AND** 打开用户菜单、选择 `menuitem` `退出登录` 后，在 `alertdialog` 中以键盘 Tab 聚焦 `退出` 并按 Enter，`POST /api/auth/logout` 被 route 挂起期间：活动元素为 `关闭` 按钮；依次按 Tab、Shift+Tab、Tab 后活动元素每次都仍在 `alertdialog` 内，URL 仍为 `/settings`；放行请求后原 `/settings` 显示 `登录 WorkBuddy`，session cookie 被清除，reload 后仍未登录
- **AND** 恰有两次 expected `/api/auth/me` 401；除与其 exact path/text 绑定的 Chromium transport diagnostic 外无 browser console error，且无 page error，Playwright 退出码为 0
- **AND** `desktop-light` 与 `mobile-dark` 两个 project 各自独立完成上述全部步骤；窄屏 project 经汉堡按钮打开覆盖层导航，每一路由无横向溢出；`desktop-light` 的 1024 逐路由无溢出、880 宽下目录树与预览仍左右并排且无横向溢出、reduced-motion 切换与静态资源零 `requestfailed`/零跨源请求（隔离预览来源除外）成立；两 project 的 401 计数与 console/page error 预算各自独立成立

#### Scenario: 目标边界与失败传播
- **WHEN** Playwright/Chromium 缺失、`UI_WALK_BASE_URL` 不可达、任一 UI/API/持久化/退出断言失败，或页面产生 console/page error
- **THEN** `make ui-walk` 非零且不得 silent skip、下载依赖、启动/停止服务、创建或清理 caller 的 DB/temp/static root
- **AND** `make test` 不发现或执行 `web/e2e/**`；`make typecheck` 仍检查 Playwright 配置与走查源码

#### Scenario: 真正回合中刷新并持久完成
- **GIVEN** caller使用真实官方omp18.12.3、compiled app和有界隔离gate的原测试上游，gate已arm且固定提示模板携带独立UUID
- **WHEN** 浏览器创建会话并发送，观察bash步骤与非空prefix，真实REST为running；gate保持held时reload，同session新REST和DOM保留prefix并建立native SSE，随后显式release
- **THEN** 完整正文逐字等于`你好，这是 WorkBuddy 的第一条流式回复。`，bash 步骤徽章（`role=status` 名 `bash 已完成`）与会话列表当前项 status 文本均为 `已完成`，恰一user/assistant pair；完成后reload同样完整且done；exact两次auth401及零新增console/pageerror合同不变，finally清理gate
- **AND** 不以浏览器伪造响应、fake EventSource、已完成回合的延迟展示或任意sleep冒充真正回合中刷新；其他canonical CI/HTTP requirements保持不变

After the four-route traversal and before the existing held dialogue, the journey SHALL perform files-harness「走查 /files 步骤」through the real UI. Its caller-owned sandbox SHALL contain the tracked fixture and no directory named `walk-out-<project>` or `walk-renamed-<project>` for the running project (a sibling project's directories may exist). Existing auth/error, dialogue recovery, theme, logout and lifecycle scenarios remain unchanged.

#### Scenario: 文件面预览、创建与同空间恢复
- **WHEN** the authenticated browser selects or creates smoke-fixture, opens the three-file tree, switches Markdown rendered/source views, inspects CSV, opens `logo.png` (asserting `naturalWidth === 256`) and creates the root `walk-out-<project>` directory (≥48 chars)
- **THEN** exact fixture content and the directory are visible, its tree row is truncated with `title` equal to the full name; reload preserves the same nonempty ws ID, selected workspace and restored tree, while the full existing journey and browser-error oracle still pass

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.12.3（不添加 action/cache），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 同步 AGENTS.md、constraints.yaml 与 Makefile：Verification Matrix 明列 `make smoke`、`make ui-walk`、作为二进制供给前置的 `make omp-fetch` 与手动真实上游 `make smoke-live` 及各自 evidence；Enforcement Index 保持 smoke/ui-walk 为 `block`，omp-fetch 为 prerequisite，smoke-live 为 `review-only`，并含「办公文档转换隔离」一行（`.github/workflows/ci.yml` job `office-sidecar`，`block`）与「浏览器参考镜像」一行（`.github/workflows/ci.yml` job `browser-image`，`block`），由源码派生 oracle 钉住。Directory Map 的 server/ 与 smoke/ SHALL 包含对话职责。constraints.yaml verification.surfaces SHALL 恰有十个 surface，各含 command/evidence/required_at，omp-fetch 与 smoke-live 的 required_at 分别为 prerequisite/manual。Makefile 页头 SHALL 描述这些职责且不再延后 #107；四个同名 targets（smoke/ui-walk/omp-fetch/smoke-live）与 .PHONY 保持一致；`ui-shots` 目标、其 `UI_SHOTS_*` 变量与 `web` 的 `ui-shots` 脚本 SHALL 不存在，source-derived oracle SHALL 拒绝每个 target 的 GNU Make 等价 spaced duplicate/redefinition。第三方 action 四项白名单不变；ui-walk job 的 `timeout-minutes: 15` 覆盖两个 Playwright project。S0b 同 uid 的 /proc 与配置文件凭证风险登记 SHALL 在 ADR0010 要求的 merged-master uid-isolation job 与 aggregate 全绿证据成立后关闭；strictness_profile.downgrades SHALL 不含 s0b_same_uid_credential_exposure，其余三条降级保持不变。AGENTS.md Enforcement Index SHALL 含 uid 隔离、CI uid-isolation/all-checks-passed 与 block 的精确四列行；不得以设置 OMP_USER、普通CI跳过或容器结果代替正式master证据，也不得声称用户生产部署已验收。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤；`fast-checks` 在其质量步骤的最后另执行一步 `npx openspec validate --all --strict --no-interactive`（#1126）：`openspec` CLI 由根 `package.json` 的 `devDependencies` 以精确版本 `@fission-ai/openspec` `1.13.2`（不带 `^` / `~`）固定并进入 lockfile，这一步校验 `openspec/specs/` 下的全部规格与 `openspec/changes/` 下全部未归档的 change，任一 ERROR 即失败；AGENTS.md SHALL 写明 openspec 一律经 `npx openspec` 调用、不用全局安装的版本；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换（含 `openspec validate` 一步被删除、去掉 `--strict`、或换成不经 `npx` 的全局命令）、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。secret-scan、sast 的 timeout 与步骤、smoke/ui-walk 的 timeout，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

单元测试 SHALL 拆成两个并行的独立 Ubuntu job：`unit-tests` 使用 exact `timeout-minutes: 10`，`unit-tests-web` 使用 exact `timeout-minutes: 20`（#1554：拆分后 web 套件单独在慢 runner 上已达 517–572 秒，快 runner 303–430 秒，同一套件 vitest 累计 tests 时间 660 秒与 1199 秒之比约 1.8 倍，差异来自 runner 而非个别用例；owner 2026-10-19 裁决只放宽这一个 job，仍不分片）：`unit-tests` 依次执行 checkout、setup-node、setup-uv、`npm ci`、`cd kbservice && uv sync`、`npm test --workspace server` 与 `cd kbservice && uv run pytest`；`unit-tests-web` 依次执行 checkout、setup-node、`npm ci` 与 `npm test --workspace web`，不安装 uv。根 `package.json` 的 workspaces 恰为 server 与 web，两 job 合起来 SHALL 覆盖拆分前 `npm test --workspaces` 的全部套件，不得遗漏其一；测试内容、覆盖率阈值与本地 `make test` SHALL 不变，不引入测试分片，也不新增 `constraints.yaml` 镜像。`all-checks-passed.needs` SHALL 同时包含两者。source-derived oracle SHALL 以完整 metadata 与步骤序列钉住这两个 job，拒绝 `unit-tests-web` 缺失或不在聚合依赖中、`unit-tests` 的 timeout 偏离 10、`unit-tests-web` 的 timeout 偏离 20、action major 漂移、setup 步骤缺失/重复/搬移、`npm ci` 或任一测试步骤删除/替换（含两个 workspace 互换）、`unit-tests-web` 多出 setup-uv，以及 job/step `if`/`continue-on-error` 绕过。

#### Scenario: 两个真实 harness job 独立全绿并进入聚合
- **GIVEN** fresh Ubuntu runners、受 lockfile 约束的 Node dependencies、固定 Hurl archive digest 与 Playwright Chromium revision
- **WHEN** CI 分别运行 `smoke` 与 `ui-walk`
- **THEN** 两者都先 build Web/server，分别用 isolated DB/process/static root 启动 production server；`make smoke` 的 public/auth/chat/files/session-meta 五个独立文件与 `make ui-walk` 的完整 Chromium journey 全绿，cleanup 后 job 退出 0
- **AND** `all-checks-passed.needs` 同时包含两个 job；任一 job failure/cancelled/skipped 时 aggregate 非零

#### Scenario: 工具、服务或测试失败不得假绿或污染 sibling job
- **WHEN** Hurl archive digest/解压/执行失败、omp digest 不符、假上游启动/readiness/提前退出失败、Chromium 安装/启动失败、server 未 ready/提前退出、任一 harness assertion 失败或 cleanup 失败
- **THEN** 所属 job 非零并输出不含凭证/session 的必要诊断；另一 job 的 DB、port、static root、browser/cookie state 与结果不被读取、停止或删除

#### Scenario: 控制面一致
- **WHEN** 比对 AGENTS.md matrix/enforcement/directory、constraints.yaml 十个 verification.surfaces 与 Makefile 页头/target/PHONY，并分别注入四个 target 的 spaced duplicate
- **THEN** 四条命令与 evidence/required_at/执行级别一致；AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot，也无 `make ui-shots` 行；四种 duplicate 均被拒绝；重新加入 `ui-shots` surface、target 或 AGENTS 行的候选被拒绝，原 smoke/ui-walk block、五文件 smoke、CI jobs 与聚合不变
- **AND** 删除或篡改任一新增镜像、职责或有效 downgrade 会使 oracle 非零；comment、fence 或其他 YAML owner 中的同名文本不能代替 active 条目

#### Scenario: 安装高尾不再抢占全部质量检查预算
- **GIVEN** 历史 `npm ci` 高尾为 300–302 秒，fast-checks 后续步骤约 4–6 秒、anti-drift 后续步骤约 2–3 秒，且 10 分钟 unit-tests 在相同高尾后完成
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置运行 fast-checks 与 anti-drift
- **THEN** 两 job 各有 10 分钟总预算，`npm ci` 之后的 Biome/Ruff/typecheck 或 knip/jscpd/naming/size 步骤实际执行且成功，不以 cancelled/skipped 结束，`all-checks-passed` 成功

#### Scenario: 单元测试拆分后两套件各有独立预算
- **GIVEN** 拆分前 `unit-tests` 在一个 runner 上串行执行 server vitest、web vitest 与 kbservice pytest，对 10 分钟时限的实测耗时为 6:20、9:41、9:48、超时、9:09、9:57、超时（测试本身全部通过，两次靠重跑）；其中一次超时运行里 `npm ci` 约 8 秒（缓存命中）、server 套件约 3.5 分钟、web 套件约 6 分钟
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置并行运行 `unit-tests` 与 `unit-tests-web`
- **THEN** 工作流共十二个 job：十一个 direct job（fast-checks、unit-tests、unit-tests-web、anti-drift、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image）加 `all-checks-passed`；两个测试 job 各有自己的预算（`unit-tests` 10 分钟、`unit-tests-web` 20 分钟），server 套件与 kbservice pytest 在 `unit-tests`、web 套件在 `unit-tests-web` 实际执行且成功，没有套件被遗漏
- **AND** 两者中任一 failure/cancelled/skipped 时 `all-checks-passed` 非零

#### Scenario: 测试 job 的拆分不可漂移
- **WHEN** source-derived fixture 分别删除 `unit-tests-web`、把它移出 `all-checks-passed.needs`、把任一测试 job 的 timeout 改成 15、把 `unit-tests-web` 的 timeout 改回 10 或把 `unit-tests` 的改成 20、删除或替换任一测试步骤、互换两个 workspace、在 `unit-tests-web` 回退/删除/重复/搬移 checkout 或 setup-node、为它加入 setup-uv，或加入 job/step skip/continue 绕过
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 仍通过

#### Scenario: timeout 与质量步骤不可漂移或旁路
- **WHEN** source-derived fixture 分别把任一目标 timeout 改回 5、删除或错配任一 constraints mirror、删除/替换 `npm ci` 或任一下游质量步骤、加入 job/step skip/continue/custom-shell 绕过，或使 aggregate 不再拒绝 failure/cancelled/skipped
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 与无关 legacy job 演进控制组仍通过

#### Scenario: Owned runtime shutdown and cancellation
- **WHEN** either harness succeeds, fails, is cancelled, loses the upstream or fails startup
- **THEN** the wrapper preserves failure/cancellation status, boundedly reaps its upstream/server/omp/harness children and does not touch unrelated processes; escalation or residue is a cleanup failure

#### Scenario: Exact integration oracle
- **WHEN** a candidate omits/reorders omp fetch or upstream readiness, mutates job-local env, changes the five-file Make argv, drops cleanup or injects a secret/real model upstream into either harness job
- **THEN** the source-derived or runtime oracle rejects it; baseline and restored implementation pass with unchanged action identities/counts and legacy guardrails

#### Scenario: 夹具预置不可旁路
- WHEN either smoke or ui-walk starts through the shared compiled-server helper, or a mutation deletes/reorders fixture copy or removes files.hurl from Make smoke
- THEN both valid modes SHALL provision the tracked three files before startup and mutated wiring SHALL fail the precise source/runtime oracle; existing lifecycle and sibling-job isolation guarantees remain unchanged

第三个 harness job uid-isolation SHALL 遵循 omp-uid-isolation 的正式CI要求，timeout15，隔离job-owned端口/DB/状态并复用既有工具安装及compiled-server smoke。all-checks-passed SHALL 额外依赖uid-isolation，direct job（含 unit-tests-web、office-sidecar 与 browser-image）精确十一个；checkout/setup-node出现次数 SHALL 分别11/9，uv及其它action数量不变。源码派生oracle SHALL 同步新job步骤/env/aggregate与helper可选OMP_USER保留；任何去掉opt-in、换uid传递、HOME门禁、共享组执行或必需依赖的候选 SHALL 被拒绝。既有两个harness jobs及全部更早场景保持不变。第四个 harness job office-sidecar（office-preview「真实转换的人工验证」场景「CI 端到端」；change `office-convert-sandbox` D10）SHALL 在 `ubuntu-24.04` 上以 job 内现场构建的 converter 镜像、`--network none` 跑一次真实转换并与 `--network host` 对照；uid-isolation 同样固定 `runs-on: ubuntu-24.04`（#1502）；第五个 harness job browser-image（browser-runtime「CI browser-image job」；change `omp-browser-integration` D8）SHALL 在 `ubuntu-24.04` 上以 job 内现场构建的参考 app 镜像跑一次真实浏览器端到端。源码派生 oracle SHALL 把三者的 `runs-on` 钉在 `ubuntu-24.04`，变异到 `ubuntu-latest` 即拒绝。

#### Scenario: uid job 与精确 oracle 原子接线
- WHEN the workflow and source/runtime guardrails run on the same revision
- THEN eleven direct jobs include uid-isolation, unit-tests-web, office-sidecar and browser-image, checkout/setup-node counts are 11/9, the selected Linux test is executed not skipped, real-omp five-file smoke passes under OMP_USER=omp, and failure/cancelled/skipped in that job fails the aggregate

#### Scenario: 换 uid 透传保持可选
- WHEN the existing compiled-server helper receives OMP_USER absent or present
- THEN absent retains existing direct smoke/UI behavior without inventing an empty user, while present is preserved into the server; no fallback silently drops the user

#### Scenario: 已关闭 UID 降级与执行门禁一致
- **WHEN** source-derived controls inspect the active downgrade owner and Enforcement Index after the official merged-master UID job succeeds
- **THEN** only the three unrelated downgrades remain, the exact UID block row is active, and reintroduced risk registration or missing/weakened/decoy row is rejected without altering the runtime job

AGENTS.md 的 files-harness 文档镜像 SHALL 保持 server/ 的沙箱/审计/工作空间/对话职责，在 smoke/ 中列出沙箱夹具，并在现有 HTTP smoke evidence 单元中列出 public.hurl、auth.hurl、chat.hurl、files.hurl、session-meta.hurl 五文件。现有 command/调用方 ownership、UI 行与errororacle、十surface、UIDblock/三条剩余downgrades与所有既有场景 SHALL 不变；此文案与精确sourceoracle/mutation anchors同PR更新。

#### Scenario: 文件控制面反映已执行四文件
- **WHEN** AGENTS.md and its existing source-derived oracle are compared at the same revision
- **THEN** sandbox fixture and all five Hurl files are named in their proper documentation owners; stale wording is rejected without changing runtime, workflow, parser behavior or thresholds

#### Scenario: 规格校验进入 fast-checks
- **WHEN** 干净检出后执行 `npm ci`，再执行 `npx openspec --version` 与 `npx openspec validate --all --strict --no-interactive`
- **THEN** 版本输出为 `1.13.2`；校验以 0 退出；CI 的 `fast-checks` 在 `npm run typecheck --workspaces` 之后实际执行这一步并成功
- **WHEN** 在一份临时副本里把一个未归档 change 的某个 MODIFIED 块删掉一个既有的 scenario 标题，执行同一条校验命令
- **THEN** 命令以非零退出
- **WHEN** source-derived fixture 分别删除这一步、去掉 `--strict`、把 `npx openspec` 换成 `openspec`、或给这一步加 `continue-on-error`
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 仍通过

### Requirement: 共享 Vitest 配置的 native ESM 边界
server 与 web SHALL 通过逐字相同的完整相对 specifier `../vitest.shared.mjs` 消费唯一 tracked 根共享配置；该文件 SHALL 以 `.mjs` 自描述为 ESM，不依赖根 `package.json` 的 module type，不得保留 `.ts`/`.js` sibling、无扩展名 import、wrapper、fallback 或 warning suppression。共享配置 SHALL 继续使用 V8 coverage provider、include `src/**/*.{ts,tsx}`，且 lines/functions/branches/statements thresholds 各为 80；web SHALL 只在共享配置之上继续叠加 `environment: jsdom` 与 `e2e/**` exclusion。Makefile lint/fmt source list 与 `biome.json` 根级 include SHALL 指向同一 exact `.mjs` 文件并实际让 Biome 处理它；CI 的既有 Biome 命令、workspace test scripts、产品代码、依赖/lockfile及 Vite/Vitest versions SHALL 保持不变。

#### Scenario: 默认 loader 保持完整验证命令面
- **WHEN** 在 clean checkout 执行 `make check`
- **THEN** server 与 web 均实际执行全部 Vitest tests 和 V8 coverage，四项全局阈值均保持 80%，web tests 在 jsdom 中运行且不发现 `e2e/**`
- **AND** 输出不含 native config loader incompatibility warning、CommonJS shared-config warning 或 module-resolution error

#### Scenario: native loader 对两个 workspace 均真实执行
- **WHEN** 分别执行 `npm exec --workspace @workbuddy/server -- vitest run --coverage --configLoader native` 与 `npm exec --workspace @workbuddy/web -- vitest run --coverage --configLoader native`
- **THEN** 两条命令均解析 tracked `vitest.shared.mjs`、实际运行各自 tests 并生成 V8 coverage summary，退出码为 0
- **AND** 不得以只加载 config、无测试、跳过 coverage 或隐藏 loader warning 充当成功证据

#### Scenario: 文件身份与 consumer 不得漂移
- **WHEN** 共享文件缺失/重命名、旧 `.ts` 或生成 `.js` sibling 被恢复、任一 workspace import 改为无扩展名或不同路径、Makefile source list / `biome.json` root include 不再指向唯一 `.mjs`，或根 package-wide ESM / warning-ignore 配置被加入
- **THEN** fixture inspection、Biome 或默认/native loader 验证非零，不能由 bundle loader 转译、stale artifact、fallback、lint exclusion 或输出过滤假绿

### Requirement: 第三方 CI action 使用 Node 24 runtime
CI SHALL 只以 `actions/checkout@v5`、`actions/setup-node@v5`、`astral-sh/setup-uv@v7` 与 `gitleaks/gitleaks-action@v3` 使用这四种第三方 action；其对应 major tag 的 `action.yml` SHALL 声明 `runs.using: node24`，且 GitHub-hosted runner SHALL 满足 Node 24 action 所需的 runner v2.327.1+。十一个 direct jobs 的使用矩阵 SHALL 完整且唯一：checkout 分别出现在 fast-checks、unit-tests、unit-tests-web、anti-drift、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image；setup-node 分别出现在 fast-checks、unit-tests、unit-tests-web、anti-drift、smoke、ui-walk、uid-isolation、office-sidecar、browser-image；setup-uv 只出现在 fast-checks 与 unit-tests；gitleaks-action 只出现在 secret-scan。不得保留旧/混合 major、Node 20 fallback environment、重复/替换/旁路 action 或未受约束的同类使用点。

关键输入与顺序 SHALL 保持：每个 checkout 在所属 job 的仓库消费者前执行；九个 setup-node 均保留 exact `{ node-version-file: .tool-versions, cache: npm }` 并在 `npm ci` 前完成，只缓存 npm package-manager data 而非 `node_modules`；两个 setup-uv 在 `uv sync` / `uv run` 前安装 uv并保持 GitHub-hosted cache lookup/restore 与成功 post lifecycle，按 cache hit/miss 允许 no-save/save 分支；secret-scan 的 checkout 保留 exact `fetch-depth: 0`，随后 gitleaks-action 只以 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 环境运行。除 unit-tests 按「CI 接线与控制面同步」拆出 unit-tests-web 外，所有原有 run steps、job timeout、constraints mirror、质量阈值、service harness，以及十一项 aggregate dependencies及 failure/cancelled/skipped 拒绝语义 SHALL 保持不变——例外两处（change `office-convert-sandbox` S2a）：`fast-checks` 的 `biome check` 步骤加入 `converter` 目录；`constraints.yaml` `ci.matrix` 加入 `ubuntu-24.04`。

source-derived CI oracle SHALL 从实际传入 workflow 解析全部十一个 direct jobs，校验上述 action major/矩阵/输入/顺序和无 fallback/bypass 条件；任一旧 major、遗漏、混合、重复、替换、relocation、关键 input 漂移或 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 注入均 SHALL 使 `make test-guardrails` 非零。`scripts/inspect-ci-workflow.js` 对 checkout / setup-node 的期望计数 SHALL 随之为 11 / 9（它由 oracle 末尾与 baseline 用例调用）。Mutation generator SHALL 绑定 scratch source，生成失败不得充当成功 rejection；不使用目标 action 的新增 unrelated job SHALL 继续可演进。

#### Scenario: 所有 direct jobs 在 Node 24 action 上完成
- **WHEN** 新 PR CI 在 GitHub-hosted runner 执行该 workflow（uid-isolation、office-sidecar 与 browser-image 在 `ubuntu-24.04`，其余在 `ubuntu-latest`）
- **THEN** fast-checks、unit-tests、unit-tests-web、anti-drift、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image 与 `all-checks-passed` 均成功，所有 action post/cache steps 和原有下游 run steps实际执行
- **AND** setup-node 从 `.tool-versions` 使用 Node 24.13.1，main step 完成 npm cache lookup/restore（允许 primary-key hit 或 miss）且 post step 成功；primary-key miss 时 SHALL 保存新 cache，hit 时 SHALL 允许明确的 `not saving cache` 结果；setup-uv 安装可执行 uv并完成其 hosted cache lifecycle，secret-scan 在 full-history checkout 后成功执行 gitleaks

#### Scenario: Node 20 runtime annotation 完全消失
- **WHEN** 查询同一 PR head SHA 上十一个 direct jobs 的全部 check-run annotations 与 action step logs
- **THEN** `Node.js 20 is deprecated` annotation 为零，四种 action均不被列为 Node 20 target，且 workflow/job/step environment 中不存在 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`
- **AND** 项目 `.tool-versions` 的 Node 24 与 action自身的 `runs.using: node24` SHALL 作为两个独立证据记录，不得相互替代

#### Scenario: action major、输入与矩阵漂移 fail closed
- **WHEN** fixture 将任一使用点回退到旧 major、删除/重复/替换/搬移 action、形成新旧 major混合、改变 setup-node version/cache input、secret checkout depth、gitleaks token、setup顺序，或加入 Node 20 fallback/bypass metadata
- **THEN** source-derived oracle 非零，且每个 mutation 确实消费生成的 scratch workflow；baseline 和不使用目标 action 的 unrelated job 控制组仍通过

#### Scenario: 主版本兼容边界保持
- **WHEN** 比对四个候选 major 的 release notes、`action.yml` inputs/runtime 与本仓实际配置
- **THEN** checkout fetch/full-history、setup-node Node/npm cache、setup-uv install/cache 与 gitleaks token/扫描行为均有书面兼容性结论，runner 最低版本由 GitHub-hosted 环境满足
- **AND** 不升级更高 action major，不改变 action pin 策略、workflow permissions、secret 值、应用工具链版本、产品代码、timeout、步骤或门禁阈值；依赖/lockfile 仅允许用户授权的根 YAML 解析开发依赖 `yaml@^2.9.0` 及必要锁定元数据，不升级其他依赖

### Requirement: Locale-independent oversized-file diagnostics
The size guard SHALL retain the 800-line limit and nonzero rejection while reporting one BLOCK line with the actual count and path for every oversized supported file, independent of C or UTF-8 locale. Guard self-verification SHALL reject missing diagnostics even if the command exits nonzero.
#### Scenario: Multiple violations under macOS locales
- **WHEN** Bash 3.2 or 5.x checks two supported files with 801 and 802 lines under C.UTF-8, en_US.UTF-8, zh_CN.UTF-8 or C
- **THEN** each file has its own BLOCK line with its count and path, exit is nonzero and stderr has no unbound variable error
#### Scenario: Valid boundary and diagnostic regression
- **WHEN** the guard checks an 800-line file, or self-verification sees a failing guard with missing count/path diagnostics
- **THEN** the valid file exits zero and the broken diagnostic oracle fails rather than accepting arbitrary nonzero status

### Requirement: System Bash-compatible guards and pre-commit
The first-party naming guard, size guard and pre-commit SHALL work with macOS system Bash 3.2 and Bash 5.x without requiring newer-shell builtins. Empty lists SHALL succeed under nounset. Existing naming, read-only boundary, size and secret-scan policy SHALL remain unchanged.
#### Scenario: Empty and compliant inputs
- **WHEN** system Bash executes guards with empty staging/source lists or a compliant staged file, or a real Git commit invokes pre-commit with system-first PATH
- **THEN** each operation exits zero without interpreter errors and compliant commit is created
#### Scenario: Violations remain rejected
- **WHEN** a real Git commit stages a file with forbidden naming suffix or the size guard sees an oversized supported file
- **THEN** it exits nonzero with the appropriate BLOCK diagnostic, including the offending path, and no violating commit is created
#### Scenario: Self-verification detects unsupported shell use
- **WHEN** the compatibility regression is run against historical guard/hook implementations under macOS system Bash
- **THEN** its acceptance scenarios fail; current implementations pass under both Bash 3.2 and 5.x and documentation states the interpreter/toolchain prerequisites

### Requirement: Pathname-independent ServiceInfo leakage oracle
The ServiceInfo error-leakage test matrix SHALL use the same stable unique secret sentinel in all four invalid-response/transport fixtures and in both message and raw stack exclusion assertions, without depending on ordinary checkout path fragments.
#### Scenario: Checkout path parity and leak discrimination
- **WHEN** the four existing ServiceInfo invalid-response/transport cases run from macOS checkout paths with and without /private
- **THEN** all four pass with unchanged fallback/status assertions, while deliberately leaking the fixture sentinel into message or stack makes the corresponding exclusion assertion fail

### Requirement: Duplicate-code gate exit semantics follow the declared threshold
`npx jscpd --config .jscpd.json` — shared verbatim by `make anti-drift`, the CI `anti-drift` job and `npm run dupes` — SHALL exit non-zero on duplication only when jscpd's threshold reporter finds the duplicated-line percentage strictly greater than the `constraints.yaml` value of 3; the config SHALL NOT set `exitCode`/`exit-code` or any other switch that fails on clone presence alone. Threshold, pattern, ignore and reporters SHALL stay unchanged. `scripts/test-guardrails.sh` SHALL self-prove the gate against the real config on hermetic fixtures.

#### Scenario: Clones below the threshold pass
- **WHEN** the real `.jscpd.json` scans a fixture tree with zero clones, or with clones totalling ≈0.04% or ≈2.8% duplicated lines
- **THEN** jscpd exits 0

#### Scenario: Clones above the threshold block with the threshold diagnostic
- **WHEN** the real `.jscpd.json` scans a fixture tree with ≈3.2% or ≈5% duplicated lines
- **THEN** jscpd exits non-zero and its output contains `too many duplicates` and `over threshold`

#### Scenario: Guardrail self-proof detects a clone-presence gate
- **WHEN** `make test-guardrails` runs its duplicate-gate cases on hermetic tmp fixtures
- **THEN** the real config accepts the below-threshold fixture and rejects the above-threshold one with the threshold diagnostic, while a runtime-derived config equal to the real one plus `"exitCode": 1` rejects the same below-threshold fixture

### Requirement: Real-child output capture waits for stream closure
Test assertions that depend on the complete stdout or stderr of a real child process, or that are made after the child's exit was observed, SHALL treat the output as complete only after the child has emitted close (its stdio streams have closed), never on the exit event or an already-set exit code alone. Such waits SHALL be bounded, and a timeout or an incomplete or unparseable capture SHALL report the exit code, signal, captured byte count and observed event order.

#### Scenario: Exit observed before pipe data
- **WHEN** a child writes its output and exits, and the parent observes the exit before consuming the pipe data
- **THEN** the capture returns the complete output

#### Scenario: Capture diagnostics
- **WHEN** a capture times out, or the child exits with empty or unparseable output
- **THEN** the reported failure includes exit code, signal, byte count and event order

### Requirement: Web assertions await the committed outcome they check
Web unit-test assertions on DOM that changes only after a route transition commits, or on a side effect performed in a React passive effect or its cleanup, SHALL wait for that outcome itself with a bounded retrying wait (`waitFor`/`findBy*`), not assert it synchronously after awaiting an earlier proxy signal such as `window.location` or the appearance of the next tree. Such waits SHALL NOT be implemented by raising timeouts, adding test retries, or deleting assertions, and assertions that depend on the handoff (for example element identity) SHALL run after the wait. The same rule applies to the `make ui-walk` controlled turn: a server snapshot read over REST SHALL be taken only after an observable precondition proves the content it asserts has reached the store. The fake upstream gate reaching `held` is not such a precondition, because it flips before the first chunk has crossed the model proxy, omp and the supervisor. The browser rendering the first reply part is such a precondition, because the supervisor's commit path persists each event (`persistEvent` → `store.appendDelta`) before it publishes that event to the ring and SSE subscribers (`#publish`). The web test harness SHALL additionally make every RTL wait (`findBy*`/`waitFor`) return only after the React Scheduler work queued up to that point, and the work it cascades into (passive effects and their cleanups, transitions, renders caused by setState inside effects), has run: `web/vitest.config.ts` SHALL register a setup file that wraps RTL's existing `asyncWrapper` and, after the wait's callback resolves and before RTL's own trailing drain, awaits IdlePriority callbacks scheduled on the same `scheduler` module instance that react-dom uses, repeating until no Scheduler task other than the barrier's own idle probes was enqueued between two consecutive idle probes (React schedules renders caused by setState inside effects from a microtask, so a single idle callback can run before that render is enqueued). This barrier is defence in depth: it SHALL NOT replace the per-assertion waits above, it SHALL NOT be implemented by raising timeouts or adding retries, and waits that do not go through `asyncWrapper` (`settle()`, `yieldMacrotask()`, `quiesce()`) are outside it. The server's shared Vitest configuration (`vitest.shared.mjs`) SHALL NOT carry this setup file.

#### Scenario: Route commit lags the URL
- **WHEN** a test navigates, the URL already reflects the new location, and React commits the new location in a later transition
- **THEN** the assertion that the previous view's DOM is gone retries until the commit and passes, and the dependent identity assertion runs afterwards

#### Scenario: Passive cleanup lags the committed tree
- **WHEN** a successful login replaces the login form with protected content and the form's in-flight request is aborted in a passive-effect cleanup scheduled after the commit
- **THEN** the abort assertion retries until the cleanup runs and passes, without a timeout or retry change

#### Scenario: Pre-reload snapshot follows the rendered first part
- **WHEN** `walkHeldDialogue` has the prompt accepted (202) and the fake upstream gate reports `held`
- **THEN** the walk first waits for the running UI prefix (`expectRunningPrefix`: status `运行中`, the assistant body starting with the first reply part, and the `bash` step), and only then fetches the pre-reload REST snapshot and runs `expectRunningSnapshot` with unchanged strength (`running`, user/assistant ids, `content` starting with the first reply part)

#### Scenario: Scheduler work cascaded from the awaited commit has run when the wait returns
- **WHEN** a commit made outside `act` shows the awaited element, its passive effect sets state, both renders contain a child that busy-waits longer than the Scheduler's 5 ms frame so the Scheduler yields before each commit's passive effects, and the second commit's passive effect records a call
- **THEN** after `await findBy*` for that element the call is already recorded when asserted synchronously; in the ordinary configuration with the setup file removed, the same test fails on every run, because the second render's busy-wait starts after RTL's trailing `setTimeout(0)` is registered and so that timer has expired before the yielded passive effect runs; and a barrier that waits for a single idle callback instead of repeating until drained fails the same test whenever the slice running the first commit's passive effect stays within the 5 ms frame, because the first commit's passive effect enqueues the second render from a microtask after that idle callback has already run

#### Scenario: Concurrent waits each drain without blocking one another
- **WHEN** one commit shows two elements and a test awaits `Promise.all` of a `findBy*` for each
- **THEN** both waits resolve within a short timeout; a barrier never treats another barrier's idle probes as pending React work

#### Scenario: Delayed Scheduler ticks no longer reorder web assertions
- **WHEN** the web suite runs with the React Scheduler's `setImmediate` delayed by 3 ms (a scratch `setupFiles` entry that wraps it in `setTimeout` before react-dom loads; the reproduction for #1541)
- **THEN** every test passes, including `previewers-loading`「第一次才加载…」, `chat-permission-tier`「缺省档位是 全部自动…」, `workspace-browser-only-paths`「选中后 file 答 404…」, `chat-message-waiting`「尚无可见块时回合结束…」 and `previewers-archive`「换一个 load…」, which fail under that perturbation without the change

### Requirement: 控制面 oracle 校验 base URL 冻结块的存在与顺序
`make test-guardrails` 的 Makefile 契约 oracle SHALL 对 `SMOKE_BASE_URL`、`UI_WALK_BASE_URL` 两组采用同一种检查：该组的 `?=` 默认值、`override … := $(value …)` 冻结与 `export` 行 SHALL 在生效行中各恰出现一次、连续、按此顺序，并紧接对应目标头；块外 SHALL NOT 存在引用该组变量的其它 `export`/`unexport`/`override`/`undefine`/`define`（含不带运算符的多行 `define NAME … endef`）或赋值行。缺失、重排、重复或块外散落任一行时 oracle SHALL 失败；当前 Makefile SHALL 通过。

#### Scenario: 删除冻结或导出行被拒
- **WHEN** 从 Makefile 删除 `override SMOKE_BASE_URL := $(value SMOKE_BASE_URL)`、`export SMOKE_BASE_URL`、`override UI_WALK_BASE_URL := $(value UI_WALK_BASE_URL)`、`export UI_WALK_BASE_URL` 或两组 `?=` 默认值行中的任一行后运行契约检查
- **THEN** 检查以非零退出

#### Scenario: 重排、重复与散落被拒
- **WHEN** 把某组的 `export` 移到 `override` 之前、把整块复制一份、或在目标之后追加一行 `export SMOKE_BASE_URL`、在 Makefile 末尾追加 `unexport SMOKE_BASE_URL`
- **THEN** 检查以非零退出，而未改动的 Makefile 检查退出 0

#### Scenario: 块外裸 define 被拒
- **WHEN** 在各组 `?=` 默认值行之前（如 `SHELL := /bin/bash` 之后）插入 `define SMOKE_BASE_URL` 或 `define UI_WALK_BASE_URL`，body 为 `http://evil`、以 `endef` 结束，然后运行契约检查
- **THEN** 两种变异各自以非零退出，而未改动的 Makefile 检查退出 0

### Requirement: 假 sidecar 的 cancel 观察不依赖文件事件送达
断言进程内假 sidecar（`server/test/support/fake-sidecar.ts`）「看到了某个作业的 `cancel`」的测试 SHALL 以确定的同步观察取得这一结论——测试进程内的同步扫描，或 app 子进程内删除时刻的同步留痕——SHALL NOT 以等待 `fs.watch` 事件的方式取得——app 写完 `cancel` 随即删除作业目录，短命文件的事件可能被合并或丢弃；也 SHALL NOT 以加大等待时限、给测试加重试或删除断言来消除偶发失败。按触发方式分三种（#1574）：
- 测试在本进程内同步触发 cancel（`abort()`、`close()`）：在触发之后、第一次让出之前（`cancel` 已写、作业目录仍在）同步扫描一次，然后同步断言；
- cancel 由本进程内的计时器或其它异步路径写下、测试拿不到同步执行的机会：在 app 删除该作业目录的那一刻同步扫描（如对 `fs.rmSync` 的 spy，先扫描再执行真实删除）；
- app 在另一个进程里（编译入口的启动测试）：测试进程的扫描无法与它同拍，这一类不经假 sidecar「看到」cancel，观察对象是 app 删除作业目录时其下 `cancel` 已经存在：这一观察 SHALL 由子进程内的预加载钩子在 app 删除该作业目录的那一刻同步留痕（第二类的跨进程版本：包住 `fs.rmSync`，目标是作业目录且其下有 `cancel` 时先追加一行 `cancel:<作业 id>` 到一个专用 trace 文件，再执行真实删除；该 trace 与入口的次序 trace 分开），测试轮询这个 trace 文件取得观察（#1751）；它承载的计时结论 SHALL 保留。

#### Scenario: 关停时在途作业的 cancel 被确定地观察到
- **WHEN** 并发上限为 1 的转换缓存有一个在途作业与若干排队调用，测试调用 `close()`，并在同一拍里（`cancel` 已写、作业目录仍在）同步扫描一次假 sidecar
- **THEN** 该作业的 `cancelAt` 立即已定义，无需等待；`close()` 返回后作业目录已删、排队调用全部 `aborted`、启动次数仍为 1
- **AND** 假 sidecar 的文件事件回调不记 `cancel` 时（变异），结论相同

#### Scenario: 编译入口的 cancel 不靠文件事件
- **WHEN** 编译入口的启动测试中，配置的转换超时结束一次 `hang` 作业，随后关停时有一个在途作业；测试以子进程预加载钩子写下的 cancel trace 判定这两次 cancel
- **THEN** 超时那次的 `cancel:<id>` 已在 trace 中、作业目录已删；`server.stop()` 后 1.5 s 内在途作业的 `cancel:<id>` 出现在 trace 中；入口的次序 trace 逐字不变
- **AND** 假 sidecar 的文件事件回调不记 `cancel` 时（变异），结论相同

### Requirement: 进程上限断言在准入时刻采样
断言「并发 omp 进程数不超过上限」的测试 SHALL 以准入或 spawn 那一刻同步取得的样本作为证据（如 `session-supervisor-pool-helpers.ts` 的 `sampleSpawns` / `expectWithinCap`）；当被测场景里的名额在拒绝之后、采样之前可能变化时（fork 临时进程做完即退出并释放名额，`branch-temp.ts:114-118`；regenerate 进程回合结束后仍存活但变为可驱逐，会在下一次准入时被 `retire()` 驱逐），测试 SHALL NOT 在拒绝传回测试之后的回调里读取当前进程数并要求它等于上限——拒绝与采样之间名额可能已被释放。只含准入后既不退出也不可驱逐的进程（如全部 `hang-prompt`）的用例可以事后采样（#1580）。

#### Scenario: 混有短命进程的上限用例只靠 spawn 时样本判定
- **WHEN** 上限为 2，两路 prompt（`hang-prompt`）、一个 regenerate 与一个 fork 并发，其中 fork 临时进程做完即退出、regenerate 进程回合结束后可被驱逐
- **THEN** 用例断言每个结果只是成功或 `agent_capacity` 拒绝、每次 spawn 时的存活进程数都不超过 2，不读取拒绝送达后的进程数
- **AND** 把运行时上限临时改为 3 时（变异），某次 spawn 时已有 2 个存活子进程（样本只计新 spawn 之前已存活的），`expectWithinCap(…, 2)` 失败，而在它之前的被拒原因断言仍通过

### Requirement: 过滤测试运行命令

server 与 web 两个 workspace SHALL 各提供 `test:focus` 脚本，内容为 `vitest run`（不带 `--coverage`），过滤运行的文档化形式为 `npm run test:focus --workspace <ws> -- <pattern>`：所选测试全部通过即退出码 0，任一失败即非 0。`test` 脚本 SHALL 保持 `vitest run --coverage`，全量 `npm test --workspace <ws>` 与 `make test` 的四项 80% 全局覆盖率阈值不变。`AGENTS.md`「范围化验证」规则与 `openspec/project-profile.md` 命令面 SHALL 记录这一过滤形式（AGENTS.md 的 Verification Matrix 表只列 Makefile 目标，不收这一行），并写明覆盖率门禁只由全量运行承担。

#### Scenario: 过滤运行只看所选测试的结果

- **WHEN** 执行 `npm run test:focus --workspace server -- mounts-validate`，所选测试全部通过
- **THEN** 退出码为 0，不报覆盖率阈值
- **AND** 所选测试中有一条失败时退出码非 0
- **AND** 执行 `npm test --workspace server -- mounts-validate` 仍因全局覆盖率阈值退出非 0

### Requirement: 部分删除残留断言不依赖并行删除的完成顺序

递归删除失败后，如果用例断言残留的**完整精确树**（对整棵残留树 `toEqual`），其夹具 SHALL 在被删除的目录下只留那一个注定删不掉的顶层子树，不得同时放其它兄弟项。原因是 Node 的 `fs.promises.rm` 并行删除各子项，遇到第一个错误就 reject，兄弟项是否已经删掉不确定。只断言被锁子树仍在、不涉及兄弟项是否存在的用例，不受这条约束。实例：#1490 的「删除失败不影响响应」与 #1746 的 `session-delete-sibling.test.ts` 用例 (e)。

#### Scenario: 精确树断言与删除完成顺序无关
- **WHEN** 连续多次运行 `session-delete-sibling.test.ts` 用例 (e)，夹具的产物目录只有设为 `0500` 的 `local/note.txt` 这一个顶层子树
- **THEN** 每次都通过，残留树恰为 `local` 与 `local/note.txt`，不依赖兄弟项 unlink 的完成顺序
