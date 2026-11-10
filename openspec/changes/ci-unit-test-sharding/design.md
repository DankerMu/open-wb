# Design: ci-unit-test-sharding

Change surface：
- `.github/workflows/ci.yml`（顶层 `concurrency`；`unit-tests`、`unit-tests-web` 两个 job；新 job `unit-coverage`；`all-checks-passed.needs`）
- `scripts/fixtures/ci-contract/ci.yml.fixture`（ci.yml 的逐字副本）
- `.github/scripts/ci-unit-merge.sh`（新）
- `server/package.json`、`web/package.json`（`test:shard`、`test:merge`）
- `.gitignore`（`.vitest-reports/`）
- `scripts/test-ci-harness.sh`（`check_wf` 与 `contract()` 两个内嵌 oracle、`ccopy`、变异用例、合并脚本用例）
- `scripts/inspect-ci-workflow.js`（`ALLOWED` / `WANT`）
- `AGENTS.md` 与 `scripts/fixtures/ci-contract/AGENTS.md.fixture`（CI 排障协议的失败层列表）
- 本 change 的 spec delta

Must preserve：
- 本地 `make test`、`npm test --workspace <ws>`、`test:focus` 与覆盖率阈值（`vitest.shared.mjs` 的 80/80/80/80）不变。验证：`git diff --exit-code origin/master -- vitest.shared.mjs server/vitest.config.ts web/vitest.config.ts Makefile constraints.yaml` 退出 0。
- `unit-tests` 与 `unit-tests-web` 的 job 名、`runs-on: ubuntu-latest`、timeout（10 / 20）不变；`all-checks-passed` 的判定步骤与 `if: always()` 不变。
- 其余十个 job 一字不改。

Must add/change：
- D1 concurrency（工作流顶层，`jobs:` 之前）：
  ```yaml
  concurrency:
    group: ci-${{ github.ref == 'refs/heads/master' && github.sha || github.ref }}
    cancel-in-progress: ${{ github.ref != 'refs/heads/master' }}
  ```
  - PR 的 `github.ref` 是 `refs/pull/<n>/merge`，同一 PR 的新运行取消旧运行。
  - master 按 `github.sha` 各占一组：GitHub 的一个并发组只留一个运行中加一个排队的，新到的会取消排队的那个，与 `cancel-in-progress` 无关。若 master 也按 ref 分组，连续合入三个提交时中间那次就会被取消。每个 sha 一组之后，master 的运行既不排队也不互相取消，每个合入提交都有一次完整运行；`cancel-in-progress` 对 master 为假，作为第二道保险。
  - 默认分支是 `master` 不是 `main`。写成 `main` 时 master 的运行也会被取消，oracle 钉住字面值。
  - 被取消的旧 PR 运行以 cancelled 结束（其 `all-checks-passed` 带 `if: always()`，可能照常执行并因上游 cancelled 判失败），以新运行为准。`pull_request` 未写 `types`，只在 opened、synchronize、reopened 时触发，加 label 不会触发新运行。
- D2 分片 job：
  - `unit-tests` 为 `strategy: { fail-fast: false, matrix: { shard: [1, 2, 3] } }`（块式写法），步骤：checkout → setup-node → `npm ci` → `npm run test:shard --workspace server -- --shard=${{ matrix.shard }}/3` → `actions/upload-artifact@v7`（`name: vitest-blob-server-${{ matrix.shard }}`、`path: server/.vitest-reports/`、`include-hidden-files: true`、`if-no-files-found: error`、`retention-days: 1`、`overwrite: true`）。
  - `unit-tests-web` 同形，分 4 片，`web` 替换 `server`。
  - 分片数来自模拟：vitest 4.1.11 `BaseSequencer.shard` 的算法是按 `/<相对路径>` 的 sha1 排序后等数切片，分片内按文件大小降序分给 3 个 worker（4 vCPU runner 上 `availableParallelism() - 1`）。拿 run 42834271848 的逐文件耗时模拟，单片结果与实测相差不超过 2%（web 695 s 对 704 s，server 408 s 对 418 s）：

    | 套件 | 1 片 | 2 片 | 3 片 | 4 片 | 5 片 |
    |---|---|---|---|---|---|
    | web | 695 s | 367 s | 264 s | 210 s | 179 s |
    | server | 408 s | 219 s | 157 s | 133 s | 117 s |

    下限是 `uid-isolation`（中位 4.9 min，p90 5.3 min）。分片线要在它之内完成，即最长一片加合并 job（setup 约 20 s 加合并约 10 s）。web 取 4 片（210 s），server 取 3 片（157 s）：再多分一片，墙钟不会更短，只会多一份 setup。
  - `fail-fast: false`：默认值会在一片失败时取消其余分片，失败日志就不完整了。
  - `include-hidden-files: true`：`.vitest-reports` 是点目录，upload-artifact v4 起默认跳过隐藏文件，不打开就上传不到任何文件，`if-no-files-found: error` 会让分片失败。
  - `retention-days: 1`：blob 只供同一次运行的合并 job 使用。代价是运行超过一天后，单独重跑失败的分片时其余分片的 blob 已过期，`ci-unit-merge.sh` 以缺片失败（fail closed），这时要「重跑全部 job」。排障时先看是哪一片红。
  - `overwrite: true`：upload-artifact v4 起同一运行内同名 artifact 再上传会 409，「重跑全部 job」时上一轮的 blob 还在。名字按 workspace 与分片唯一，覆盖的只会是同一片自己的旧 blob。
- D3 `test:shard` / `test:merge`（两个 workspace 相同）：
  - `test:shard` = `vitest run --coverage --coverage.reporter=json --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 --coverage.thresholds.statements=0 --reporter=default --reporter=blob`。
    - 分片内必须清零阈值：本机实测 server 1/8 片单独跑时覆盖率 62%，按 80% 阈值以退出码 1 失败。
    - `--coverage.reporter=json` 让分片日志不打印局部覆盖率表：局部数字会被误读成失败。覆盖率数据仍随 blob 带到合并步骤。
    - `--reporter=default` 保留分片日志里的失败详情，只用 blob 会丢掉它们。
  - `test:merge` = `vitest run --merge-reports --coverage`（带 `run`：交互终端里 vitest 默认进 watch，而 `--merge-reports` 与 watch 互斥，本地照 CI 命令复现时会直接报错）：读取 `.vitest-reports/` 下的全部 blob，阈值取 `vitest.shared.mjs`。
  - `test` 仍是 `vitest run --coverage`。CI 不再直接跑它，但 `make test` 照旧用它。
- D4 `.github/scripts/ci-unit-merge.sh <server|web>`：
  - 参数不是 `server` 或 `web` 时退出 2。目录缺失、为空、含任何不匹配 `^blob-([1-9][0-9]*)-([1-9][0-9]*)\.json$` 的条目（含点文件、目录）、各文件 N 不一致、序号大于 N、个数不等于 N 时，都在调用 npm 之前退出 1。
  - 通过后执行 `npm run test:merge --workspace <ws>`，原样带回它的退出码。
  - 需要它的理由：vitest 的 `readBlobs` 只校验 blob 版本，不校验分片是否齐全。本机实测只合并 server 的第 2/3 片时，lines、functions、statements 三项都过了 80%，只有 branches 以 79.21% 失败。分片再多一些，缺一片就可能整体越过阈值。
  - 文件名各不相同、序号都在 1..N 内、N 也相同，个数等于 N 就说明 1..N 一个不缺。
  - 兼容 macOS 系统 bash 3.2（`[[ =~ ]]` 与 `BASH_REMATCH` 在 3.2 可用），与仓库其它脚本一致。
- D5 `unit-coverage` job：`needs: [unit-tests, unit-tests-web]`，`runs-on: ubuntu-latest`，`timeout-minutes: 10`。
  - 步骤：checkout → setup-node → `npm ci` → 两步 `actions/download-artifact@v8`（`pattern: vitest-blob-<ws>-*`、`path: <ws>/.vitest-reports`、`merge-multiple: true`）→ `bash .github/scripts/ci-unit-merge.sh server` → `bash .github/scripts/ci-unit-merge.sh web`。
  - 不加 `if: always()`：任一分片失败时它记为 skipped，聚合本来就拒绝 skipped。
  - 一个 job 合并两个 workspace：本机合并各约 2 s，再分成两个 job 只会多一份 setup。
  - `all-checks-passed.needs` 加入 `unit-coverage`，排在 `unit-tests-web` 之后。
- D6 oracle（`scripts/test-ci-harness.sh`）：
  - `check_wf`（`:126` 内嵌）：
    - 顶层解析记下每个块式键的子行，`concurrency` 必须为块式，且子行逐字等于 D1。
    - `parse_job` 把块式 `strategy:` 的子行原样收作 metadata 值，于是 `fail-fast`、`matrix` 与分片列表逐字钉住，多出任何键（如 `max-parallel`）都会不等。
    - `unit-tests`、`unit-tests-web` 移出纯 run 的 layer 循环，改为与 `shard_job("server", 3, "10")`、`shard_job("web", 4, "20")` 逐元组相等；`unit-coverage` 与 `coverage_job` 逐元组相等。三者都相等后，才把 `npm test --workspace server|web` 记为已覆盖，Makefile `test` 目标的镜像规则照旧生效。
    - `direct` 与必需 job 列表加入 `unit-coverage`。
  - `contract()`（`:94` 内嵌）：两个 workspace 的 `test`、`test:shard`、`test:merge` 三个脚本逐字钉住；`ccopy` 同时复制 `server/package.json`。
  - `scripts/inspect-ci-workflow.js`：`ALLOWED` 加 `actions/upload-artifact: v7` 与 `actions/download-artifact: v8`；`WANT` 改为 checkout 13、setup-node 11，新增 upload 2、download 2。两者的 `action.yml` 都声明 `using: 'node24'`（2026-11-10 经 GitHub API 核对 `v7` 与 `v8` tag）。matrix 腿不增加静态计数。
  - 现有用例里以 `actions/upload-artifact@v4` 作「非目标 action」诱饵的正对照（unrelated-job 与 ast cand02/03/09/10），诱饵换成不在 `ALLOWED` 里的 `actions/labeler@v5`。
  - 原来以 `- run: npm test --workspace web|server` 为锚点的变异改用分片命令作锚点，语义不变（删除、替换、互换 workspace、step `if` / `continue-on-error`）；聚合依赖「去掉 unit-tests-web」的锚点随 needs 列表更新。
  - 新增变异，每条都必须被拒：
    - concurrency：删除；`cancel-in-progress` 改为 `true`；`master` 改为 `main`（cancel 与 group 两处各一条）；master 不再按 sha 分组；group 去掉 ref；改为行内写法。
    - 分片：分片列表少一片、分母与列表不符、`fail-fast: true`、strategy 多一个键或整段删除、改跑 `test:focus`、分片步骤 `continue-on-error`。
    - 上传：删除、旧 major、`if-no-files-found` 放宽、删掉 `include-hidden-files` 或 `overwrite`、artifact 名与另一个 workspace 冲突、路径改错、`continue-on-error`；在 sast 加一步 upload（`WANT` 计数）。
    - 合并 job：删除、移出聚合依赖、`needs` 少一个分片 job、加 job 级 `if: always()` 或 `continue-on-error`、timeout 改动、绕过 `ci-unit-merge.sh` 直接 `npm run test:merge`、删掉一个 workspace 的合并、合并步骤 `continue-on-error`、download 的 pattern 放宽、路径互换、`merge-multiple: false`、旧 major、删掉一个 download。
    - package 脚本：`test:merge` 加阈值覆盖；`test:shard` 去掉 blob reporter、改名或保留一个阈值；`test` 去掉 `--coverage`。
  - 合并脚本用例（桩 npm 记录调用）：
    - 三个完整集合各通过，且恰调用一次 `npm run test:merge --workspace <ws>`：server 3 片、web 4 片、单片。
    - 以下情形退出 1 且不调用 npm：缺中间一片、三片只剩一片、序号超出、N 混用、序号 0、前导零、N 为 0、外来文件、点文件、目录条目、空目录、目录缺失。
    - 未知 workspace 与缺参数退出 2。
    - npm 失败时原样带回退出码 7。
  - 正对照：只改 concurrency 注释措辞仍通过。
- D7 文档同步：`AGENTS.md`「CI 排障协议」的失败层列表加入 `unit-coverage`，同步刷新 `AGENTS.md.fixture`（该行受 307 字节上限约束，分片与 blob 保留期的排障提示放在本 design D2）。spec delta 改写「CI 接线与控制面同步」里单元测试拆分一段及其两个 Scenario，新增「单元测试分片与合并覆盖率门禁」与「CI 并发取消」两个 requirement，并改写「第三方 CI action 使用 Node 24 runtime」的白名单与计数。

Required evidence：
- 先红：改 oracle 而 ci.yml 仍为旧版时，`check_wf` 拒绝旧 workflow，`inspect-ci-workflow.js` 报 `protected cardinality`；合并脚本用例在脚本落地前 22 条 FAIL。
- 本机等价性（2026-11-10，Apple Silicon 14 核）：
  - server 3 片合并：`436 passed | 21 skipped (457)`，`9256 passed | 153 skipped`，覆盖率 95.99 / 93.67 / 96.98 / 96.07，与同机全量 `vitest run --coverage` 逐项相同。
  - web 4 片合并：`258 passed (258)`，`5565 passed`，覆盖率 98.19 / 94.8 / 99.5 / 98.8。同机全量为 98.18 / 94.78 / 99.5 / 98.79，四项里三项合并后高 0.01–0.02 个百分点，测试文件数与测试数一致。
  - 合并各约 2 s。
- 缺片拒绝：真实 blob 只放 server 第 2/3 片时，`ci-unit-merge.sh server` 报「只有 1/3 个分片报告」并退出 1，没有调用 npm。
- `make test-guardrails` 与 `make check` 退出 0；`npx openspec validate ci-unit-test-sharding --strict --no-interactive` 退出 0。
- CI：本 PR 至少两次热缓存运行全绿。记录墙钟、关键路径、各分片与合并 job 的耗时，与模拟对照。
  - run 42844722963（未改任何缓存 key），第 1 次运行与第 2 次「重跑全部 job」均全绿：墙钟 329 s、328 s，关键路径 uid-isolation（322 s、315 s）。
  - web 最长一片 216 s、203 s；server 最长一片 216 s、188 s；unit-coverage 32 s、29 s。
  - 合并后的测试数与覆盖率和改前全量 CI 逐项一致。
  - 第 2 次是「重跑全部 job」，7 个上传步骤都没有 409，`overwrite: true` 生效。
  - server 分片比模拟慢 30–60 s，多出的时间估计来自每片重复的 import 与启动开销。
- 红路径：本机注入一个必败用例，`test:shard` 退出 1 并打印 `AssertionError`；CI 上此后的上传步骤因默认 `success()` 被跳过，`unit-coverage` 为 skipped，聚合拒绝。

Rollback：单个 revert 即可。oracle、fixture、ci.yml 与 package 脚本在同一提交里，revert 后回到不分片的两 job 结构。
