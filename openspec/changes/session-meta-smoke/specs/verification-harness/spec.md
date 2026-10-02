# Spec delta: verification-harness（#539，父 tasks 8.1）

> 两条 Requirement 按主规格现文整段重述，只把 `make smoke` 的文件数与文件清单从四文件改为五文件（追加 `session-meta.hurl`），Scenario「文件控制面反映已执行四文件」随之更名；其余字句逐字不变。父 delta 没有这两条——父 change 归档前 rebase 时须带上。

## MODIFIED Requirements

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
- **WHEN** real pinned omp v18.0.10 and the controlled upstream serve the five-file smoke twice
- **THEN** both runs pass; captured assistant is done with exact configured text, at least one bash step and no non-done step, session is done; another account gets404 for the session and bearer-free model POST gets401; chat.hurl needs no earlier file cookie and leaves no live authentication session

#### Scenario: 文件烟测独立且可重复
- WHEN tracked sandbox fixtures are copied by the caller and the same running service/DB/sandbox receives two complete make smoke runs followed by standalone files.hurl with empty cookie state
- THEN files-harness assertions execute on every run, all five top-level files pass, no service is restarted/reseeded by make, and no live authentication sessions remain

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.0.10（不添加 action/cache），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 同步 AGENTS.md、constraints.yaml 与 Makefile：Verification Matrix 明列 `make smoke`、`make ui-walk`、作为二进制供给前置的 `make omp-fetch`、手动真实上游 `make smoke-live` 与手动 demo 一致性截图对 `make ui-shots` 及各自 evidence；Enforcement Index 保持 smoke/ui-walk 为 `block`，omp-fetch 为 prerequisite，smoke-live 与 ui-shots 为 `review-only`。Directory Map 的 server/ 与 smoke/ SHALL 包含对话职责。constraints.yaml verification.surfaces SHALL 恰有十一个 surface，各含 command/evidence/required_at，omp-fetch、smoke-live 与 ui-shots 的 required_at 分别为 prerequisite/manual/manual。Makefile 页头 SHALL 描述这些职责且不再延后 #107；五个同名 targets（smoke/ui-walk/omp-fetch/smoke-live/ui-shots）与 .PHONY 保持一致，source-derived oracle SHALL 拒绝每个 target 的 GNU Make 等价 spaced duplicate/redefinition。CI SHALL 不为 ui-shots 新增 job 或第三方 action（四 action 白名单不变）；ui-walk job 的 `timeout-minutes: 15` 覆盖两个 Playwright project。S0b 同 uid 的 /proc 与配置文件凭证风险登记 SHALL 在 ADR0010 要求的 merged-master uid-isolation job 与 aggregate 全绿证据成立后关闭；strictness_profile.downgrades SHALL 不含 s0b_same_uid_credential_exposure，其余三条降级保持不变。AGENTS.md Enforcement Index SHALL 含 uid 隔离、CI uid-isolation/all-checks-passed 与 block 的精确四列行；不得以设置 OMP_USER、普通CI跳过或容器结果代替正式master证据，也不得声称用户生产部署已验收。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。unit-tests、secret-scan、sast 的 timeout 与步骤、smoke/ui-walk 的 timeout，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

#### Scenario: 两个真实 harness job 独立全绿并进入聚合
- **GIVEN** fresh Ubuntu runners、受 lockfile 约束的 Node dependencies、固定 Hurl archive digest 与 Playwright Chromium revision
- **WHEN** CI 分别运行 `smoke` 与 `ui-walk`
- **THEN** 两者都先 build Web/server，分别用 isolated DB/process/static root 启动 production server；`make smoke` 的 public/auth/chat/files/session-meta 五个独立文件与 `make ui-walk` 的完整 Chromium journey 全绿，cleanup 后 job 退出 0
- **AND** `all-checks-passed.needs` 同时包含两个 job；任一 job failure/cancelled/skipped 时 aggregate 非零

#### Scenario: 工具、服务或测试失败不得假绿或污染 sibling job
- **WHEN** Hurl archive digest/解压/执行失败、omp digest 不符、假上游启动/readiness/提前退出失败、Chromium 安装/启动失败、server 未 ready/提前退出、任一 harness assertion 失败或 cleanup 失败
- **THEN** 所属 job 非零并输出不含凭证/session 的必要诊断；另一 job 的 DB、port、static root、browser/cookie state 与结果不被读取、停止或删除

#### Scenario: 控制面一致
- **WHEN** 比对 AGENTS.md matrix/enforcement/directory、constraints.yaml 十一个 verification.surfaces 与 Makefile 页头/target/PHONY，并分别注入五个 target 的 spaced duplicate
- **THEN** 五条命令与 evidence/required_at/执行级别一致；AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot；五种 duplicate 均被拒绝，原 smoke/ui-walk block、五文件 smoke、CI jobs 与聚合不变
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
- **WHEN** a candidate omits/reorders omp fetch or upstream readiness, mutates job-local env, changes the five-file Make argv, drops cleanup or injects a secret/real model upstream into either harness job
- **THEN** the source-derived or runtime oracle rejects it; baseline and restored implementation pass with unchanged action identities/counts and legacy guardrails

#### Scenario: 夹具预置不可旁路
- WHEN either smoke or ui-walk starts through the shared compiled-server helper, or a mutation deletes/reorders fixture copy or removes files.hurl from Make smoke
- THEN both valid modes SHALL provision the tracked three files before startup and mutated wiring SHALL fail the precise source/runtime oracle; existing lifecycle and sibling-job isolation guarantees remain unchanged

第三个 harness job uid-isolation SHALL 遵循 omp-uid-isolation 的正式CI要求，timeout15，隔离job-owned端口/DB/状态并复用既有工具安装及compiled-server smoke。all-checks-passed SHALL 额外依赖uid-isolation，direct job精确八个；checkout/setup-node出现次数 SHALL 分别8/6，uv及其它action数量不变。源码派生oracle SHALL 同步新job步骤/env/aggregate与helper可选OMP_USER保留；任何去掉opt-in、换uid传递、HOME门禁、共享组执行或必需依赖的候选 SHALL 被拒绝。既有两个harness jobs及全部更早场景保持不变。

#### Scenario: uid job 与精确 oracle 原子接线
- WHEN the workflow and source/runtime guardrails run on the same revision
- THEN eight direct jobs include uid-isolation, checkout/setup-node counts are8/6, the selected Linux test is executed not skipped, real-omp five-file smoke passes under OMP_USER=omp, and failure/cancelled/skipped in that job fails the aggregate

#### Scenario: 换 uid 透传保持可选
- WHEN the existing compiled-server helper receives OMP_USER absent or present
- THEN absent retains existing direct smoke/UI behavior without inventing an empty user, while present is preserved into the server; no fallback silently drops the user

#### Scenario: 已关闭 UID 降级与执行门禁一致
- **WHEN** source-derived controls inspect the active downgrade owner and Enforcement Index after the official merged-master UID job succeeds
- **THEN** only the three unrelated downgrades remain, the exact UID block row is active, and reintroduced risk registration or missing/weakened/decoy row is rejected without altering the runtime job

AGENTS.md 的 files-harness 文档镜像 SHALL 保持 server/ 的沙箱/审计/工作空间/对话职责，在 smoke/ 中列出沙箱夹具，并在现有 HTTP smoke evidence 单元中列出 public.hurl、auth.hurl、chat.hurl、files.hurl、session-meta.hurl 五文件。现有 command/调用方 ownership、UI 行与errororacle、十一surface（含 `ui-shots`）、UIDblock/三条剩余downgrades与所有既有场景 SHALL 不变；此文案与精确sourceoracle/mutation anchors同PR更新。

#### Scenario: 文件控制面反映已执行五文件
- **WHEN** AGENTS.md and its existing source-derived oracle are compared at the same revision
- **THEN** sandbox fixture and all five Hurl files are named in their proper documentation owners; stale wording is rejected without changing runtime, workflow, parser behavior or thresholds
