# verification-harness Specification

## Purpose
TBD - created by archiving change s0a-service-skeleton. Update Purpose after archive.
## Requirements
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
`make ui-walk` SHALL 只消费由 caller 启动、可从 `UI_WALK_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务；目标不得 build、start、stop、安装浏览器或拥有 DB/temp cleanup。目标 SHALL 以 Playwright 管理的全新 Chromium context 串行执行一条生产路径：从 `/files` 登录 dev-stub 账号 → 经真实侧栏逐项访问四个受支持路由 → 在 `/settings` 切换深色主题并 reload 验证持久化 → 从侧栏页脚确认退出并 reload 验证会话仍为未登录。走查 SHALL 从首个 navigation 前开始收集并最终断言零非预期浏览器 `console.error` 和零 uncaught page error；本 journey 必须同时观测恰两次 `GET /api/auth/me` → 401（初始未登录、退出后 reload），仅与这两次响应同源、location pathname 恰为 `/api/auth/me` 且文本恰为 Chromium 固定 401 transport diagnostic 的 console 事件不计入错误预算，任何额外/不匹配 401 或其他 console error 仍失败。服务端 stderr（包括 `node:sqlite` ExperimentalWarning）不属于该浏览器 oracle。

#### Scenario: 登录、四路由、主题持久与退出全绿
- **GIVEN** caller 以 fresh 临时 DB 和真实 `web/dist` 启动 production server，且 Playwright context 初始无 cookie/localStorage
- **WHEN** 对 `/files` 执行 `make ui-walk`，以 `zhangsan`/`demo` 登录，再依次访问 `/`、`/files`、`/center`、`/settings`
- **THEN** 登录后仍在 `/files`，每一路由显示对应页面标题且恰有一个当前导航项；页脚显示 exact `zhangsan`/`成员`
- **AND** 选择 `深色` 后根元素 `data-theme=dark`、`workbuddy-theme=dark`，reload 后仍选中深色且显示 `当前生效：深色`
- **AND** 点击 `退出登录`、在 `alertdialog` 中点击 `退出` 后原 `/settings` 显示 `登录 WorkBuddy`，session cookie 被清除，reload 后仍未登录
- **AND** 恰有两次 expected `/api/auth/me` 401；除与其 exact path/text 绑定的 Chromium transport diagnostic 外无 browser console error，且无 page error，Playwright 退出码为 0

#### Scenario: 目标边界与失败传播
- **WHEN** Playwright/Chromium 缺失、`UI_WALK_BASE_URL` 不可达、任一 UI/API/持久化/退出断言失败，或页面产生 console/page error
- **THEN** `make ui-walk` 非零且不得 silent skip、下载依赖、启动/停止服务、创建或清理 caller 的 DB/temp/static root
- **AND** `make test` 不发现或执行 `web/e2e/**`；`make typecheck` 仍检查 Playwright 配置与走查源码

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程与临时状态。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 四处同步：AGENTS.md Verification Matrix 两条 READINESS GAP 行替换为 exact `make smoke` / `make ui-walk` + evidence；Enforcement Index 两行升 `block`；Known blind spots 删除过期 gap 条目；Directory Map 增 `smoke/`。`constraints.yaml` `verification.surfaces` 增 `smoke` 与 `ui-walk` 两条，command 分别逐字为 `make smoke` / `make ui-walk` 且 evidence 齐全。Makefile 的同名 targets 与 `.PHONY` SHALL 保持一致；source-derived oracle SHALL 拒绝 `smoke :` / `ui-walk :` 等 GNU Make 等价 duplicate/redefinition，使 canonical recipe 不得被保留文本旁路。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。unit-tests、secret-scan、sast、smoke、ui-walk 的 timeout 与步骤，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

#### Scenario: 两个真实 harness job 独立全绿并进入聚合
- **GIVEN** fresh Ubuntu runners、受 lockfile 约束的 Node dependencies、固定 Hurl archive digest 与 Playwright Chromium revision
- **WHEN** CI 分别运行 `smoke` 与 `ui-walk`
- **THEN** 两者都先 build Web/server，分别用 isolated DB/process/static root 启动 production server；`make smoke` 的 12 个真实请求与 `make ui-walk` 的完整 Chromium journey 全绿，cleanup 后 job 退出 0
- **AND** `all-checks-passed.needs` 同时包含两个 job；任一 job failure/cancelled/skipped 时 aggregate 非零

#### Scenario: 工具、服务或测试失败不得假绿或污染 sibling job
- **WHEN** Hurl archive digest/解压/执行失败、Chromium 安装/启动失败、server 未 ready/提前退出、任一 harness assertion 失败或 cleanup 失败
- **THEN** 所属 job 非零并输出不含凭证/session 的必要诊断；另一 job 的 DB、port、static root、browser/cookie state 与结果不被读取、停止或删除

#### Scenario: 控制面一致
- **WHEN** 比对 AGENTS.md Verification Matrix、constraints.yaml verification.surfaces 与 Makefile target/grammar 集合，注入 `smoke :` / `ui-walk :` duplicate-recipe mutation，并检查 CI jobs/aggregate
- **THEN** `make smoke` 与 `make ui-walk` 的命令逐字一致、command/evidence/`block` 等级齐全，AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot，Directory Map 含 `smoke/`，Makefile `.PHONY` 与 canonical targets 同步，两个等价 duplicate mutation 均使 source-derived oracle 非零，CI 使用且无法旁路原 recipes

#### Scenario: 安装高尾不再抢占全部质量检查预算
- **GIVEN** 历史 `npm ci` 高尾为 300–302 秒，fast-checks 后续步骤约 4–6 秒、anti-drift 后续步骤约 2–3 秒，且 10 分钟 unit-tests 在相同高尾后完成
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置运行 fast-checks 与 anti-drift
- **THEN** 两 job 各有 10 分钟总预算，`npm ci` 之后的 Biome/Ruff/typecheck 或 knip/jscpd/naming/size 步骤实际执行且成功，不以 cancelled/skipped 结束，`all-checks-passed` 成功

#### Scenario: timeout 与质量步骤不可漂移或旁路
- **WHEN** source-derived fixture 分别把任一目标 timeout 改回 5、删除或错配任一 constraints mirror、删除/替换 `npm ci` 或任一下游质量步骤、加入 job/step skip/continue/custom-shell 绕过，或使 aggregate 不再拒绝 failure/cancelled/skipped
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 与无关 legacy job 演进控制组仍通过

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
CI SHALL 只以 `actions/checkout@v5`、`actions/setup-node@v5`、`astral-sh/setup-uv@v7` 与 `gitleaks/gitleaks-action@v3` 使用这四种第三方 action；其对应 major tag 的 `action.yml` SHALL 声明 `runs.using: node24`，且 GitHub-hosted runner SHALL 满足 Node 24 action 所需的 runner v2.327.1+。七个 direct jobs 的使用矩阵 SHALL 完整且唯一：checkout 分别出现在 fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk；setup-node 分别出现在 fast-checks、unit-tests、anti-drift、smoke、ui-walk；setup-uv 只出现在 fast-checks 与 unit-tests；gitleaks-action 只出现在 secret-scan。不得保留旧/混合 major、Node 20 fallback environment、重复/替换/旁路 action 或未受约束的同类使用点。

关键输入与顺序 SHALL 保持：每个 checkout 在所属 job 的仓库消费者前执行；五个 setup-node 均保留 exact `{ node-version-file: .tool-versions, cache: npm }` 并在 `npm ci` 前完成，只缓存 npm package-manager data 而非 `node_modules`；两个 setup-uv 在 `uv sync` / `uv run` 前安装 uv并保持 GitHub-hosted cache lookup/restore 与成功 post lifecycle，按 cache hit/miss 允许 no-save/save 分支；secret-scan 的 checkout 保留 exact `fetch-depth: 0`，随后 gitleaks-action 只以 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 环境运行。所有原有 run steps、job timeout、constraints mirror、质量阈值、service harness、七项 aggregate dependencies及 failure/cancelled/skipped 拒绝语义 SHALL 保持不变。

source-derived CI oracle SHALL 从实际传入 workflow 解析全部七个 direct jobs，校验上述 action major/矩阵/输入/顺序和无 fallback/bypass 条件；任一旧 major、遗漏、混合、重复、替换、relocation、关键 input 漂移或 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 注入均 SHALL 使 `make test-guardrails` 非零。Mutation generator SHALL 绑定 scratch source，生成失败不得充当成功 rejection；不使用目标 action 的新增 unrelated job SHALL 继续可演进。

#### Scenario: 所有 direct jobs 在 Node 24 action 上完成
- **WHEN** 新 PR CI 在 GitHub-hosted `ubuntu-latest` 执行该 workflow
- **THEN** fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk 与 `all-checks-passed` 均成功，所有 action post/cache steps 和原有下游 run steps实际执行
- **AND** setup-node 从 `.tool-versions` 使用 Node 24.13.1，main step 完成 npm cache lookup/restore（允许 primary-key hit 或 miss）且 post step 成功；primary-key miss 时 SHALL 保存新 cache，hit 时 SHALL 允许明确的 `not saving cache` 结果；setup-uv 安装可执行 uv并完成其 hosted cache lifecycle，secret-scan 在 full-history checkout 后成功执行 gitleaks

#### Scenario: Node 20 runtime annotation 完全消失
- **WHEN** 查询同一 PR head SHA 上七个 direct jobs 的全部 check-run annotations 与 action step logs
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

