# Tasks: office-convert-sandbox

> 跟踪：#1350 保持打开；Stage 5 不另建 Epic，按下面的切片（S1、S2a、S2b、S3）以 #1350 为父建子 issue，一个子 issue 一个 PR；S3 合并后关闭 #1350。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - S1 不依赖任何切片。它是原子的：app 侧 spool 客户端、sidecar 脚本与镜像、预检 / fail-closed、全部测试、工具面接线同一 PR（理由见组末）。
> - S2a ← S1（CI 新 job 导入 S1 的编译产物、构建 S1 的镜像）。**CI 改动，需 owner 确认**；owner 不批则不做，S2b 独立成立。
> - S2b ← S1（测试主机实测需要 S1 的真实代码与镜像）。执行者是编排方 / owner 本人。
> - S3 ← S1、S2b；S2a 若做则 ← S2a：终态措辞（ADR-0010 补充、ADR-0014、system.md、头注释）写的是已合入的行为与 S2b 的结果表（design D11）。S2b 取「红」时 S3 不开工，回 Stage 2。
>
> 通用纪律：见 design「通用纪律」，本文不复述；每组的「验证」都以它的合入门槛为底线。补充三条只与任务写法有关的：
> - **测试先行。** 有行为的任务先写测试并在未改动的代码上看到红（或在 PR 写明为何不可能红，例如新模块），再实现。
> - **开工核对。** 每组第一个任务是核对；核对出入先改 design 与本组任务，再继续（design「行号核对」）。
> - **白盒。** S1、S2a 触及 AGENTS.md 关键路径「沙箱与文件边界」「omp 子进程治理」：这两个 PR 请求人工白盒审查；S2b、S3 不含运行时代码，触发不成立，但同样把 design D13 该切片的审查清单贴进 PR 正文请一次轻量复核。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Auth / permissions / secrets | 选中：转换进程的网络与可见文件系统由容器构造给出；app 路径不进 spool；两行办公文档 sudoers 退役；sidecar 零 capability、`no-new-privileges`、同 uid；预检拒绝组 / 其它可写的 spool 根 | S1、S2a |
| File IO / path safety / overwrite | 选中：输入经 `openRegularFile`（末段 `O_NOFOLLOW`）复制字节；`request.json` / `done` / `failed` 原子 rename；输出复制纪律与 200 MiB 上界不变；`jobs/` 启动清空 | S1 |
| Config / project setup | 选中：`OFFICE_BIN` → `OFFICE_SPOOL_DIR`（1:1，`OFFICE_BIN` 被设置即启动失败）；Docker 成为前提；compose `user:` 对齐 uid；`CONVERTER_CONCURRENCY ≥ OFFICE_CONVERT_CONCURRENCY` | S1、S3 |
| Error handling / rollback / partial outputs | 选中：五种 kind 不增不减；`failed` 原因码不进 app；心跳不新鲜 → `unavailable`；sidecar 死在作业中途 → `timeout`；预检永不 reject；`ENOENT` 的吞掉范围 | S1 |
| Concurrency / shared state / ordering | 选中：冷启动竞态（5 s 等待 + `service_healthy`）；app 队列与 sidecar 并发的关系；两侧重启时的作业归属；边沿触发的日志 | S1、S2b |
| Legacy compatibility / examples | 选中：缓存键 / 命中 / 排队 / 文案 / 路由不变；D9 封闭表（第 5 种改法）；`work/` 留着无害 | S1 |
| Documentation / migration notes | 选中：ADR-0010 退役头注与新补充、ADR-0014 四节、system.md 9.7 两种形态、FL-25/26/27 改键 + FL-39、CONTEXT / IMPLEMENTATION_PLAN | S3 |
| Release / packaging / dependency compatibility | 选中：新目录 `converter/` 与镜像配方（Debian 包、CJK 字体）；守卫接线；不加 npm 依赖；CI runner 固定 `ubuntu-24.04` | S1、S2a |
| Public API / CLI / script entry | 选中：新 stderr 事件 `office_convert_sidecar_unavailable`；退役事件 `preview_work_clear_failed`；`officeAvailable` 的新条件；sidecar 的五个环境变量 | S1 |
| Schema / columns / units / field names | 未选：不碰数据库 | — |
| Resource limits / large input / discovery | 未选：轮询 ≤ 300 ms；镜像体积由部署方承担 | — |

## 行数预算（800 行硬上限；`scripts/size-guard.sh`，S1 起含 `converter/*.mjs`）

| 文件 | 现在 | 合入后上限 | 改动的切片 |
|---|---|---|---|
| `converter/sidecar.mjs`（新） | — | ≤ 400 | S1 |
| `converter/healthcheck.mjs`（新） | — | ≤ 30 | S1 |
| `converter/Dockerfile`（新） | — | ≤ 30 | S1 |
| `converter/compose.yml`（新） | — | ≤ 40 | S1 |
| `server/src/preview/office-sidecar-health.ts`（新） | — | ≤ 100 | S1 |
| `server/src/preview/office.ts` | 332 | ≤ 330 | S1、S3 |
| `server/src/preview/office-cache.ts` | 326 | ≤ 230 | S1、S3 |
| `server/src/preview-config.ts` | 153 | ≤ 165 | S1 |
| `server/src/server.ts` | 726 | ≤ 735 | S1 |
| `server/src/preview/app.ts` | 330 | ≤ 335（只改头注释，目标净减） | S3 |
| `server/test/support/fake-sidecar.ts`（新） | — | ≤ 200 | S1 |
| `server/test/converter-sidecar.test.ts`（新） | — | ≤ 500 | S1 |
| `server/test/office-converter.test.ts` | 795 | ≤ 700（重写） | S1 |
| `server/test/office-sidecar-health.test.ts`（新） | — | ≤ 200 | S1 |
| `server/test/office-converter-output.test.ts` | 189 | ≤ 200 | S1 |
| `server/test/office-queue.test.ts` | 603 | ≤ 590 | S1 |
| `server/test/office-cache.test.ts` | 462 | ≤ 470 | S1 |
| `server/test/office-cache-helpers.ts` | 160 | ≤ 190 | S1 |
| `server/test/office-work-clear.test.ts` | 496 | 删除 | S1 |
| `server/test/fixtures/fake-sudo-find.mjs` | 76 | 删除 | S1 |
| `server/test/fixtures/fake-soffice.mjs` | 152 | ≤ 170 | S1 |
| `server/test/server-startup-office.test.ts` | 434 | ≤ 450 | S1 |
| `server/test/preview-config.test.ts` | 271 | ≤ 285 | S1 |
| `server/test/omp-max-processes-config.test.ts` | — | +1 行 | S1 |
| `.github/scripts/ci-office-sidecar.sh`（新） | — | ≤ 120 | S2a |
| `.github/workflows/ci.yml` | — | 新 job + `needs` + `fast-checks` 一行 | S2a |
| `scripts/test-ci-harness.sh` | ≈ 500 | ≤ +40 | S2a |

## 1. S1 — sidecar 转换链：app 侧 spool 客户端、`converter/`、预检与 fail-closed（office-preview / http-service-skeleton / preview-origin）

- [ ] 1.1 开工核对：
  - 重读 `server/src/preview/office.ts` 全文（尤其 `:31`、`:51-69`、`:158-200`、`:270-302`）、`office-cache.ts:71-173`（保留）与 `:176-326`（`sudo` 段退役）、`office-queue.ts` 全文（不改）、`server.ts:196-227`、`:430-445`、`:575-586`、`preview-config.ts:38-39`、`:63`、`:73`、`:144-153`、`preview/app.ts:100`、`:125-`、`:253-266`、`:284`、`:304`、`workspaces/regular-file.ts` 全文、`core/process-path.ts` 全文；
  - `grep -rn "fake-sudo-find\|officeBin\|OFFICE_BIN\|preview_work_clear_failed\|stopWorkClear\|clearWork" server/src server/test` 与 design D9 表逐条对照：每一处命中都应在表里；表外命中停下先补 D9；
  - `grep -rn "work/\|\"work\"" server/src/preview server/src/server.ts server/test` 列出 `work` 目录的全部引用（建目录、mode 断言、清空），确认 D6「`work` 不再建」没有漏掉的消费方；
  - `wc -l` 预算表里的每个文件；
  - `grep -n officeReady server/src/preview/app.ts server/src/server.ts`：确认它只门在启动清空上、不门在心跳上（design D6「`officeReady` 门不变」）；
  - 核对 `fake-soffice.mjs` 现有的 `@标记` 词汇（`:38` 起），决定 sidecar 测试「杀整组」用例需要的派生子进程标记是否已有（没有则加一个，≤ 18 行）；
  - 核对守卫接线面：`biome.json:4-11`、`Makefile` `lint`、`scripts/size-guard.sh:12-13,:22`、`.jscpd.json`、`scripts/test-guardrails.sh:45-63`——确认 design D7 列的五处就是全部；`knip.json` 不改（`converter/` 不是 workspace、不被 import）；
  - 本机核对 `docker build converter/`（有 Docker 的机器上）与 `node:24-bookworm-slim` 里 Debian 的 `libreoffice-*-nogui` / `fonts-noto-cjk` 包名可解析；没有 Docker 的开发机写明「未构建，S2a / S2b 首次构建」。

  验证：核对结果写进 PR。
- [ ] 1.2 先写 sidecar 脚本测试（新 `server/test/converter-sidecar.test.ts`），覆盖 office-preview「转换 sidecar 实现与镜像」场景「sidecar 脚本对着假 soffice」的全部 WHEN：以子进程启动 `node converter/sidecar.mjs`（`CONVERTER_SPOOL_DIR` 临时目录、`CONVERTER_SOFFICE_BIN=fake-soffice.mjs`、`POLL_MS=20`、`HEARTBEAT_MS=50`、`CONCURRENCY=1`），测试充当 app：正常 → `done` + argv / 环境 / `HOME` / cwd 断言 + PDF 字节；`@exit1` → `exit`；`@empty` → `no-output`；`@sleep`+`timeoutMs 200` → `timeout` 且假 `soffice` 与其派生子进程不存在；`@sleep`+`cancel` → `cancelled`；六种 `bad-request`；心跳周期；并发 1 的次序；落定前目录被删不崩；`jobs/` 晚于 sidecar 300 ms 建出时不崩；`SIGTERM` 杀组退出 0；日志行不含输入名；标记原子性（紧循环读目录直到标记出现，从未观察到 `.part` 名或半截 `failed`）。**不 import** `sidecar.mjs`。
  验证：在未改动的代码上判红（脚本不存在即红）。
- [ ] 1.3 先写 app 侧测试：
  - 新 `server/test/office-sidecar-health.test.ts`：覆盖「转换 sidecar 的健康与 fail-closed」场景「预检的两个方向（单元）」（`pollMs 20`、`waitMs 400`、`utimes` 伪造心跳年龄、五例、永不 reject、不建目录不 chmod）；
  - 新 `server/test/support/fake-sidecar.ts`（design D8：`fs.watch` + 100 ms 轮询、`@标记` 词汇与假 `soffice` 一致、记录 `request.json` / `in/` 字节 / `cancel` 时刻、心跳线程与 `"stale"` 模式；头注释写明不做隔离）；
  - 重写 `server/test/office-converter.test.ts`（按 D9 表：保留检查次序三例、构造参数例、作业目录被删例的骨架；其余删除），覆盖「sidecar 转换契约」六个场景的全部 WHEN（三键、字节相等、哨兵不泄露、换入成符号链接 → `failed`、五种标记 → kind、`cancel` 三个写点、四种输出边界（`office-converter-output.test.ts` 改接缝）、检查次序与 message `cacheDir and spoolDir must be absolute paths`）与「转换 sidecar 的健康与 fail-closed」场景「运行期心跳的边沿触发」；
  - `office-queue.test.ts` / `office-cache.test.ts` / `office-cache-helpers.ts` 改接缝（D9 表第 4 种；删 `office-queue.test.ts:220-249` 一例，第 5 种），覆盖「并发上限与排队」「转换缓存与作业目录清理」的全部场景（含「启动清空 `jobs/`、不启动子进程」）；
  - `server-startup-office.test.ts`：第二个 `describe`（`:274-434`）删除；既有三例改 `OFFICE_SPOOL_DIR` + 进程内假 sidecar，SIGTERM 例改为断言 `cancel` 与 `jobs/` 为空；新例覆盖「预检失败后的服务」全部 WHEN（四种失败 → 一行 + `officeAvailable=false` + 503 + 零作业；2 s 后心跳 → 可用无行（编译入口唯一的真实墙钟例）；未配置 → 无行；`OFFICE_BIN` 仍设置 → `reason:"config"` 且 message 含 `OFFICE_BIN` 不含值；`jobs/` 遗留 → 启动后为空）与 preview-origin「sidecar 不可用时转换不可用」、http-service-skeleton「两个监听器的启动与干净关停」THEN 的「没有 `work`」与「关停期间的在途请求与转换」THEN 的 `cancel`；
  - `preview-config.test.ts` 与 `omp-max-processes-config.test.ts:302-303` 按 D9 表改键名、加 `OFFICE_BIN` 被拒例；
  - 删除 `office-work-clear.test.ts`、`fixtures/fake-sudo-find.mjs`（第 5 种；偏离记录逐文件对应 REMOVED 的 requirement）。

  验证：在未改动的代码上判红（新键未解析、`spoolDir` 选项不存在、无预检行即红）；`office-converter.test.ts` ≤ 700 行。
- [ ] 1.4 实现 `converter/`：
  - `converter/sidecar.mjs`（design D7、D3：环境五键、心跳、领取、`request.json` 严格校验、`detached` spawn 与杀组、六个原因码、`.part` + `rename`、`ENOENT` 吞掉范围、`SIGTERM`、每作业一行不含输入名的日志；头注释是协议的单一真相）；`converter/healthcheck.mjs`；
  - `converter/Dockerfile`（`node:24-bookworm-slim`、三件 nogui + `fonts-dejavu-core` + `fonts-noto-cjk`、`--no-install-recommends`、清理 apt 列表、`COPY` 两个脚本、`ENTRYPOINT`、`USER node` 作地板）；`converter/compose.yml`（design D7 列出的全部键，`${WORKBUDDY_UID:?}` / `${WORKBUDDY_GID:?}` / `${OFFICE_SPOOL_DIR:?}` 缺席即拒绝启动，bind mount 不用命名卷）；
  - 守卫接线：`biome.json` `files.includes` 加 `converter/**`；`Makefile` `lint` 加 `converter`；`scripts/size-guard.sh` 的 `find` 加 `converter` 与 `-name '*.mjs'`、`case` 加 `*.mjs`；`scripts/test-guardrails.sh` 加一条 801 行 `.mjs` 探针被拒、800 行放行；`.jscpd.json` pattern 加 `converter`。**ci.yml 的 `fast-checks` 行不在本切片改**（S2a），PR 注明本地 `make lint` 已覆盖。

  验证：1.2 全绿；`make lint`、`make anti-drift`、`make test-guardrails` 全绿；`sidecar.mjs` ≤ 400 行。
- [ ] 1.5 实现 app 侧：
  - `server/src/preview/office.ts`：按 design D4 重写 spawn 段为 spool 客户端（`spoolDir` / `pollMs` 选项；`openRegularFile` 复制字节；三键 `request.json` 经 `.part` + `rename`；轮询 `done` / `failed`；`cancel` 三个写点；心跳检查与 `staleReported` 边沿 + 注入的 `log`；`collectOutput` 改读 `jobs/<id>/out/<stem>.pdf`，纪律不变；删 `buildLaunch` / `spawnAndWait` / `terminate` / `OfficeSpawn` / `ompUser` / `officeBin` / `process-path` import；错误 message `cacheDir and spoolDir must be absolute paths`）；
  - `server/src/preview/office-cache.ts`：删 `runSudoFind` / `stopWorkClear` / `log` 选项 / `FIND_PATH` / 两个时限常量 / `terminate` import；`createOfficeCleanup({cacheDir, spoolDir?})` 的 `clearWork` 改为本进程递归删 `<spoolDir>/jobs` 下条目（未配置或预检未过时不碰 spool）；`sweepPdf` 不变；头注释改写（去掉 `sudo … find` 段，`rmSync` 不跟随链接一段保留并改为「`jobs/` 下」）；
  - `server/src/preview-config.ts`：`officeSpoolDir?`、`resolveOfficeSpoolDir`（形状同 `resolveOfficeBin`）、`OFFICE_BIN` 被设置即抛 `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR`；头注释「十二个」不变、注释里的键名换掉；
  - 新 `server/src/preview/office-sidecar-health.ts`（≤ 100 行）：`heartbeatFresh(spoolDir, {freshMs, now})` 与 `preflightOfficeSidecar({spoolDir, waitMs, pollMs, freshMs})`（design D5 两步、永不 reject、不校正不 chmod）；转换器与入口都从这里取判定；
  - `server/src/server.ts`：`writeRecord` 联合类型删 `preview_work_clear_failed`、加 `office_convert_sidecar_unavailable`；`app` 阶段 `officeOf` 之前 `await preflightOfficeSidecar({spoolDir, waitMs: 5000, pollMs: 100, freshMs: 10000})`；`officeOf(config, sandbox)` 失败时不传 `spoolDir`、把 `writeRecord` 作为转换器的 `log` 传入；`emitOfficeSidecarUnavailable`；删 `owned.stopWorkClear` 与关停里对它的调用；`preparePreviewCache` 改为建 `pdf/`（不建 `work`）与（预检通过时）`<spool>/jobs`（`0700`）并 `await cleanup.clearWork()`；头注释 `:575-579` 改写；`StartupStage` 不加值；
  - `server/src/preview/app.ts` 本切片不改（头注释归 S3）。

  验证：1.3 全绿；预算表里的每个 `server/` 文件在上限内；`npm test --workspace server` 全绿（含 `preview-office-route*.test.ts`、`uid-isolation.test.ts` 原样通过）。
- [ ] 1.6 规格随刀：本 change 的 office-preview（2 REMOVED + 5 ADDED + 2 MODIFIED）、http-service-skeleton、preview-origin 三份 delta 由归档合入主规格，本任务只核对实现与 delta 逐句一致（尤其「sidecar 转换契约」的六步、「转换 sidecar 实现与镜像」的校验规则与原因码、「转换 sidecar 的健康与 fail-closed」的两步预检与边沿日志）；PR 正文写明 Migration Plan 的五条部署步骤与回滚。
- [ ] 1.7 变异证据（逐条做、逐条撤销，结果贴进 PR）：design D8「变异证据」的全部条目——app 侧 8 条（`request.json` 多键 / 不经 `openRegularFile` / 去心跳检查 / `staleReported` 不复位 / 超时不写 `cancel` / 忽略预检 / `waitMs` 0 / `waitMs` 30 s）与 sidecar 5 条（去扩展名校验 / 只杀 pid / 标记不原子 / `done` 先于校验 / `ENOENT` 抛出），每条写出判红的用例名。
- [ ] 1.8 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；CI 九个既有 job 绿（本切片不改 CI；`fast-checks` 的 `biome check` 不含 `converter`，由 S2a 补——PR 注明本地 `make lint` 已含）。PR 请求白盒审查（design D13 S1 清单）。
Suggested fixture level: expanded - 改转换子系统的进程边界与文件交接协议、新增容器镜像与启动期预检（auth/permissions + file IO + error handling 风险包，Critical Path「沙箱与文件边界」「omp 子进程治理」）。
Minimal mergeable slice: atomic - app 侧客户端没有 sidecar 就没有可用的转换；sidecar 没有客户端就是死代码；预检没有两者就无物可探；两条 REMOVED 的 requirement 与它们的测试必须随替代者同一 PR 退役，否则主干上有一段时间 `OFFICE_BIN` 与 `OFFICE_SPOOL_DIR` 两套契约并存；守卫接线不随 `converter/` 一起合入则 lint / size-guard 对新目录是盲的。

## 2a. S2a — CI 新 job `office-sidecar` 与合同同步（omp-uid-isolation / office-preview「真实转换的人工验证」）——**CI 改动，需 owner 确认**

- [ ] 2a.1 开工核对：重读 `.github/workflows/ci.yml` 全文、`scripts/test-ci-harness.sh:118`（`check_wf` 与 `aggregate` 字面）、`:177-197`（job 合同）、`:391-405`（`extra-job` 的 AST 用例）、`constraints.yaml:102-106`、`AGENTS.md:136-150`、`scripts/inspect-ci-workflow.js`；`grep -rn "nine\|九个\|uid-isolation\]" scripts constraints.yaml AGENTS.md openspec/specs`。**然后把新 job 的桩（`office-sidecar: runs-on: ubuntu-24.04`、一个 `echo` step、加进 `needs`）放进 ci.yml 跑 `make test-guardrails`**，把每一条被拒的合同原样贴进 PR——那是本组其余任务的清单，不是猜。
  验证：核对结果与被拒清单写进 PR。
- [ ] 2a.2 `.github/scripts/ci-office-sidecar.sh`（design D10 六步：spool `0700`；`docker run` 标志与 `compose.yml` 逐项相同；等 `heartbeat` ≤ 30 s；runner 上 `python3 -m http.server` + `python3 zipfile` 生成含 `TargetMode="External"` http 图片链接的最小 docx；`node --input-type=module -e` 导入 `server/dist/preview/office.js` 的 `createOfficeConverter` 转换 → PDF 存在、`/Subtype /Image` 计数 0、监听器 0 次、`jobs/` 为空、PDF 属 runner uid；对照 `--network host` 直接 `soffice` → ≥ 1 次且含图；`docker stop` → 退出 0、无残留）。
  验证：脚本在本地有 Docker 的 Linux 机器上跑通（或写明首次在 CI 上跑）；≤ 120 行。
- [ ] 2a.3 `ci.yml`：新 job `office-sidecar`（`runs-on: ubuntu-24.04`、`timeout-minutes: 15`、checkout → setup-node → `npm ci` → `npm run build --workspace server` → `docker build -t workbuddy-converter:ci converter/` → `bash .github/scripts/ci-office-sidecar.sh`）；`all-checks-passed.needs` 加它；`fast-checks` 的 `biome check` 加 `converter`。其它 job 一个键不改。
- [ ] 2a.4 合同同步（按 2a.1 的被拒清单）：`scripts/test-ci-harness.sh` `aggregate` 字面、新 job 的存在 / `runs-on`（基线 `ubuntu-24.04`，变异到 `ubuntu-latest` 应被拒）/ `if` / `continue-on-error` / `timeout` 合同、`fast-checks` 步骤字面；`constraints.yaml` `ci.matrix`（加 `ubuntu-24.04` 或为该 job 单列，取 2a.1 的拒绝项所指）；`AGENTS.md` Enforcement Index 加一行「办公文档转换隔离 | `.github/workflows/ci.yml`（job `office-sidecar`） | CI `office-sidecar`/`all-checks-passed` | block」并加对应的 harness 合同（`cm` 行）；`scripts/inspect-ci-workflow.js` 若解析 job 清单则同步。
  验证：`make test-guardrails` 全绿，且 2a.1 的每条被拒项现在是 PASS；去掉新 job 的 `needs` 项或把 `runs-on` 改回 `ubuntu-latest` 时 harness 判红（两条变异做后撤销）。
- [ ] 2a.5 规格随刀：omp-uid-isolation「CI uid-isolation job」delta（九 → 十）与 office-preview「真实转换的人工验证」场景「CI 端到端」由归档合入；本任务核对 job 名、`needs` 与两处措辞一致。**owner 不批本切片时**：从本 change 删除 `specs/omp-uid-isolation/spec.md`、把「真实转换的人工验证」里 CI 的句子与场景改为测试主机措辞、「转换 sidecar 实现与镜像」场景「镜像与 compose 的标志」改为测试主机执行——这是 Stage 2 的回改，由编排方做。
- [ ] 2a.6 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；十个 job 绿，贴 `office-sidecar` 的 job 链接与脚本输出里「0 次请求 / 对照 ≥ 1 次」两行；PR 标题与正文都标「CI 改动，需 owner 确认」；请求白盒审查（design D13 S2a 清单）。
Suggested fixture level: compact - 不改产品代码；新增一个 CI job、一个脚本与合同同步；行为由规格 delta、合同行与 job 输出钉住。
Minimal mergeable slice: atomic - 新 job、`needs`、harness 合同与 AGENTS 行互为前提（少任一项 `make test-guardrails` 或聚合门禁之一必红）。

## 2b. S2b — 测试主机实测（office-preview「转换隔离边界」「真实转换的人工验证」）

- [ ] 2b.1 开工核对：S1 已合入；重读 design D11 (a)–(f) 与 system.md 9.7 草稿（S3 尚未合入时按 design Migration Plan 的五步部署）；备好 2026-10-12 的带 http 图片 docx、带 `file://` 图片的 docx / pptx、含中文正文的 docx / xlsx / pptx、归档 D17 那种约 25 s 的文档。
- [ ] 2b.2 两种部署形态各一次（app 裸机 + sidecar 容器；app 容器 + sidecar 容器），`OMP_USER` 两种模式各起一次 app：按 design D11 (a)–(e) 执行并记录；(c) 终止链重复 5 次；(d) fail-closed 四个动作顺序执行并数 stderr 行数；变异列两条（`network_mode: bridge` 重跑 http 例 → 应命中；挂入输入所在目录重跑 `file://` 例 → 应有图），做后撤销。
- [ ] 2b.3 结果表（design D11 (f)：内核、Docker、镜像基底与 LibreOffice 版本、(b)–(e) 各项、变异列；每行带证据等级；宿主不留文件；被跟踪文本只称「测试主机」）贴进 S3 的 PR 正文（S2a 若在做则同时链接到那里）。
  **两种结果**：(1) 全绿 → S3 按此写 ADR，D-25 残余按 (c) 的观察改写；(2) (b) 任一例有命中 / 有图、xlsx / pptx / 中文转不出 → **停下报告**，镜像配方回 design D7（不在实现 PR 里自行加包）；(d) 任一方向不成立 → S1 缺陷，回 S1。
Suggested fixture level: none - 不改任何文件；一次手工实测，结果进 S3 的文档。
Minimal mergeable slice: atomic - 没有 PR；实测项互为对照（http 例与对照、`file://` 例与变异、两种形态），拆开任一项结论都不完整。

## 3. S3 — 文档终态、ADR-0010 补充、验收行、关闭 issue（docs only）

- [ ] 3.1 开工核对：重读 `docs/adr/0010-dedicated-omp-uid.md:222-288`；`docs/adr/0014-isolated-preview-origin.md:31-37`、`:61-74`、`:104-133`、`:150-171`、`:185-223`；`docs/architecture/system.md:378-396`（9.6 是末节）；`docs/acceptance/functional-checklist.md:241-243`、`:254`；`CONTEXT.md:25`；`IMPLEMENTATION_PLAN.md:334-335`、`:342`、`:463`；`server/src/preview/app.ts:34-52`、`office.ts:1-16`、`office-cache.ts:1-45`（S1 已改写的部分核对措辞）；S2b 的结果表。行号有出入先改 design。
- [ ] 3.2 ADR-0010：2026-10-12 补充（`:222-288`）节首加头注「2026-10-17 起退役（#1350，change `office-convert-sandbox`）：办公文档转换不再以 omp 用户、不再经 sudo；两行 sudoers 规则删除；下文保留为历史」；新一节「2026-10-17 补充：#1350 办公文档转换移入 `--network none` 的 sidecar」——B1–B7 的裁定与两轮 bwrap 实测为何否决（背景）、spool 协议一段、身份（同 uid、无 sudo）、退役清单、预检 / fail-closed / 排障、B1 向量「未测、视为跟随，按构造覆盖（读手册推出）」、D-25 残余按 S2b (c) 改写、S2b 结果表；每条结论带证据等级。
- [ ] 3.3 ADR-0014：决定 6（`:31-37`）加「转换在 sidecar 容器里，app 不运行 LibreOffice」；已知残余表（`:61-74`）#1350 两行改为「已缓解（sidecar，`network_mode: none`、只挂 spool）：链接资源不再被取回（测试主机实测，S2b 结果表）；数据类向量未测、按构造覆盖」、`soffice.bin` 行按 S2b；「LibreOffice 与 `OFFICE_BIN`」节（`:104-113`）改为「转换 sidecar 与 `OFFICE_SPOOL_DIR`」（两种部署形态步骤、`WORKBUDDY_UID/GID`、`CONVERTER_CONCURRENCY ≥ OFFICE_CONVERT_CONCURRENCY`、sudoers 两行删除）；「十二个环境变量」表（`:114-133`）`OFFICE_BIN` 行换成 `OFFICE_SPOOL_DIR`；`:157` 与「被终止的转换留下的进程」（`:161-171`）按 S2b 改写；「真实转换的验证记录」（`:185-223`）节首加「2026-10-12 的记录，对应 sidecar 之前的转换链」头注，不删。
- [ ] 3.4 system.md §9 新小节「9.7 办公文档转换的 sidecar 容器（#1350，change `office-convert-sandbox`）」：Docker 前提；裸机形态与容器形态各自的步骤（Migration Plan 1–3）；`office_convert_sidecar_unavailable` 的排障（`docker compose ps`、`heartbeat` 年龄、spool 属主与 mode、`CONVERTER_*`）；fail-closed 的用户可见表现（503 固定页、令牌 `officeAvailable`、sidecar 死在作业中途是 504）；`OFFICE_BIN` 升级提示。
- [ ] 3.5 头注释：`preview/app.ts:34-52` ① 段改为「输入侧：转换在 `--network none`、只挂 spool 的 sidecar 容器里进行，app 只把输入的字节经 `openRegularFile` 复制进作业目录——`lstat` 之后换入成符号链接 → `failed`（与 `/w/` 同守末段）；文档引用的资源：网络不存在、本地文件不在容器里（测试主机实测：http 图 0 请求、`file://` 图不进 PDF；数据类向量未测、按构造覆盖）」（目标净减）；`office.ts:1-16` 与 `office-cache.ts:1-45` 核对 S1 的措辞与 S2b 一致（D-25 段按观察）；`server.ts:575-579` 同。
  验证：`app.ts` ≤ 335、`office.ts` ≤ 330、`office-cache.ts` ≤ 230；`npm test --workspace server` 全绿（只改注释）。
- [ ] 3.6 验收清单：FL-25 / FL-26 / FL-27 的 `OFFICE_BIN` 改为 `OFFICE_SPOOL_DIR`（含「由启动服务的人启动 / 停掉 sidecar 容器」的操作措辞）；新增 `FL-39`「由启动服务的人确认 sidecar 容器在跑（`docker compose ps` 为 healthy）且服务 stderr 没有 `office_convert_sidecar_unavailable`；在本机备一个 fl-link.docx（正文里插入一张『链接到文件』而不是嵌入的图片，图片放在工作空间之外，另插入一张 http 地址的链接图片）；经「+」菜单上传后在文件页点它」/「浏览器自带的 PDF 查看器里显示转换出的文档，两张链接图片的位置是空白或占位框，没有图片内容；其余文字可辨认」，结论 `待签`。
- [ ] 3.7 `CONTEXT.md:25` 术语里的 `OFFICE_BIN` 改为 `OFFICE_SPOOL_DIR` 并加一句「转换在 sidecar 容器里」；`IMPLEMENTATION_PLAN.md:334-335`、`:342`、`:463` 同步键名与部署要求（Docker + sidecar）。
- [ ] 3.8 规格核对：归档后主规格（office-preview 五条新 requirement、http-service-skeleton 两条、preview-origin、omp-uid-isolation）与 ADR / system.md / 头注释对同一事实说同一种话；D-25 与 B1 的措辞不强于证据。
- [ ] 3.9 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；PR 贴 design D13 S3 清单请轻量复核；合并后关闭 #1350，关闭评论引用本 change 的归档路径、S1 / S2a / S3 的 PR 号与 S2b 结果表。
Suggested fixture level: none - 只改文档、ADR、头注释与验收行，无运行时行为。
Minimal mergeable slice: atomic - 一次文档终态更新；拆开会让 ADR 与头注释在一段时间内对同一事实说两种话。
