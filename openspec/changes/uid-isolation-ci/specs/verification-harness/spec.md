## MODIFIED Requirements

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.0.10（不添加 action/cache），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 同步 AGENTS.md、constraints.yaml 与 Makefile：Verification Matrix 明列 `make smoke`、`make ui-walk`、作为二进制供给前置的 `make omp-fetch` 和手动真实上游 `make smoke-live` 及各自 evidence；Enforcement Index 保持 smoke/ui-walk 为 `block`，omp-fetch 为 prerequisite，smoke-live 为 `review-only`。Directory Map 的 server/ 与 smoke/ SHALL 包含对话职责。constraints.yaml verification.surfaces SHALL 恰有十个 surface，各含 command/evidence/required_at，新增 omp-fetch 与 smoke-live 的 required_at 分别为 prerequisite/manual。Makefile 页头 SHALL 描述这些职责且不再延后 #107；四个同名 targets 与 .PHONY 保持一致，source-derived oracle SHALL 拒绝每个 target 的 GNU Make 等价 spaced duplicate/redefinition。strictness_profile.downgrades SHALL 记录 S0b 同 uid 仅环境白名单保护仍暴露 /proc/<app pid>/environ 与配置文件凭证，关闭条件为 ADR0010 的 S1a uid-isolation CI/deployment 证据，不得声称仅设置 OMP_USER 即关闭。

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
- **WHEN** 比对 AGENTS.md matrix/enforcement/directory、constraints.yaml 十个 verification.surfaces 与 Makefile 页头/target/PHONY，并分别注入四个 target 的 spaced duplicate
- **THEN** 四条命令与 evidence/required_at/执行级别一致；AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot；四种 duplicate 均被拒绝，原 smoke/ui-walk block、四文件 smoke、CI jobs 与聚合不变
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

### Requirement: 第三方 CI action 使用 Node 24 runtime
CI SHALL 只以 `actions/checkout@v5`、`actions/setup-node@v5`、`astral-sh/setup-uv@v7` 与 `gitleaks/gitleaks-action@v3` 使用这四种第三方 action；其对应 major tag 的 `action.yml` SHALL 声明 `runs.using: node24`，且 GitHub-hosted runner SHALL 满足 Node 24 action 所需的 runner v2.327.1+。八个 direct jobs 的使用矩阵 SHALL 完整且唯一：checkout 分别出现在 fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk、uid-isolation；setup-node 分别出现在 fast-checks、unit-tests、anti-drift、smoke、ui-walk、uid-isolation；setup-uv 只出现在 fast-checks 与 unit-tests；gitleaks-action 只出现在 secret-scan。不得保留旧/混合 major、Node 20 fallback environment、重复/替换/旁路 action 或未受约束的同类使用点。

关键输入与顺序 SHALL 保持：每个 checkout 在所属 job 的仓库消费者前执行；六个 setup-node 均保留 exact `{ node-version-file: .tool-versions, cache: npm }` 并在 `npm ci` 前完成，只缓存 npm package-manager data 而非 `node_modules`；两个 setup-uv 在 `uv sync` / `uv run` 前安装 uv并保持 GitHub-hosted cache lookup/restore 与成功 post lifecycle，按 cache hit/miss 允许 no-save/save 分支；secret-scan 的 checkout 保留 exact `fetch-depth: 0`，随后 gitleaks-action 只以 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 环境运行。所有原有 run steps、job timeout、constraints mirror、质量阈值、service harness、八项 aggregate dependencies及 failure/cancelled/skipped 拒绝语义 SHALL 保持不变。

source-derived CI oracle SHALL 从实际传入 workflow 解析全部八个 direct jobs，校验上述 action major/矩阵/输入/顺序和无 fallback/bypass 条件；任一旧 major、遗漏、混合、重复、替换、relocation、关键 input 漂移或 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 注入均 SHALL 使 `make test-guardrails` 非零。Mutation generator SHALL 绑定 scratch source，生成失败不得充当成功 rejection；不使用目标 action 的新增 unrelated job SHALL 继续可演进。

#### Scenario: 所有 direct jobs 在 Node 24 action 上完成
- **WHEN** 新 PR CI 在 GitHub-hosted `ubuntu-latest` 执行该 workflow
- **THEN** fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk、uid-isolation 与 `all-checks-passed` 均成功，所有 action post/cache steps 和原有下游 run steps实际执行
- **AND** setup-node 从 `.tool-versions` 使用 Node 24.13.1，main step 完成 npm cache lookup/restore（允许 primary-key hit 或 miss）且 post step 成功；primary-key miss 时 SHALL 保存新 cache，hit 时 SHALL 允许明确的 `not saving cache` 结果；setup-uv 安装可执行 uv并完成其 hosted cache lifecycle，secret-scan 在 full-history checkout 后成功执行 gitleaks

#### Scenario: Node 20 runtime annotation 完全消失
- **WHEN** 查询同一 PR head SHA 上八个 direct jobs 的全部 check-run annotations 与 action step logs
- **THEN** `Node.js 20 is deprecated` annotation 为零，四种 action均不被列为 Node 20 target，且 workflow/job/step environment 中不存在 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`
- **AND** 项目 `.tool-versions` 的 Node 24 与 action自身的 `runs.using: node24` SHALL 作为两个独立证据记录，不得相互替代

#### Scenario: action major、输入与矩阵漂移 fail closed
- **WHEN** fixture 将任一使用点回退到旧 major、删除/重复/替换/搬移 action、形成新旧 major混合、改变 setup-node version/cache input、secret checkout depth、gitleaks token、setup顺序，或加入 Node 20 fallback/bypass metadata
- **THEN** source-derived oracle 非零，且每个 mutation 确实消费生成的 scratch workflow；baseline 和不使用目标 action 的 unrelated job 控制组仍通过

#### Scenario: 主版本兼容边界保持
- **WHEN** 比对四个候选 major 的 release notes、`action.yml` inputs/runtime 与本仓实际配置
- **THEN** checkout fetch/full-history、setup-node Node/npm cache、setup-uv install/cache 与 gitleaks token/扫描行为均有书面兼容性结论，runner 最低版本由 GitHub-hosted 环境满足
- **AND** 不升级更高 action major，不改变 action pin 策略、workflow permissions、secret 值、应用工具链版本、产品代码、timeout、步骤或门禁阈值；依赖/lockfile 仅允许用户授权的根 YAML 解析开发依赖 `yaml@^2.9.0` 及必要锁定元数据，不升级其他依赖
