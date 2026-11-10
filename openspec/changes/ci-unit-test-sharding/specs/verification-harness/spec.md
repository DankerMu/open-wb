## ADDED Requirements

### Requirement: 单元测试分片与合并覆盖率门禁
`unit-tests` SHALL 以 `strategy: { fail-fast: false, matrix: { shard: [1, 2, 3] } }`（块式）把 server 套件分 3 片，`unit-tests-web` 以同形 strategy 与 `shard: [1, 2, 3, 4]` 把 web 套件分 4 片（change ci-unit-test-sharding，#1959）。每片 SHALL 依次执行 checkout、setup-node、`npm ci`、`npm run test:shard --workspace <ws> -- --shard=${{ matrix.shard }}/<N>`，再以 `actions/upload-artifact@v7` 上传该片的 vitest blob：`name: vitest-blob-<ws>-${{ matrix.shard }}`、`path: <ws>/.vitest-reports/`、`include-hidden-files: true`、`if-no-files-found: error`、`retention-days: 1`、`overwrite: true`，不得有其它输入。

- 两个 workspace 的 `package.json` SHALL 含 exact `"test:shard": "vitest run --coverage --coverage.reporter=json --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 --coverage.thresholds.statements=0 --reporter=default --reporter=blob"` 与 exact `"test:merge": "vitest --merge-reports --coverage"`；`test` SHALL 仍为 `vitest run --coverage`。阈值只在分片内清零：单片的覆盖率远低于 80%，不清零就会失败。合并步骤不带任何阈值覆盖，阈值取 `vitest.shared.mjs`。
- 新 job `unit-coverage` SHALL 为 `needs: [unit-tests, unit-tests-web]`、`runs-on: ubuntu-latest`、`timeout-minutes: 10`，无 job 级 `if`。步骤依次为 checkout、setup-node、`npm ci`、两步 `actions/download-artifact@v8`（`pattern: vitest-blob-<ws>-*`、`path: <ws>/.vitest-reports`、`merge-multiple: true`，先 server 后 web）、`bash .github/scripts/ci-unit-merge.sh server`、`bash .github/scripts/ci-unit-merge.sh web`。任一分片失败时它为 skipped，由 `all-checks-passed` 拒绝。
- `.github/scripts/ci-unit-merge.sh <server|web>` SHALL 在调用 npm 之前确认 `<ws>/.vitest-reports/` 里恰为同一 N 的 `blob-1-N.json … blob-N-N.json`（序号与 N 都是不带前导零的正整数），无缺无多。参数不是 `server` 或 `web` 时退出 2；目录缺失或为空、含任何其它条目（点文件、目录、外来文件）、N 不一致、序号超出、个数不等于 N 时退出 1；全部通过后执行 `npm run test:merge --workspace <ws>`，原样带回其退出码。vitest `--merge-reports` 不校验分片是否齐全，缺片时其余分片的覆盖率仍可能越过阈值，这一步就是为了不让门禁因此假绿。
- 分片数 SHALL 有测量依据：按 vitest 的分片算法与 CI 实测逐文件耗时模拟，选出让最长一片加合并 job 不超过墙钟下限 job（当前为 `uid-isolation`）的最小片数。调整片数时 SHALL 重新测量，并同步 oracle 与本 requirement。
- `.gitignore` SHALL 含 `.vitest-reports/`。

#### Scenario: 分片合并与全量等价
- **GIVEN** 同一台机器、同一提交
- **WHEN** 对某个 workspace 逐片执行 `test:shard`，再执行 `ci-unit-merge.sh <ws>`；另执行一次全量 `npm test --workspace <ws>`
- **THEN** 两次的测试文件数与测试数（含 skipped）相同，覆盖率门禁结论相同；合并后的覆盖率四项与全量相差不超过 0.1 个百分点
- **AND** 分片日志含失败详情（default reporter），不打印局部覆盖率表

#### Scenario: 缺片、多片或阈值不足都使门禁失败
- **WHEN** 任一分片测试失败，或 `<ws>/.vitest-reports/` 缺一片、多出一片、N 混用、含外来条目，或合并后的覆盖率低于 `vitest.shared.mjs` 的阈值
- **THEN** 对应分片或 `unit-coverage` 非零（缺片类在调用 npm 之前就退出），`all-checks-passed` 非零
- **AND** 一片失败不取消其余分片（`fail-fast: false`），每片的日志完整

#### Scenario: 分片与合并接线不可漂移
- **WHEN** source-derived fixture 分别：分片列表少一片或与 `--shard` 的分母不符；`fail-fast` 改为 true、strategy 多一个键或被删除；分片改跑 `test:focus`；上传步骤被删除、换旧 major、放宽 `if-no-files-found`、去掉 `include-hidden-files`、改路径、去掉 `overwrite`、与另一个 workspace 重名或加 `continue-on-error`；在其它 job 加 upload-artifact；`unit-coverage` 被删除、移出聚合依赖、`needs` 少一个分片 job、加 job 级 `if: always()` 或 `continue-on-error`、改 timeout、绕过 `ci-unit-merge.sh` 直接 `npm run test:merge`、删掉一个 workspace 的合并或下载、放宽 download 的 pattern、互换路径、关掉 `merge-multiple`、换旧 major；或 package 脚本 `test:merge` 加阈值覆盖、`test:shard` 去掉 blob reporter、改名或保留阈值、`test` 去掉 `--coverage`
- **THEN** `make test-guardrails` 非零，且每个 mutation 确实消费生成的 scratch 副本；未变 fixture 仍通过
- **AND** `ci-unit-merge.sh` 的桩 npm 用例覆盖：三种完整集合各恰调用一次 `npm run test:merge --workspace <ws>`；十二种不完整或含杂项的目录都退出 1 且不调用 npm；未知或缺失参数退出 2；npm 的非零退出码原样带回

### Requirement: CI 并发取消
`.github/workflows/ci.yml` SHALL 在顶层、`jobs:` 之前声明块式

```yaml
concurrency:
  group: ci-${{ github.ref == 'refs/heads/master' && github.sha || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/master' }}
```

同一 PR ref 上的新运行取消旧运行；`refs/heads/master` 的运行永不取消，每个合入 master 的提交都有一次完整运行（change ci-unit-test-sharding）。master SHALL 按提交 sha 各占一个并发组：同一并发组里排队的运行会被更新的到达者取消，与 `cancel-in-progress` 无关，按 ref 分组会让连续合入时排队的 master 运行被取消。source-derived oracle SHALL 逐字钉住这两行。

#### Scenario: PR 新推送取消旧运行，master 不取消
- **WHEN** 同一 PR 在前一次运行结束前再次推送，或 master 连续合入两个提交
- **THEN** PR 的旧运行被取消（其 `all-checks-passed` 记为 cancelled，以新运行为准）；master 的每次运行各在自己的组里，都跑完，没有一次被排队或取消

#### Scenario: 并发配置不可漂移
- **WHEN** fixture 删除 `concurrency`、把 `cancel-in-progress` 改为 `true`、把任一处 `master` 改为 `main`、让 master 回到按 ref 分组、让 group 不再带 ref，或改成行内写法
- **THEN** `make test-guardrails` 非零；只改注释措辞的正对照仍通过

## MODIFIED Requirements

### Requirement: CI 接线与控制面同步
smoke 与 ui-walk SHALL 作为两个独立 Ubuntu job 进入 CI，并纳入 `all-checks-passed` 聚合；任一 job 失败、取消或跳过都 SHALL 使聚合失败。两 job SHALL 各自 checkout、按 lockfile `npm ci`、先执行 `npm run build --workspace web` 与 production server build，再执行 `make omp-fetch` 下载并校验官方 v18.12.3（其前紧邻一步 omp 二进制缓存，见「CI omp 二进制缓存」；#1932 owner 2026-11-09 裁定取代此前的「不添加 action/cache」），通过 `.github/scripts/ci-fake-upstream.sh` 启动 job-owned loopback 假上游并验证 bounded readiness，再以 job-owned fresh runner-temp SQLite DB 在 loopback 启动 compiled server，bounded readiness 成功后调用仓库同一个 `make smoke` 或 `make ui-walk`，最终只停止/清理本 job 创建的进程（含假上游与 omp）与临时状态。两个模式 SHALL 在启动任何服务进程前将 tracked smoke/fixtures/sandbox/u1 复制到各自 SANDBOX_ROOT/u1，先创建目标base，不删除现存工作空间内容；复制失败 SHALL 非零并不得继续启动。OMP_BIN 指向已校验的 `<repo>/var/omp/omp`；OMP_STATE_DIR 与 SANDBOX_ROOT 在各自 runner temp；MODEL_UPSTREAM_BASE_URL 为 job-local loopback `/v1`、MODEL_UPSTREAM_API_KEY=fake。现有进程组、取消与清理失败传播契约 SHALL 保持，两个 harness jobs SHALL 无真实模型上游或 secrets 引用；既有 secret-scan GITHUB_TOKEN 保持不变。smoke SHALL 安装并校验固定 Hurl 8.0.1 x86_64 Linux release（SHA-256 `cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06`），并以 `smoke/fixtures/static` 维持 exact-byte deep-link oracle；ui-walk SHALL 从 lockfile 的 Playwright 安装 Chromium 及 Ubuntu dependencies，并以真实 `web/dist` 运行。工具安装、readiness、server early-exit、harness 或 cleanup failure 均 SHALL 非零且不得泄漏 session/credential。

控制面 SHALL 同步 AGENTS.md、constraints.yaml 与 Makefile：Verification Matrix 明列 `make smoke`、`make ui-walk`、作为二进制供给前置的 `make omp-fetch`、手动真实上游 `make smoke-live` 与手动真实 RAGFlow `make smoke-kb`（change s2a-kb-ragflow）及各自 evidence；Enforcement Index 保持 smoke/ui-walk 为 `block`，smoke-live 与 smoke-kb 为 `review-only`（omp-fetch 只列在 Verification Matrix，SHALL NOT 回到 Enforcement Index），并含「办公文档转换隔离」一行（`.github/workflows/ci.yml` job `office-sidecar`，`block`）、「浏览器参考镜像」一行（`.github/workflows/ci.yml` job `browser-image`，`block`）与「守卫自证」一行（`scripts/test-guardrails.sh`，`make test-guardrails` + CI `guardrails`/`all-checks-passed`，`block`；PR #1906），由源码派生 oracle 钉住。Directory Map 的 server/ 与 smoke/ SHALL 包含对话职责。constraints.yaml verification.surfaces SHALL 恰有十一个 surface，各含 command/evidence/required_at，omp-fetch 的 required_at 为 prerequisite，smoke-live 与 smoke-kb 的为 manual。Makefile 页头 SHALL 描述这些职责且不再延后 #107；五个同名 targets（smoke/ui-walk/omp-fetch/smoke-live/smoke-kb）与 .PHONY 保持一致；`ui-shots` 目标、其 `UI_SHOTS_*` 变量与 `web` 的 `ui-shots` 脚本 SHALL 不存在，source-derived oracle SHALL 拒绝每个 target 的 GNU Make 等价 spaced duplicate/redefinition。第三方 action 白名单为六项（change s2a-kb-ragflow 删去 setup-uv；change ci-omp-binary-cache 加入 `actions/cache@v6`；change ci-unit-test-sharding 加入 `actions/upload-artifact@v7` 与 `actions/download-artifact@v8`，见「第三方 CI action 使用 Node 24 runtime」）；ui-walk job 的 `timeout-minutes: 15` 覆盖两个 Playwright project。S0b 同 uid 的 /proc 与配置文件凭证风险登记 SHALL 在 ADR0010 要求的 merged-master uid-isolation job 与 aggregate 全绿证据成立后关闭；strictness_profile.downgrades SHALL 不含 s0b_same_uid_credential_exposure，其余三条降级保持不变。AGENTS.md Enforcement Index SHALL 含 uid 隔离、CI uid-isolation/all-checks-passed 与 block 的精确四列行；不得以设置 OMP_USER、普通CI跳过或容器结果代替正式master证据，也不得声称用户生产部署已验收。

`fast-checks` 与 `anti-drift` SHALL 各使用 exact `timeout-minutes: 10`，在各自独立 runner 先执行 lockfile 约束的 `npm ci` clean install，再执行原有全部质量步骤（change s2a-kb-ragflow 起 `fast-checks` 不再有 setup-uv、`uv sync` 与 Ruff 三步，其余质量步骤与次序不变）；`fast-checks` 在其质量步骤的最后另执行一步 `npx openspec validate --all --strict --no-interactive`（#1126）：`openspec` CLI 由根 `package.json` 的 `devDependencies` 以精确版本 `@fission-ai/openspec` `1.13.2`（不带 `^` / `~`）固定并进入 lockfile，这一步校验 `openspec/specs/` 下的全部规格与 `openspec/changes/` 下全部未归档的 change，任一 ERROR 即失败；AGENTS.md SHALL 写明 openspec 一律经 `npx openspec` 调用、不用全局安装的版本；该预算来自 300–302 秒历史安装高尾及同 workflow 10 分钟 `unit-tests` 成功对照，不代表 registry/cache/runner 底层延迟来源已被证明或消除。`constraints.yaml` SHALL 分别以 `ci.fast_checks_timeout_minutes: 10` 与 `ci.anti_drift_timeout_minutes: 10` 镜像这两个执行值。source-derived oracle SHALL 拒绝任一 timeout 回退或镜像不一致、`npm ci`/下游质量步骤删除或替换（含 `openspec validate` 一步被删除、去掉 `--strict`、或换成不经 `npx` 的全局命令）、job/step `if`/`continue-on-error`/custom shell 绕过，以及 aggregate 对 failure/cancelled/skipped 的弱化。secret-scan、sast 的 timeout 与步骤、smoke/ui-walk 的 timeout，以及覆盖率、复杂度、重复、文件大小、diff size 和其他门禁阈值 SHALL 保持不变。

单元测试 SHALL 拆成两个并行的独立 Ubuntu job：`unit-tests` 使用 exact `timeout-minutes: 10`，`unit-tests-web` 使用 exact `timeout-minutes: 20`（#1554：拆分后 web 套件单独在慢 runner 上已达 517–572 秒，快 runner 303–430 秒，差异来自 runner 而非个别用例）。两者 SHALL 按「单元测试分片与合并覆盖率门禁」各自分片（change ci-unit-test-sharding，#1959 owner 2026-11-10 批准，取代 #1554 时「仍不分片」的裁定）：`unit-tests` 分 3 片跑 server 套件，`unit-tests-web` 分 4 片跑 web 套件，每片依次执行 checkout、setup-node、`npm ci`、`npm run test:shard --workspace <ws> -- --shard=${{ matrix.shard }}/<N>` 与 blob 上传；覆盖率门禁在 `unit-coverage` 合并全部分片后执行。两者都不安装 uv（change s2a-kb-ragflow 随 `kbservice/` 退役删去 `unit-tests` 的 setup-uv、`uv sync` 与 `uv run pytest` 三步）。根 `package.json` 的 workspaces 恰为 server 与 web，两组分片加合并 SHALL 覆盖 `npm test --workspaces` 的全部套件与覆盖率门禁，不得遗漏其一；测试内容、覆盖率阈值与本地 `make test` SHALL 不变，也不新增 `constraints.yaml` 镜像。`all-checks-passed.needs` SHALL 同时包含 `unit-tests`、`unit-tests-web` 与 `unit-coverage`。source-derived oracle SHALL 以完整 metadata（含 `strategy` 原文）与步骤序列钉住这三个 job，拒绝任一 job 缺失或不在聚合依赖中、`unit-tests` 的 timeout 偏离 10、`unit-tests-web` 的 timeout 偏离 20、action major 漂移、setup 步骤缺失/重复/搬移、`npm ci` 或任一测试步骤删除/替换（含两个 workspace 互换）、任一 job 出现 setup-uv、`uv` 或 `pytest` 步骤，以及 job/step `if`/`continue-on-error` 绕过。

**Python 工具链退役（change s2a-kb-ragflow）。** 仓库 SHALL NOT 含 `kbservice/` 目录与 Python 依赖清单（`pyproject.toml` / `uv.lock`）；workflow 任一 job SHALL NOT 含 setup-uv、`uv` 或 `pytest` 步骤；naming-guard、semgrep、size-guard 与 jscpd 的路径参数 SHALL NOT 含 `kbservice`；source-derived CI contract oracle SHALL 对上述任一回潮非零。

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
- **THEN** 五条命令与 evidence/required_at/执行级别一致；AGENTS.md 无 `READINESS GAP` 且无过期 Known blind spot，也无 `make ui-shots` 行；五种 duplicate 均被拒绝；重新加入 `ui-shots` surface、target 或 AGENTS 行的候选被拒绝，原 smoke/ui-walk block、五文件 smoke、CI jobs 与聚合不变
- **AND** 删除或篡改任一新增镜像、职责或有效 downgrade 会使 oracle 非零；comment、fence 或其他 YAML owner 中的同名文本不能代替 active 条目

#### Scenario: 安装高尾不再抢占全部质量检查预算
- **GIVEN** 历史 `npm ci` 高尾为 300–302 秒，fast-checks 后续步骤约 4–6 秒、anti-drift 后续步骤约 2–3 秒，且 10 分钟 unit-tests 在相同高尾后完成
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置运行 fast-checks 与 anti-drift
- **THEN** 两 job 各有 10 分钟总预算，`npm ci` 之后的 Biome/typecheck 或 knip/jscpd/naming/size 步骤实际执行且成功，不以 cancelled/skipped 结束，`all-checks-passed` 成功

#### Scenario: 单元测试拆分后两套件各有独立预算
- **GIVEN** 拆分前 `unit-tests` 在一个 runner 上串行执行 server vitest、web vitest 与 kbservice pytest，对 10 分钟时限的实测耗时为 6:20、9:41、9:48、超时、9:09、9:57、超时（测试本身全部通过，两次靠重跑）；其中一次超时运行里 `npm ci` 约 8 秒（缓存命中）、server 套件约 3.5 分钟、web 套件约 6 分钟
- **WHEN** 新 PR 与 master push CI 使用本 requirement 的配置并行运行 `unit-tests` 与 `unit-tests-web` 的全部分片，再运行 `unit-coverage`
- **THEN** 工作流共十四个 job：十三个 direct job（fast-checks、unit-tests、unit-tests-web、unit-coverage、anti-drift、guardrails、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image）加 `all-checks-passed`（guardrails 由 PR #1906 加入，unit-coverage 由 change ci-unit-test-sharding 加入）；两个测试 job 的每片各有自己的预算（`unit-tests` 10 分钟、`unit-tests-web` 20 分钟），server 套件在 `unit-tests` 的三片、web 套件在 `unit-tests-web` 的四片实际执行且成功，`unit-coverage` 合并后的测试文件数等于该 workspace 的全部测试文件，没有套件被遗漏
- **AND** 任一分片、`unit-coverage` 中任一 failure/cancelled/skipped 时 `all-checks-passed` 非零

#### Scenario: 测试 job 的拆分不可漂移
- **WHEN** source-derived fixture 分别删除 `unit-tests-web` 或 `unit-coverage`、把任一移出 `all-checks-passed.needs`、把任一测试 job 的 timeout 改成 15、把 `unit-tests-web` 的 timeout 改回 10 或把 `unit-tests` 的改成 20、删除或替换任一测试步骤、互换两个 workspace、在 `unit-tests-web` 回退/删除/重复/搬移 checkout 或 setup-node、为它或 `unit-tests` 加入 setup-uv，或加入 job/step skip/continue 绕过
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

第三个 harness job uid-isolation SHALL 遵循 omp-uid-isolation 的正式CI要求，timeout15，隔离job-owned端口/DB/状态并复用既有工具安装及compiled-server smoke。all-checks-passed SHALL 额外依赖uid-isolation，direct job（含 unit-tests-web、unit-coverage、office-sidecar、browser-image 与 guardrails）精确十三个（guardrails 由 PR #1906 加入，unit-coverage 由 change ci-unit-test-sharding 加入）；checkout/setup-node出现次数 SHALL 分别13/11，setup-uv 不出现（change s2a-kb-ragflow），`actions/cache@v6` 恰四次（「CI omp 二进制缓存」），upload-artifact / download-artifact 各恰两次（「单元测试分片与合并覆盖率门禁」），其它action数量不变。源码派生oracle SHALL 同步新job步骤/env/aggregate与helper可选OMP_USER保留；任何去掉opt-in、换uid传递、HOME门禁、共享组执行或必需依赖的候选 SHALL 被拒绝。既有两个harness jobs及全部更早场景保持不变。第四个 harness job office-sidecar（office-preview「真实转换的人工验证」场景「CI 端到端」；change `office-convert-sandbox` D10）SHALL 在 `ubuntu-24.04` 上以 job 内现场构建的 converter 镜像、`--network none` 跑一次真实转换并与 `--network host` 对照；uid-isolation 同样固定 `runs-on: ubuntu-24.04`（#1502）；第五个 harness job browser-image（browser-runtime「CI browser-image job」；change `omp-browser-integration` D8）SHALL 在 `ubuntu-24.04` 上以 job 内现场构建的参考 app 镜像跑一次真实浏览器端到端。源码派生 oracle SHALL 把三者的 `runs-on` 钉在 `ubuntu-24.04`，变异到 `ubuntu-latest` 即拒绝。

#### Scenario: uid job 与精确 oracle 原子接线
- WHEN the workflow and source/runtime guardrails run on the same revision
- THEN thirteen direct jobs include uid-isolation, unit-tests-web, unit-coverage, office-sidecar, browser-image and guardrails, checkout/setup-node counts are 13/11, the selected Linux test is executed not skipped, real-omp five-file smoke passes under OMP_USER=omp, and failure/cancelled/skipped in that job fails the aggregate

#### Scenario: 换 uid 透传保持可选
- WHEN the existing compiled-server helper receives OMP_USER absent or present
- THEN absent retains existing direct smoke/UI behavior without inventing an empty user, while present is preserved into the server; no fallback silently drops the user

#### Scenario: 已关闭 UID 降级与执行门禁一致
- **WHEN** source-derived controls inspect the active downgrade owner and Enforcement Index after the official merged-master UID job succeeds
- **THEN** only the three unrelated downgrades remain, the exact UID block row is active, and reintroduced risk registration or missing/weakened/decoy row is rejected without altering the runtime job

AGENTS.md 的 files-harness 文档镜像 SHALL 保持 server/ 的沙箱/审计/工作空间/对话职责，在 smoke/ 中列出沙箱夹具，并在现有 HTTP smoke evidence 单元中列出 public.hurl、auth.hurl、chat.hurl、files.hurl、session-meta.hurl 五文件。现有 command/调用方 ownership、UI 行与errororacle、十一surface、UIDblock/三条剩余downgrades与所有既有场景 SHALL 不变；此文案与精确sourceoracle/mutation anchors同PR更新。

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

#### Scenario: Python 工具链退役后不可回潮
- **WHEN** source-derived oracle 读取的 workflow 分别被注入：`fast-checks` 加回 setup-uv 与 `uv run ruff check .`；`unit-tests` 加回 `cd kbservice && uv run pytest`；naming-guard、semgrep、size-guard 或 jscpd 的路径参数加回 `kbservice`
- **THEN** `make test-guardrails` 的 CI contract oracle 对每一例非零；未变 fixture 仍通过；仓库里不存在 `kbservice/` 目录

### Requirement: 第三方 CI action 使用 Node 24 runtime
CI SHALL 只以 `actions/checkout@v5`、`actions/setup-node@v5`、`gitleaks/gitleaks-action@v3`、`actions/cache@v6`、`actions/upload-artifact@v7` 与 `actions/download-artifact@v8` 使用这六种第三方 action（change s2a-kb-ragflow 随 `kbservice/` 退役删去 `astral-sh/setup-uv@v7`；change ci-omp-binary-cache 加入 `actions/cache@v6`，只用于「CI omp 二进制缓存」；change ci-unit-test-sharding 加入 upload/download-artifact，只用于「单元测试分片与合并覆盖率门禁」，#1959 owner 2026-11-10 批准）；其对应 major tag 的 `action.yml` SHALL 声明 `runs.using: node24`，且 GitHub-hosted runner SHALL 满足 Node 24 action 所需的 runner v2.327.1+。十三个 direct jobs（guardrails 由 PR #1906 加入，unit-coverage 由 change ci-unit-test-sharding 加入）的使用矩阵 SHALL 完整且唯一：checkout 分别出现在 fast-checks、unit-tests、unit-tests-web、unit-coverage、anti-drift、guardrails、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image；setup-node 分别出现在 fast-checks、unit-tests、unit-tests-web、unit-coverage、anti-drift、guardrails、smoke、ui-walk、uid-isolation、office-sidecar、browser-image；setup-uv 不出现在任何 job；gitleaks-action 只出现在 secret-scan；cache 只出现在 smoke、ui-walk、uid-isolation、browser-image，各恰一次；upload-artifact 只出现在 unit-tests 与 unit-tests-web，各恰一次；download-artifact 只出现在 unit-coverage，恰两次。matrix 腿不计入静态使用次数。不得保留旧/混合 major、Node 20 fallback environment、重复/替换/旁路 action 或未受约束的同类使用点。

关键输入与顺序 SHALL 保持：每个 checkout 在所属 job 的仓库消费者前执行；十一个 setup-node 均保留 exact `{ node-version-file: .tool-versions, cache: npm }` 并在 `npm ci` 前完成，只缓存 npm package-manager data 而非 `node_modules`；secret-scan 的 checkout 保留 exact `fetch-depth: 0`，随后 gitleaks-action 只以 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 环境运行。除 unit-tests 按「CI 接线与控制面同步」拆出 unit-tests-web、两者再按「单元测试分片与合并覆盖率门禁」分片并加入 unit-coverage 外，所有原有 run steps、job timeout、constraints mirror、质量阈值、service harness，以及十三项 aggregate dependencies及 failure/cancelled/skipped 拒绝语义 SHALL 保持不变——例外三处：（change `office-convert-sandbox` S2a）`fast-checks` 的 `biome check` 步骤加入 `converter` 目录；`constraints.yaml` `ci.matrix` 加入 `ubuntu-24.04`；（change ci-omp-binary-cache）四个 job 加入「CI omp 二进制缓存」的缓存步骤，browser-image 另加 `make omp-fetch` 且其 `docker build` 带 `--build-context omp-seed=var/omp`。

source-derived CI oracle SHALL 从实际传入 workflow 解析全部十三个 direct jobs，校验上述 action major/矩阵/输入/顺序和无 fallback/bypass 条件；任一旧 major、遗漏、混合、重复、替换、relocation、关键 input 漂移或 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 注入均 SHALL 使 `make test-guardrails` 非零。`scripts/inspect-ci-workflow.js` 的 `ALLOWED` SHALL 含 `actions/cache: v6`、`actions/upload-artifact: v7` 与 `actions/download-artifact: v8`，`WANT` SHALL 含 `actions/cache@v6` 计数 4（change ci-omp-binary-cache）、`actions/upload-artifact@v7` 计数 2 与 `actions/download-artifact@v8` 计数 2（change ci-unit-test-sharding），对 checkout / setup-node 的期望计数 SHALL 随之为 13 / 11（它由 oracle 末尾与 baseline 用例调用）。Mutation generator SHALL 绑定 scratch source，生成失败不得充当成功 rejection；不使用目标 action 的新增 unrelated job SHALL 继续可演进。

#### Scenario: 所有 direct jobs 在 Node 24 action 上完成
- **WHEN** 新 PR CI 在 GitHub-hosted runner 执行该 workflow（uid-isolation、office-sidecar 与 browser-image 在 `ubuntu-24.04`，其余在 `ubuntu-latest`）
- **THEN** fast-checks、unit-tests（三片）、unit-tests-web（四片）、unit-coverage、anti-drift、guardrails、secret-scan、sast、smoke、ui-walk、uid-isolation、office-sidecar、browser-image 与 `all-checks-passed` 均成功，所有 action post/cache steps 和原有下游 run steps实际执行
- **AND** setup-node 从 `.tool-versions` 使用 Node 24.13.1，main step 完成 npm cache lookup/restore（允许 primary-key hit 或 miss）且 post step 成功；primary-key miss 时 SHALL 保存新 cache，hit 时 SHALL 允许明确的 `not saving cache` 结果，secret-scan 在 full-history checkout 后成功执行 gitleaks

#### Scenario: Node 20 runtime annotation 完全消失
- **WHEN** 查询同一 PR head SHA 上十三个 direct jobs（分片按 matrix 腿逐个计）的全部 check-run annotations 与 action step logs
- **THEN** `Node.js 20 is deprecated` annotation 为零，六种 action均不被列为 Node 20 target，且 workflow/job/step environment 中不存在 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`
- **AND** 项目 `.tool-versions` 的 Node 24 与 action自身的 `runs.using: node24` SHALL 作为两个独立证据记录，不得相互替代

#### Scenario: action major、输入与矩阵漂移 fail closed
- **WHEN** fixture 将任一使用点回退到旧 major、删除/重复/替换/搬移 action、形成新旧 major混合、改变 setup-node version/cache input、secret checkout depth、gitleaks token、setup顺序，或加入 Node 20 fallback/bypass metadata
- **THEN** source-derived oracle 非零，且每个 mutation 确实消费生成的 scratch workflow；baseline 和不使用目标 action 的 unrelated job 控制组仍通过

#### Scenario: 主版本兼容边界保持
- **WHEN** 比对六个候选 major 的 release notes、`action.yml` inputs/runtime 与本仓实际配置
- **THEN** checkout fetch/full-history、setup-node Node/npm cache、gitleaks token/扫描行为、`actions/cache@v6`（`runs.using: node24`、`post-if: success()`、只用 `path`/`key` 两个输入、不设 `restore-keys`）、`actions/upload-artifact@v7`（`runs.using: node24`；v4 起默认跳过隐藏文件，故显式 `include-hidden-files: true`；同一运行内 artifact 名不可重复，故名字带 workspace 与分片号，并以 `overwrite: true` 让「重跑全部 job」覆盖上一轮同一片的 blob）与 `actions/download-artifact@v8`（`runs.using: node24`；`pattern` 加 `merge-multiple: true` 把多个 artifact 平铺进同一目录）均有书面兼容性结论，runner 最低版本由 GitHub-hosted 环境满足
- **AND** 不升级更高 action major，不改变 action pin 策略、workflow permissions、secret 值、应用工具链版本、产品代码、timeout、步骤（change ci-omp-binary-cache 的缓存步骤与 browser-image 步骤、change ci-unit-test-sharding 的分片与合并步骤例外）或门禁阈值；依赖/lockfile 仅允许用户授权的根 YAML 解析开发依赖 `yaml@^2.9.0` 及必要锁定元数据，不升级其他依赖
