## MODIFIED Requirements

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.0.10（不添加 action/cache），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 四处同步：AGENTS.md Verification Matrix 两条 READINESS GAP 行替换为 exact `make smoke` / `make ui-walk` + evidence；Enforcement Index 两行升 `block`；Known blind spots 删除过期 gap 条目；Directory Map 增 `smoke/`。`constraints.yaml` `verification.surfaces` 增 `smoke` 与 `ui-walk` 两条，command 分别逐字为 `make smoke` / `make ui-walk` 且 evidence 齐全。Makefile 的同名 targets 与 `.PHONY` SHALL 保持一致；source-derived oracle SHALL 拒绝 `smoke :` / `ui-walk :` 等 GNU Make 等价 duplicate/redefinition，使 canonical recipe 不得被保留文本旁路。

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
- **WHEN** 比对 AGENTS.md Verification Matrix、constraints.yaml verification.surfaces 与 Makefile target/grammar 集合，注入 `smoke :` / `ui-walk :` duplicate-recipe mutation，并检查 CI jobs/aggregate
- **THEN** `make smoke` 与 `make ui-walk` 的命令逐字一致、command/evidence/`block` 等级齐全，AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot，Directory Map 含 `smoke/`，Makefile `.PHONY` 与 canonical targets 同步，两个等价 duplicate mutation 均使 source-derived oracle 非零，CI 使用且无法旁路原 recipes

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
