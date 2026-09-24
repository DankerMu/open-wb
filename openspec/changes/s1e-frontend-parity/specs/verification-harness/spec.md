# Spec delta: verification-harness（S1e 修改）

> 按仓内先例整段重述 `UI 走查（Playwright）` 与 `CI 接线与控制面同步` 两个 Requirement（含全部 Scenario），归档时整段替换；其余 Requirement（HTTP smoke、第三方 CI action 白名单等）不变。改动点：ui-walk 双 project 视口矩阵与窄屏覆盖层导航；控制面 surfaces 十→十一（新增手动 `ui-shots`）、受保护 Make targets 四→五；CI 不新增 job/action。

## MODIFIED Requirements

### Requirement: UI 走查（Playwright）
`make ui-walk` SHALL 只消费由 caller 启动、可从 `UI_WALK_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务；目标不得 build、start、stop、安装浏览器或拥有 DB/temp cleanup。目标 SHALL 以两个 Playwright project（`desktop-light`：viewport 1440×900、`colorScheme: light`；`mobile-dark`：viewport 390×844、`colorScheme: dark`；各自全新 Chromium context，`workers: 1` 串行，共用 caller 的同一服务与沙箱，各自生成独立 gate UUID）执行同一条生产路径；每个 project 在每一路由断言 `document.documentElement.scrollWidth <= window.innerWidth` 且主区可见；布局断言按 project 分支：`desktop-light` 断侧栏宽 ≥160 且主区起点不小于侧栏右缘，在四路由遍历中对每个路由（含 `/center`）临时将 viewport 设为 1024×768 断言无横向溢出后恢复，并在 `/files` 临时将 viewport 设为 880×800 断言树栏 210px 后恢复；`mobile-dark` 断覆盖层默认关闭、`打开导航` 在含 `/` 欢迎态的每个路由可见，并经该按钮打开覆盖层完成每次路由点击。project 私有资源以 project 名区分：创建的目录名为 `walk-out-<project>` 补齐至 ≥48 字符（同时断言该行截断且 `title` 为全名）。主题步骤按 project 分支：`desktop-light` 在 `/settings` 选 `深色` 断 `data-theme=dark`、`workbuddy-theme=dark`；`mobile-dark` 选 `浅色` 断 `data-theme=light`、`workbuddy-theme=light`；二者 reload 后持久。`desktop-light` 另在受控回合运行中对 `.ui-pulse` 断言 reduced-motion 切换（见 ui-primitives），并在 journey 末断言静态资源（resourceType `image|font|stylesheet|script`）零 `requestfailed`（导航/SSE 取消的 `net::ERR_ABORTED` 不计）与零非 `baseURL` 源请求。路径：从 `/files` 登录 dev-stub 账号 → 经真实侧栏逐项访问四个受支持路由 → 在 `/` 完成受控真实回合中的新建/发送/步骤/刷新续流/精确完成/完成后刷新 → 在 `/settings` 切换主题并 reload 验证持久化 → 经侧栏用户区触发按钮 `用户菜单` 打开 `Menu`、选择 `退出登录` 并确认，reload 验证会话仍为未登录。`mobile-dark` 在每次断言用户区文本前先打开覆盖层。走查 SHALL 从首个 navigation 前开始收集并最终断言零非预期浏览器 `console.error` 和零 uncaught page error；本 journey 必须同时观测恰两次 `GET /api/auth/me` → 401（初始未登录、退出后 reload），仅与这两次响应同源、location pathname 恰为 `/api/auth/me` 且文本恰为 Chromium 固定 401 transport diagnostic 的 console 事件不计入错误预算，任何额外/不匹配 401 或其他 console error 仍失败。服务端 stderr（包括 `node:sqlite` ExperimentalWarning）不属于该浏览器 oracle。

#### Scenario: 登录、四路由、主题持久与退出全绿
- **GIVEN** caller 以 fresh 临时 DB 和真实 `web/dist` 启动 production server，且 Playwright context 初始无 cookie/localStorage
- **WHEN** 对 `/files` 执行 `make ui-walk`，以 `zhangsan`/`demo` 登录，再依次访问 `/`、`/files`、`/center`、`/settings`
- **THEN** 登录后仍在 `/files`，每一路由的 level-1 heading 符合 spa-shell 顶栏三态（`/` 欢迎态为 `WorkBuddy，我帮你`，其余为 `工作空间`/`中心`/`设置`）且恰有一个当前导航项；侧栏用户区（`mobile-dark` 在覆盖层打开后）显示 exact `zhangsan`/`成员`
- **AND** `desktop-light` 选择 `深色` 后根元素 `data-theme=dark`、`workbuddy-theme=dark`，reload 后仍选中深色且显示 `当前生效：深色`；`mobile-dark` 选择 `浅色` 后 `data-theme=light`、`workbuddy-theme=light`，reload 后仍选中浅色且显示 `当前生效：浅色`
- **AND** 打开用户菜单、选择 `menuitem` `退出登录`、在 `alertdialog` 中点击 `退出` 后原 `/settings` 显示 `登录 WorkBuddy`，session cookie 被清除，reload 后仍未登录
- **AND** 恰有两次 expected `/api/auth/me` 401；除与其 exact path/text 绑定的 Chromium transport diagnostic 外无 browser console error，且无 page error，Playwright 退出码为 0
- **AND** `desktop-light` 与 `mobile-dark` 两个 project 各自独立完成上述全部步骤；窄屏 project 经汉堡按钮打开覆盖层导航，每一路由无横向溢出；`desktop-light` 的 1024 逐路由无溢出、880 宽树栏为 210px、reduced-motion 切换与静态资源零 `requestfailed`/零跨源请求成立；两 project 的 401 计数与 console/page error 预算各自独立成立

#### Scenario: 目标边界与失败传播
- **WHEN** Playwright/Chromium 缺失、`UI_WALK_BASE_URL` 不可达、任一 UI/API/持久化/退出断言失败，或页面产生 console/page error
- **THEN** `make ui-walk` 非零且不得 silent skip、下载依赖、启动/停止服务、创建或清理 caller 的 DB/temp/static root
- **AND** `make test` 不发现或执行 `web/e2e/**`；`make typecheck` 仍检查 Playwright 配置与走查源码

#### Scenario: 真正回合中刷新并持久完成
- **GIVEN** caller使用真实官方omp18.0.10、compiled app和有界隔离gate的原测试上游，gate已arm且固定提示模板携带独立UUID
- **WHEN** 浏览器创建会话并发送，观察bash步骤与非空prefix，真实REST为running；gate保持held时reload，同session新REST和DOM保留prefix并建立native SSE，随后显式release
- **THEN** 完整正文逐字等于`你好，这是 WorkBuddy 的第一条流式回复。`，bash 步骤徽章（`role=status` 名 `bash 已完成`）与会话列表当前项 status 文本均为 `已完成`，恰一user/assistant pair；完成后reload同样完整且done；exact两次auth401及零新增console/pageerror合同不变，finally清理gate
- **AND** 不以浏览器伪造响应、fake EventSource、已完成回合的延迟展示或任意sleep冒充真正回合中刷新；其他canonical CI/HTTP requirements保持不变

After the four-route traversal and before the existing held dialogue, the journey SHALL perform files-harness「走查 /files 步骤」through the real UI. Its caller-owned sandbox SHALL contain the tracked fixture and no directory named `walk-out-<project>` for the running project (a sibling project's directory may exist). Existing auth/error, dialogue recovery, theme, logout and lifecycle scenarios remain unchanged.

#### Scenario: 文件面预览、创建与同空间恢复
- **WHEN** the authenticated browser selects or creates smoke-fixture, opens the three-file tree, switches Markdown rendered/source views, inspects CSV, opens `logo.png` (asserting `naturalWidth === 256`) and creates the root `walk-out-<project>` directory (≥48 chars)
- **THEN** exact fixture content and the directory are visible, its tree row is truncated with `title` equal to the full name; reload preserves the same nonempty ws ID, selected workspace and restored tree, while the full existing journey and browser-error oracle still pass

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.0.10（不添加 action/cache），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 同步 AGENTS.md、constraints.yaml 与 Makefile：Verification Matrix 明列 `make smoke`、`make ui-walk`、作为二进制供给前置的 `make omp-fetch`、手动真实上游 `make smoke-live` 与手动 demo 一致性截图对 `make ui-shots` 及各自 evidence；Enforcement Index 保持 smoke/ui-walk 为 `block`，omp-fetch 为 prerequisite，smoke-live 与 ui-shots 为 `review-only`。Directory Map 的 server/ 与 smoke/ SHALL 包含对话职责。constraints.yaml verification.surfaces SHALL 恰有十一个 surface，各含 command/evidence/required_at，omp-fetch、smoke-live 与 ui-shots 的 required_at 分别为 prerequisite/manual/manual。Makefile 页头 SHALL 描述这些职责且不再延后 #107；五个同名 targets（smoke/ui-walk/omp-fetch/smoke-live/ui-shots）与 .PHONY 保持一致，source-derived oracle SHALL 拒绝每个 target 的 GNU Make 等价 spaced duplicate/redefinition。CI SHALL 不为 ui-shots 新增 job 或第三方 action（四 action 白名单不变）；ui-walk job 的 `timeout-minutes: 15` 覆盖两个 Playwright project。S0b 同 uid 的 /proc 与配置文件凭证风险登记 SHALL 在 ADR0010 要求的 merged-master uid-isolation job 与 aggregate 全绿证据成立后关闭；strictness_profile.downgrades SHALL 不含 s0b_same_uid_credential_exposure，其余三条降级保持不变。AGENTS.md Enforcement Index SHALL 含 uid 隔离、CI uid-isolation/all-checks-passed 与 block 的精确四列行；不得以设置 OMP_USER、普通CI跳过或容器结果代替正式master证据，也不得声称用户生产部署已验收。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。unit-tests、secret-scan、sast 的 timeout 与步骤、smoke/ui-walk 的 timeout，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

#### Scenario: 两个真实 harness job 独立全绿并进入聚合
- **GIVEN** fresh Ubuntu runners、受 lockfile 约束的 Node dependencies、固定 Hurl archive digest 与 Playwright Chromium revision
- **WHEN** CI 分别运行 `smoke` 与 `ui-walk`
- **THEN** 两者都先 build Web/server，分别用 isolated DB/process/static root 启动 production server；`make smoke` 的 public/auth/chat/files 四个独立文件与 `make ui-walk` 的完整 Chromium journey 全绿，cleanup 后 job 退出 0
- **AND** `all-checks-passed.needs` 同时包含两个 job；任一 job failure/cancelled/skipped 时 aggregate 非零

#### Scenario: 工具、服务或测试失败不得假绿或污染 sibling job
- **WHEN** Hurl archive digest/解压/执行失败、omp digest 不符、假上游启动/readiness/提前退出失败、Chromium 安装/启动失败、server 未 ready/提前退出、任一 harness assertion 失败或 cleanup 失败
- **THEN** 所属 job 非零并输出不含凭证/session 的必要诊断；另一 job 的 DB、port、static root、browser/cookie state 与结果不被读取、停止或删除

#### Scenario: 控制面一致
- **WHEN** 比对 AGENTS.md matrix/enforcement/directory、constraints.yaml 十一个 verification.surfaces 与 Makefile 页头/target/PHONY，并分别注入五个 target 的 spaced duplicate
- **THEN** 五条命令与 evidence/required_at/执行级别一致；AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot；五种 duplicate 均被拒绝，原 smoke/ui-walk block、四文件 smoke、CI jobs 与聚合不变
- **AND** 删除或篡改任一新增镜像、职责或有效 downgrade 会使 oracle 非零；comment、fence 或其他 YAML owner 中的同名文本不能代替 active 条目

#### Scenario: 安装高尾不再抢占全部质量检查预算
- **GIVEN** 历史 `npm ci` 高尾为 300–302 秒，fast-checks 后续步骤约 4–6 秒、anti-drift 后续步骤约 2–3 秒，且 10 分钟 unit-tests 在相同高尾后完成
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置运行 fast-checks 与 anti-drift
- **THEN** 两 job 各有 10 分钟总预算，`npm ci` 之后的 Biome/Ruff/typecheck 或 knip/jscpd/naming/size 步骤实际执行且成功，不以 cancelled/skipped 结束，`all-checks-passed` 成功

#### Scenario: timeout 与质量步骤不可漂移或旁路
- **WHEN** source-derived fixture 分别把任一目标 timeout 改回 5、删除或错配任一 constraints mirror、删除/替换 `npm ci` 或任一下游质量步骤、加入 job/step skip/continue/custom-shell 绕过，或使 aggregate 不再拒绝 failure/cancelled/skipped
- **THEN** `make test-guardrails` 的 CI contract oracle 非零；未变 fixture 与无关 legacy job 演进控制组仍通过

#### Scenario: Owned runtime shutdown and cancellation
- **WHEN** either harness succeeds, fails, is cancelled, loses the upstream or fails startup
- **THEN** the wrapper preserves failure/cancellation status, boundedly reaps its upstream/server/omp/harness children and does not touch unrelated processes; escalation or residue is a cleanup failure

#### Scenario: Exact integration oracle
- **WHEN** a candidate omits/reorders omp fetch or upstream readiness, mutates job-local env, changes the four-file Make argv, drops cleanup or injects a secret/real model upstream into either harness job
- **THEN** the source-derived or runtime oracle rejects it; baseline and restored implementation pass with unchanged action identities/counts and legacy guardrails

#### Scenario: 夹具预置不可旁路
- WHEN either smoke or ui-walk starts through the shared compiled-server helper, or a mutation deletes/reorders fixture copy or removes files.hurl from Make smoke
- THEN both valid modes SHALL provision the tracked three files before startup and mutated wiring SHALL fail the precise source/runtime oracle; existing lifecycle and sibling-job isolation guarantees remain unchanged

第三个 harness job uid-isolation SHALL 遵循 omp-uid-isolation 的正式CI要求，timeout15，隔离job-owned端口/DB/状态并复用既有工具安装及compiled-server smoke。all-checks-passed SHALL 额外依赖uid-isolation，direct job精确八个；checkout/setup-node出现次数 SHALL 分别8/6，uv及其它action数量不变。源码派生oracle SHALL 同步新job步骤/env/aggregate与helper可选OMP_USER保留；任何去掉opt-in、换uid传递、HOME门禁、共享组执行或必需依赖的候选 SHALL 被拒绝。既有两个harness jobs及全部更早场景保持不变。

#### Scenario: uid job 与精确 oracle 原子接线
- WHEN the workflow and source/runtime guardrails run on the same revision
- THEN eight direct jobs include uid-isolation, checkout/setup-node counts are8/6, the selected Linux test is executed not skipped, real-omp four-file smoke passes under OMP_USER=omp, and failure/cancelled/skipped in that job fails the aggregate

#### Scenario: 换 uid 透传保持可选
- WHEN the existing compiled-server helper receives OMP_USER absent or present
- THEN absent retains existing direct smoke/UI behavior without inventing an empty user, while present is preserved into the server; no fallback silently drops the user

#### Scenario: 已关闭 UID 降级与执行门禁一致
- **WHEN** source-derived controls inspect the active downgrade owner and Enforcement Index after the official merged-master UID job succeeds
- **THEN** only the three unrelated downgrades remain, the exact UID block row is active, and reintroduced risk registration or missing/weakened/decoy row is rejected without altering the runtime job

AGENTS.md 的 files-harness 文档镜像 SHALL 保持 server/ 的沙箱/审计/工作空间/对话职责，在 smoke/ 中列出沙箱夹具，并在现有 HTTP smoke evidence 单元中列出 public.hurl、auth.hurl、chat.hurl、files.hurl 四文件。现有 command/调用方 ownership、UI 行与errororacle、十一surface（含 `ui-shots`）、UIDblock/三条剩余downgrades与所有既有场景 SHALL 不变；此文案与精确sourceoracle/mutation anchors同PR更新。

#### Scenario: 文件控制面反映已执行四文件
- **WHEN** AGENTS.md and its existing source-derived oracle are compared at the same revision
- **THEN** sandbox fixture and all four Hurl files are named in their proper documentation owners; stale wording is rejected without changing runtime, workflow, parser behavior or thresholds
