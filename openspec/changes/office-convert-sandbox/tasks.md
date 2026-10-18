# Tasks: office-convert-sandbox

> 跟踪：#1350 保持打开；Stage 5 不另建 Epic，按下面的切片（S1a、S1b、S2a、S2b、S3）以 #1350 为父建子 issue，一个子 issue 一个 PR；S3 合并后关闭 #1350。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - S1a 不依赖任何切片：`converter/`（sidecar 脚本、healthcheck、Dockerfile、compose）+ 它的子进程测试 + 假 `soffice` 的新标记 + **全部守卫接线**。不碰任何产品 `server/` 代码、不改任何既有断言——单独合入主干仍全绿。
> - S1b ← S1a：app 侧 spool 客户端、预检 / fail-closed、D9 表的全部退役与改接缝。它是原子的：两条 REMOVED 的 requirement 与替代者同一 PR（理由见组末）。
> - S2a ← S1a、S1b（CI 新 job 导入 S1b 的编译产物、构建 S1a 的镜像）。**CI 改动**，owner 已于 2026-10-17 批准（B10）。
> - S2b ← S1a、S1b（测试主机实测需要真实代码与镜像）。执行者是编排方 / owner 本人。
> - S3 ← S1b、S2a、S2b：终态措辞（ADR-0010 补充、ADR-0014、system.md、头注释）写的是已合入的行为与 S2b 的结果表（design D11）。S2b 取「红」时 S3 不开工，回 Stage 2。
>
> 通用纪律：见 design「通用纪律」，本文不复述；每组的「验证」都以它的合入门槛为底线。补充三条只与任务写法有关的：
> - **测试先行。** 有行为的任务先写测试并在未改动的代码上看到红（或在 PR 写明为何不可能红，例如新模块），再实现。
> - **开工核对。** 每组第一个任务是核对；核对出入先改 design 与本组任务，再继续（design「行号核对」）。
> - **白盒。** S1a、S1b、S2a 触及 AGENTS.md 关键路径「沙箱与文件边界」「omp 子进程治理」：这三个 PR 请求人工白盒审查；S2b、S3 不含运行时代码，触发不成立，但同样把 design D13 该切片的审查清单贴进 PR 正文请一次轻量复核。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Auth / permissions / secrets | 选中：转换进程的网络与可见文件系统由容器构造给出；app 路径不进 spool；两行办公文档 sudoers 退役；sidecar 零 capability、`no-new-privileges`、同 uid、`USER node` 地板；预检拒绝组 / 其它可写的 spool 根与属主不符的 `heartbeat`；同一 sidecar 内并发作业共享 fs / ipc / uid 的残余登记 | S1a、S1b、S2a、S3 |
| File IO / path safety / overwrite | 选中：输入经 `openRegularFile`（末段 `O_NOFOLLOW`）复制字节；`request.json` / `done` / `failed` 原子 rename；输出复制纪律（`O_NOFOLLOW|O_NONBLOCK`、恰 `size` 字节、200 MiB 上界）不变；`jobs/` 启动清空；作业目录消失即杀组 | S1a、S1b |
| Config / project setup | 选中：`OFFICE_BIN` → `OFFICE_SPOOL_DIR`（1:1，`OFFICE_BIN` 被设置即启动失败，owner B8）；Docker 成为前提；compose `user:` 对齐 uid；`CONVERTER_CONCURRENCY ≥ OFFICE_CONVERT_CONCURRENCY`；镜像由部署方自建（owner B9） | S1a、S1b、S3 |
| Error handling / rollback / partial outputs | 选中：五种 kind 不增不减；`failed` 原因码不进 app；心跳不新鲜 → `unavailable`；sidecar 死在作业中途 → `timeout`；预检永不 reject；预检等待中收到信号 → 干净退出、零记录；`ENOENT` 的吞掉范围 | S1a、S1b |
| Concurrency / shared state / ordering | 选中：冷启动竞态（5 s 等待 + `service_healthy`）；app 队列与 sidecar 并发的关系；两侧重启时的作业归属；边沿触发的日志 | S1b、S2b |
| Legacy compatibility / examples | 选中：缓存键 / 命中 / 排队 / 文案 / 路由不变；D9 封闭表（第 5 种改法）；`work/` 留着无害 | S1b |
| Documentation / migration notes | 选中：ADR-0010 退役头注与新补充、ADR-0014 四节（含残余表的并发作业一行）、system.md 9.7 两种形态、FL-25/26/27 改键 + FL-39、CONTEXT / IMPLEMENTATION_PLAN | S3 |
| Release / packaging / dependency compatibility | 选中：新目录 `converter/` 与镜像配方（新基底镜像与 Debian 包按 AGENTS.md:40 依赖政策在 PR 说明）；守卫接线（含 knip 根入口、jscpd、Makefile、根 `package.json`）；不加 npm 依赖；CI runner 固定 `ubuntu-24.04` | S1a、S2a |
| Public API / CLI / script entry | 选中：新 stderr 事件 `office_convert_sidecar_unavailable`（启动预检与运行期同一受管 writer）；退役事件 `preview_work_clear_failed`；`officeAvailable` 的新条件；sidecar 的五个环境变量 | S1a、S1b |
| Schema / columns / units / field names | 未选：不碰数据库 | — |
| Resource limits / large input / discovery | 未选：轮询 ≤ 300 ms；镜像体积由部署方承担 | — |

## 行数预算（800 行硬上限；`scripts/size-guard.sh`，S1a 起含 `converter/*.mjs`）

| 文件 | 现在 | 合入后上限 | 改动的切片 |
|---|---|---|---|
| `converter/sidecar.mjs`（新） | — | ≤ 400 | S1a |
| `converter/healthcheck.mjs`（新） | — | ≤ 30 | S1a |
| `converter/Dockerfile`（新） | — | ≤ 30 | S1a |
| `converter/compose.yml`（新） | — | ≤ 40 | S1a |
| `server/test/converter-sidecar.test.ts`（新） | — | ≤ 520 | S1a |
| `server/test/converter-sidecar-errors.test.ts`（新，S1a 评审后拆出） | — | ≤ 200 | S1a |
| `server/test/support/converter-sidecar.ts`（新，两份 sidecar 测试的共享夹具，避免 jscpd 克隆） | — | ≤ 250 | S1a |
| `server/test/converter-healthcheck.test.ts`（新） | — | ≤ 60 | S1a |
| `server/test/fixtures/fake-soffice.mjs` | 152 | ≤ 170 | S1a |
| `biome.json`、`Makefile`、根 `package.json`、`knip.json`、`.jscpd.json`、`scripts/size-guard.sh`、`scripts/test-guardrails.sh` | — | 各 ≤ +6 行（接线） | S1a |
| `server/src/preview/office-sidecar-health.ts`（新） | — | ≤ 100 | S1b |
| `server/src/preview/office.ts` | 332 | ≤ 340（评审后放宽） | S1b、S3 |
| `server/src/preview/office-cache.ts` | 326 | ≤ 230 | S1b、S3 |
| `server/src/preview-config.ts` | 153 | ≤ 165 | S1b |
| `server/src/server.ts` | 726 | ≤ 740（预检 `await` + 信号核对 + `emit`；删 `stopWorkClear`、`preview_work_clear_failed` 与五处过期注释） | S1b |
| `server/src/preview/app.ts` | 330 | ≤ 330（只改头注释与 `:10`、`:84-88` 两处注释，净零或净减） | S3 |
| `server/test/support/fake-sidecar.ts`（新） | — | ≤ 230（评审后放宽） | S1b |
| `server/test/office-converter.test.ts` | 795 | ≤ 700（重写） | S1b |
| `server/test/office-sidecar-health.test.ts`（新） | — | ≤ 200 | S1b |
| `server/test/office-converter-output.test.ts` | 189 | ≤ 200 | S1b |
| `server/test/office-queue.test.ts` | 603 | ≤ 590 | S1b |
| `server/test/office-cache.test.ts` | 462 | ≤ 470 | S1b |
| `server/test/office-cache-helpers.ts` | 160 | ≤ 190（删 `FAKE_SUDO` 与 `layout.sudo`，加 `FAKE_SIDECAR` 与假 sidecar 启动） | S1b |
| `server/test/office-work-clear.test.ts` | 496 | 删除 | S1b |
| `server/test/fixtures/fake-sudo-find.mjs` | 76 | 删除 | S1b |
| `server/test/server-startup-office.test.ts` | 434 | ≤ 460 | S1b |
| `server/test/server-startup-preview.test.ts` | — | 净减（`:151-152`、`:177`、`:179` 的 `work` 用例） | S1b |
| `server/test/preview-config.test.ts` | 271 | ≤ 285 | S1b |
| `server/test/omp-max-processes-config.test.ts` | — | +1 行 | S1b |
| `.github/scripts/ci-office-sidecar.sh`（新） | — | ≤ 130 | S2a |
| `.github/workflows/ci.yml` | — | 新 job + `needs` + `fast-checks` 一行 | S2a |
| `scripts/test-ci-harness.sh` | 938 | ≤ +40 | S2a |

## 1a. S1a — `converter/`：sidecar 脚本、镜像、compose、守卫接线（office-preview「转换 sidecar 实现与镜像」）

- [x] 1a.1 开工核对：
  - 重读 `server/test/fixtures/fake-soffice.mjs` 全文（`:30-46` 作业目录与记录文件的推导、`:38` 起的 `@标记` 词汇）：决定「杀整组」用例需要的派生子进程标记是否已有（没有则加 `@spawn-child` 一类，≤ 18 行）；确认它的记录文件落在 `jobs/<id>.record.json`——sidecar 列 `jobs/` 时必须跳过非目录条目（design D7）；
  - 核对守卫接线面：`biome.json:4-11`、`Makefile` `lint` / `fmt`、根 `package.json` 的 `lint` / `fmt` scripts、`scripts/size-guard.sh:12-13,:22`、`scripts/test-guardrails.sh:45-63`、`.jscpd.json` pattern、`knip.json` 根 workspace `.` 的 `entry`（今天只有 `scripts/inspect-ci-workflow.js`）、`web/test/ui-layering-exemptions.test.ts:118-125`（非 web workspace 不得有 `ignore`）——确认 design D7「工具面接线」列的七处就是全部；
  - 读 `AGENTS.md:40`（依赖政策：新增依赖须在 PR 说明为什么现有工具做不到）：新基底镜像 `node:24-bookworm-slim` 与五个 Debian 包按它在 PR 正文逐项说明；
  - 本机核对 `docker build converter/`（有 Docker 的机器上）与 `node:24-bookworm-slim` 里 Debian 的 `libreoffice-*-nogui` / `fonts-noto-cjk` 包名可解析；没有 Docker 的开发机写明「未构建，S2a / S2b 首次构建」。

  验证：核对结果写进 PR。
- [x] 1a.2 先写 sidecar 脚本测试（新 `server/test/converter-sidecar.test.ts`），覆盖 office-preview「转换 sidecar 实现与镜像」场景「sidecar 脚本对着假 soffice」的全部 WHEN：以子进程启动 `node converter/sidecar.mjs`（`CONVERTER_SPOOL_DIR` 临时目录、`CONVERTER_SOFFICE_BIN=fake-soffice.mjs`、`CONVERTER_POLL_MS=20`、`CONVERTER_HEARTBEAT_MS=50`、`CONVERTER_CONCURRENCY=1`），测试充当 app：正常 → `done` + argv / 环境 / `HOME` / cwd 断言 + PDF 字节；`@exit1` → `exit`；`@empty` → `no-output`；`@sleep`+`timeoutMs 200` → `timeout` 且假 `soffice` 与其派生子进程不存在；`@sleep`+`cancel` → `cancelled`、同上；**`@sleep` 作业目录在落定前被整个删除 → 假 `soffice` 及其派生子进程在有界时间内不存在、sidecar 不退出、随后的作业照常**（design D3「目录消失即杀」）；六种 `bad-request`（缺键、多键、`input` 含 `/`、`input` 为 `..`、扩展名 `html`、`timeoutMs` 为 `0` 或字符串）；`jobs/` 下一个普通文件（模拟 `<id>.record.json`）被跳过、不产生日志行；心跳周期；并发 1 的次序；`jobs/` 晚于 sidecar 300 ms 建出时不崩；`SIGTERM` 杀组退出 0；日志行不含输入名；标记原子性（紧循环读目录直到标记出现，`failed` 一出现内容即完整；同目录 `.part` 名可被短暂观察到，不算红；以 `--import` 钩子放慢 `writeFileSync` 让「直接写最终名」判红）。**不 import** `sidecar.mjs`。断言：本文件里 spawn 过的每个可执行文件的 basename 都不是 `soffice`、`libreoffice`、`docker`（是 `node` 与 `fake-soffice.mjs`）。
  新 `server/test/converter-healthcheck.test.ts`：以子进程运行 `node converter/healthcheck.mjs`（`CONVERTER_SPOOL_DIR` 临时目录）：`heartbeat` 新鲜 → 退出码 0；`utimes` 设为 30 s 前 → 1；缺席 → 1。
  验证：在未改动的代码上判红（脚本不存在即红）。
- [x] 1a.3 实现 `converter/`：
  - `converter/sidecar.mjs`（design D7、D3：环境五键、心跳、领取（跳过非目录条目）、`request.json` 严格校验、`detached` spawn 与杀组、每轮对在途作业核对「`cancel` 存在**或** `request.json` / 作业目录已不在」→ 杀组、六个原因码、`.part` + `rename`、`ENOENT` 吞掉范围、`SIGTERM`、每作业一行不含输入名的日志；头注释是协议的单一真相）；`converter/healthcheck.mjs`；
  - `converter/Dockerfile`（`node:24-bookworm-slim`、三件 nogui + `fonts-dejavu-core` + `fonts-noto-cjk`、`--no-install-recommends`、清理 apt 列表、`COPY` 两个脚本、`ENTRYPOINT`、`USER node` 作非 root 地板，不 `useradd`）；`converter/compose.yml`（design D7 列出的全部键，`${WORKBUDDY_UID:?}` / `${WORKBUDDY_GID:?}` / `${OFFICE_SPOOL_DIR:?}` 缺席即拒绝启动，bind mount 不用命名卷）。

  验证：1a.2 全绿；`sidecar.mjs` ≤ 400 行。
- [x] 1a.4 守卫接线（design D7 的完整清单，七处）：`biome.json` `files.includes` 加 `converter/**`；`Makefile` `lint` 与 `fmt` 加 `converter`；根 `package.json` 的 `lint` / `fmt` scripts 加 `converter`；`scripts/size-guard.sh` 的 `find` 加 `converter` 与 `-name '*.mjs'`、`case` 加 `*.mjs`；`scripts/test-guardrails.sh` 加一条 801 行 `.mjs` 探针被拒、800 行放行；`.jscpd.json` pattern 改为 `{server,web,kbservice,converter}/**/*.{ts,tsx,py,mjs}`；`knip.json` 根 workspace `.` 的 `entry` 加 `converter/sidecar.mjs`、`converter/healthcheck.mjs`（**不用 `ignore`**——`web/test/ui-layering-exemptions.test.ts:118-125` 禁止）。**ci.yml 的 `fast-checks` 行不在本切片改**（S2a）：在 S2a 合入前 CI 对 `converter/` 只有 anti-drift 的间接覆盖、不 lint 它——PR 注明本地 `make lint` 已覆盖、空档由已获批的 S2a（2a.3）关闭。**不改 `AGENTS.md`**：Enforcement Index 的「Lint/格式/复杂度（TS）」「文件 ≤800 行」「重复代码 ≤3%」「死代码」四行（`AGENTS.md:142`、`:146`、`:147`、`:148`，`4bac35cc`）的「所在」列只写配置文件 / 脚本（`biome.json`、`scripts/size-guard.sh`、`.jscpd.json`、`knip.json`），不列目录范围，扩大扫描面不需要改表（design 通用纪律：S1a 不碰 Enforcement Index）。jscpd 的 `mjs` 会同时扫既有 `server/test/**/*.mjs`（约 2.5k 行）：按 design Risks「jscpd 扫描面变大」以本任务的 `make anti-drift` 实测决定 `ignore` 测试夹具或拆 pattern；只能靠调高阈值时停下报告。
  验证：`make lint`、`make anti-drift`、`make test-guardrails` 全绿；`npx knip` 对 `converter/*.mjs` 零报告。
- [x] 1a.5 变异证据（逐条做、逐条撤销，结果贴进 PR）：design D8「变异证据」的 sidecar 7 条——去扩展名校验 / 去 `input` 含 `/` 校验 / 只杀 pid / 标记不原子 / `done` 先于校验 / `ENOENT` 抛出 / 去掉「目录消失即杀」——每条写出判红的用例名。
- [x] 1a.6 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；CI 九个既有 job 绿（本切片不改 CI）。PR 正文：AGENTS.md:40 的依赖说明（基底镜像 + 五个 Debian 包）、守卫接线的本地证据、请求白盒审查（design D13 S1a 清单）。
Suggested fixture level: expanded - 新增容器镜像与进程边界的 sidecar 一侧（spawn、杀组、文件标记协议；Critical Path「沙箱与文件边界」「omp 子进程治理」）。
Minimal mergeable slice: atomic - 脚本、测试、镜像配方与守卫接线互为前提（没有接线的 `converter/` 对 lint / size-guard / knip / jscpd 是盲区）；不碰 `server/` 产品代码与既有断言，所以单独合入主干仍全绿。

## 1b. S1b — app 侧 spool 客户端、预检与 fail-closed、D9 退役（office-preview / http-service-skeleton / preview-origin）

- [x] 1b.1 开工核对：
  - 重读 `server/src/preview/office.ts` 全文（尤其 `:31`、`:51-69`、`:158-200`、`:270-302`）、`office-cache.ts:71-173`（保留）与 `:176-326`（`sudo` 段退役）、`office-queue.ts` 全文（不改）、`server.ts:1-5`、`:36-40`、`:196-227`、`:430-445`、`:470-472`、`:507`、`:533-534`、`:550-552`、`:575-586`、`:606-641`、`preview-config.ts:38-39`、`:63`、`:73`、`:144-153`、`preview/app.ts:10`、`:84-88`、`:100`、`:125-`、`:253-266`、`:284`、`:304`、`workspaces/regular-file.ts` 全文、`core/process-path.ts` 全文；
  - `grep -rn "fake-sudo-find\|officeBin\|OFFICE_BIN\|preview_work_clear_failed\|stopWorkClear\|clearWork\|FAKE_SUDO" server/src server/test` 与 design D9 表逐条对照：每一处命中都应在表里；表外命中停下先补 D9；
  - `grep -rn "work/\|\"work\"\|on\.work" server/src/preview server/src/server.ts server/test` 列出 `work` 目录的全部引用（建目录、mode 断言、清空、`readdirSync`），确认 D6「`work` 不再建」没有漏掉的消费方（已知：`server-startup-preview.test.ts:151-152,:177,:179`、`office-cache.test.ts:297-303`、`office-cache-helpers.ts:117-126`、`server-startup-office.test.ts:80-82`）；
  - `wc -l` 预算表里的每个文件；
  - `grep -n officeReady server/src/preview/app.ts server/src/server.ts`：确认它只门在启动清空上、不门在心跳上（design D6「`officeReady` 门不变」）；
  - 过期注释清单（design D6「过期注释」）：`server.ts:1-5`、`:36-40`、`:507`、`:533-534`、`:550-552`（本切片改）；`preview/app.ts:10`、`:84-88`、`:34-52`（S3 改）。

  验证：核对结果写进 PR。
- [x] 1b.2 先写 app 侧测试：
  - 新 `server/test/office-sidecar-health.test.ts`：覆盖「转换 sidecar 的健康与 fail-closed」场景「预检的两个方向（单元）」（`pollMs 20`、`waitMs 400`、`utimes` 伪造心跳年龄、注入 `uid` 伪造 `heartbeat` 属主不符、六例、永不 reject、不建目录不 chmod）；
  - 新 `server/test/support/fake-sidecar.ts`（design D8：`fs.watch` + 100 ms 轮询、`@标记` 词汇与假 `soffice` 一致并多出 `fifo`（输出是没有写端的命名管道）与多点扩展名的 stem 推导、`nopdf`（不建 `out/`）、记录 `request.json` / `in/` 字节 / `cancel` 时刻、心跳线程与 `"stale"` 模式；头注释写明不做隔离）；
  - 重写 `server/test/office-converter.test.ts`（按 D9 表：保留检查次序三例、构造参数例、作业目录被删例的骨架；`:421-433` 多点扩展名、`:518` `@fifo`、`:596`「`pdf/` 不存在也算 failed」三例改接缝保留；其余删除），覆盖「sidecar 转换契约」六个场景的全部 WHEN（三键、字节相等、哨兵不泄露、换入成符号链接 → `failed`、六种标记 → kind（含 fifo）、多点扩展名 `report.v2@named.tar.docx` → `out/report.v2@named.tar.pdf`、`cancel` 三个写点、四种输出边界（`office-converter-output.test.ts` 改接缝）、检查次序与 message `cacheDir and spoolDir must be absolute paths`）与「转换 sidecar 的健康与 fail-closed」场景「运行期心跳的边沿触发」；断言 app 侧转换器**没有启动任何子进程**（`child_process.spawn` 计数为 0）；
  - `office-queue.test.ts` / `office-cache.test.ts` / `office-cache-helpers.ts` 改接缝（D9 表第 4 种；删 `office-queue.test.ts:220-249` 一例，第 5 种）：`office-cache.test.ts:45` `BAD_PATHS` 与 `:319-331` 两个工厂的 message 改为 `cacheDir and spoolDir must be absolute paths`、`:271-279` `officeBin: null` → `spoolDir` 缺席、`:297-303` `readdirSync(on.work)` → `jobs/` 为空；`office-cache-helpers.ts:27` 删 `FAKE_SUDO`、`:117-126` `bench(layout)` 删 `sudo` 分量、不建 `work`、导出 `FAKE_SIDECAR`；覆盖「并发上限与排队」「转换缓存与作业目录清理」的全部场景（含「启动清空 `jobs/`、不启动子进程」）；
  - `server-startup-office.test.ts`：第二个 `describe`（`:274-434`）删除；`:80-85` `sofficeRecords` 改读假 sidecar 的记录；既有三例改 `OFFICE_SPOOL_DIR` + 进程内假 sidecar，SIGTERM 例改为断言 `cancel` 与 `jobs/` 为空；新例覆盖「预检失败后的服务」全部 WHEN（四种失败 → 一行 + `officeAvailable=false` + 503 + 零作业，其中「无 `heartbeat`」一例另断言 `server_started` 出现在启动后 [5 s, 5 s+δ]；2 s 后心跳 → 可用无行；**预检等待中 SIGTERM（约 1 s）→ 进程 0 退出、≤ 5 s、stdout 与 stderr 零记录、端口与 DB 可复用**；未配置 → 无行；`OFFICE_BIN` 仍设置 → stderr 恰一行 `reason:"config"`、stderr 不含 `OFFICE_BIN` 字样（owner B8 细节：stderr 不点名），message 含 `OFFICE_BIN` 不含值；`jobs/` 遗留 → 启动后为空）——编译入口只有「2 s 后心跳」「无 `heartbeat` 的 5 s 窗口」「预检中 SIGTERM」三例真实墙钟（design D5 / D8 同一清单）；覆盖 preview-origin「sidecar 不可用时转换不可用」、http-service-skeleton「两个监听器的启动与干净关停」THEN 的「没有 `work`」与「关停期间的在途请求与转换」THEN 的 `cancel`；
  - `server-startup-preview.test.ts:151-152`（预置 `work/stale`）、`:177`（`modeOf(work)` 0o2770）、`:179`（`readdirSync(work)` 为空）：第 ③ 种改法——改为断言 `work` 不存在（MODIFIED「两个监听器的启动与干净关停」THEN「没有 `work`」）；
  - `preview-config.test.ts:163`、`:173`、`:181`（`config.officeBin` / `Object.hasOwn(..., "officeBin")`）与 `:34-45`、`:89-90`、`:120-121`、`:195`、`omp-max-processes-config.test.ts:302-303` 按 D9 表改键名、加 `OFFICE_BIN` 被拒例；
  - 删除 `office-work-clear.test.ts`、`fixtures/fake-sudo-find.mjs`（第 5 种；偏离记录逐文件对应 REMOVED 的 requirement）。

  验证：在未改动的代码上判红（新键未解析、`spoolDir` 选项不存在、无预检行即红）；`office-converter.test.ts` ≤ 700 行。
- [x] 1b.3 实现 app 侧：
  - `server/src/preview/office.ts`：按 design D4 重写 spawn 段为 spool 客户端（`spoolDir` / `pollMs` / `log` 选项；`openRegularFile` 复制字节；三键 `request.json` 经 `.part` + `rename`；轮询 `done` / `failed`；`cancel` 三个写点；心跳检查与 `staleReported` 边沿 + 注入的 `log`；`collectOutput` 改读 `jobs/<id>/out/<stem>.pdf`，`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 与 200 MiB 纪律不变；删 `buildLaunch` / `spawnAndWait` / `terminate` / `OfficeSpawn` / `ompUser` / `officeBin` / `process-path` import；错误 message `cacheDir and spoolDir must be absolute paths`）；
  - `server/src/preview/office-cache.ts`：删 `runSudoFind` / `stopWorkClear` / `log` 选项 / `FIND_PATH` / 两个时限常量 / `terminate` import；`createOfficeCleanup({cacheDir, spoolDir?})` 的 `clearWork` 改为本进程递归删 `<spoolDir>/jobs` 下条目（未配置或预检未过时不碰 spool）；`:63` 的构造校验 message 同样改为 `cacheDir and spoolDir must be absolute paths`；`sweepPdf` 不变；头注释改写（去掉 `sudo … find` 段，`rmSync` 不跟随链接一段保留并改为「`jobs/` 下」）；
  - `server/src/preview-config.ts`：`officeSpoolDir?`、`resolveOfficeSpoolDir`（形状同 `resolveOfficeBin`）、`OFFICE_BIN` 被设置即抛 `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR`（owner B8）；头注释「十二个」不变、注释里的键名换掉；
  - 新 `server/src/preview/office-sidecar-health.ts`（≤ 100 行）：`heartbeatFresh(spoolDir, {freshMs, now})` 与 `preflightOfficeSidecar({spoolDir, waitMs, pollMs, freshMs, uid?})`（design D5：spool 根三项 + `heartbeat` 属主 = 进程 uid + 新鲜等待、永不 reject、不校正不 chmod）；转换器与入口都从这里取判定；
  - `server/src/server.ts`：`writeRecord` 联合类型删 `preview_work_clear_failed`、加 `office_convert_sidecar_unavailable`；`app` 阶段 `officeOf` 之前 `const sidecarOk = await preflightOfficeSidecar({spoolDir, waitMs: 5000, pollMs: 100, freshMs: 10000})`，**紧随其后 `if (owned.signalReceived) { await releaseOwned(owned); return; }`**（与 `:470-472` 同形；位于 `emitOfficeSidecarUnavailable` 与 `officeOf` 之前，使取消时不写该行），然后 `officeOf(config, sidecarOk)` 失败时不传 `spoolDir`、把 `writeRecord` 作为转换器的 `log` 传入（同一受管 writer，写失败吞掉）；`emitOfficeSidecarUnavailable`；删 `owned.stopWorkClear` 与 `releaseOwned` 里对它的调用；`preparePreviewCache` 改为建 `pdf/`（不建 `work`）与（预检通过时）`<spool>/jobs`（`0700`）并 `await cleanup.clearWork()`；五处过期注释 `:1-5`、`:36-40`、`:507`、`:533-534`、`:550-552` 与 `:575-579` 头注释改写；`StartupStage` 不加值；主 listen 之后的无 `await` 不变量不动；
  - `server/src/preview/app.ts` 本切片不改（头注释与 `:10`、`:84-88` 归 S3）。

  验证：1b.2 全绿；预算表里的每个 `server/` 文件在上限内；`npm test --workspace server` 全绿（含 `preview-office-route*.test.ts`、`uid-isolation.test.ts` 原样通过）。
- [x] 1b.4 规格随刀：本 change 的 office-preview（2 REMOVED + 5 ADDED + 3 MODIFIED，其中「办公文档预览路由」只改一句、五个场景原样）、http-service-skeleton、preview-origin 三份 delta 由归档合入主规格，本任务只核对实现与 delta 逐句一致（尤其「sidecar 转换契约」的六步、「转换 sidecar 的健康与 fail-closed」的预检各项与边沿日志、http-service-skeleton 预检等待中的信号一句）；PR 正文写明 Migration Plan 的五条部署步骤与回滚。
- [x] 1b.5 变异证据（逐条做、逐条撤销，结果贴进 PR）：design D8「变异证据」的 app 侧 14 条——`request.json` 多键 / 不经 `openRegularFile` / 去心跳检查 / `staleReported` 不复位 / 每次 `unavailable` 都写一行 / 超时不写 `cancel` / 忽略预检 / 不写预检失败行 / 该行多一个键 / 写两行 / `waitMs` 0 / `waitMs` 30 s / 删掉预检后的 `signalReceived` 核对 / `collectOutput` 去掉 `O_NONBLOCK`——每条写出判红的用例名。
- [x] 1b.6 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；CI 九个既有 job 绿（本切片不改 CI）。PR 请求白盒审查（design D13 S1b 清单）。
Suggested fixture level: expanded - 改转换子系统的进程边界与文件交接协议、启动期预检与信号路径（auth/permissions + file IO + error handling 风险包，Critical Path「沙箱与文件边界」「omp 子进程治理」）。
Minimal mergeable slice: atomic - app 侧客户端、预检与 D9 退役互为前提：两条 REMOVED 的 requirement 与它们的测试必须随替代者同一 PR 退役，否则主干上有一段时间 `OFFICE_BIN` 与 `OFFICE_SPOOL_DIR` 两套契约并存；预检没有客户端就无物可探。

## 2a. S2a — CI 新 job `office-sidecar` 与合同同步（omp-uid-isolation / office-preview「真实转换的人工验证」）——**CI 改动**（owner 已于 2026-10-17 批准，B10）

- [ ] 2a.1 开工核对：重读 `.github/workflows/ci.yml` 全文（`all-checks-passed.needs` 在 `:163`）、`scripts/test-ci-harness.sh`（938 行；`check_wf` 与 `aggregate` 字面、job 合同、`extra-job` 的 AST 用例——行号开工时 `grep -n` 取）、`constraints.yaml:102-106`、`AGENTS.md:136-150`、`scripts/inspect-ci-workflow.js`；`grep -rn "nine\|九个\|uid-isolation\]" scripts constraints.yaml AGENTS.md openspec/specs`。**然后把新 job 的桩（`office-sidecar: runs-on: ubuntu-24.04`、一个 `echo` step、加进 `needs`）放进 ci.yml 跑 `make test-guardrails`**，把每一条被拒的合同原样贴进 PR——那是本组其余任务的清单，不是猜。
  验证：核对结果与被拒清单写进 PR。
- [ ] 2a.2 `.github/scripts/ci-office-sidecar.sh`（design D10 六步）：(1) 建 spool `0700` **并先建 `<spool>/jobs`（`0700`）与 `<cache>/pdf`（`0700`）**——脚本里没有 app 的 `preparePreviewCache`；(2) `docker run` 标志与 `compose.yml` 逐项相同；等 `heartbeat` ≤ 30 s；(3) runner 上 `python3 -m http.server` + `python3 zipfile` 生成含 `TargetMode="External"` http 图片链接的最小 docx；(4) `node --input-type=module -e` 导入 `server/dist/preview/office.js` 的 `createOfficeConverter` 转换 → PDF 存在、`/Subtype /Image` 计数 0、监听器 0 次、`jobs/` 为空、PDF 属 runner uid；(5) 对照 `docker run --rm --network host --entrypoint /usr/bin/soffice -e HOME=/job -v "$tmp:/job" --user … workbuddy-converter:ci --headless … --convert-to pdf --outdir /job/out /job/<同一 docx>`（镜像 `ENTRYPOINT` 是 `node /app/sidecar.mjs`，不覆盖就起不了 `soffice`）→ ≥ 1 次且含图；(6) `docker stop` → 退出 0、无残留。
  验证：脚本在本地有 Docker 的 Linux 机器上跑通（或写明首次在 CI 上跑）；≤ 130 行。
- [ ] 2a.3 `ci.yml`：新 job `office-sidecar`（`runs-on: ubuntu-24.04`、`timeout-minutes: 15`、checkout → setup-node → `npm ci` → `npm run build --workspace server` → `docker build -t workbuddy-converter:ci converter/` → `bash .github/scripts/ci-office-sidecar.sh`）；`all-checks-passed.needs`（`:163`）加它；`fast-checks` 的 `biome check` 加 `converter`（关闭 S1a 1a.4 注明的空档）。其它 job 一个键不改。
- [ ] 2a.4 合同同步（按 2a.1 的被拒清单）：`scripts/test-ci-harness.sh` `aggregate` 字面、新 job 的存在 / `runs-on`（基线 `ubuntu-24.04`，变异到 `ubuntu-latest` 应被拒）/ `if` / `continue-on-error` / `timeout` 合同、`fast-checks` 步骤字面；`constraints.yaml` `ci.matrix`（加 `ubuntu-24.04` 或为该 job 单列，取 2a.1 的拒绝项所指）；`AGENTS.md` Enforcement Index 加一行「办公文档转换隔离 | `.github/workflows/ci.yml`（job `office-sidecar`） | CI `office-sidecar`/`all-checks-passed` | block」，并加对应的 harness 合同（`cm` 行）；`scripts/inspect-ci-workflow.js` 若解析 job 清单则同步。
  验证：`make test-guardrails` 全绿，且 2a.1 的每条被拒项现在是 PASS；去掉新 job 的 `needs` 项或把 `runs-on` 改回 `ubuntu-latest` 时 harness 判红（两条变异做后撤销）。
- [ ] 2a.5 规格随刀：omp-uid-isolation「CI uid-isolation job」delta（九 → 十）与 office-preview「真实转换的人工验证」场景「CI 端到端」由归档合入；本任务核对 job 名、`needs` 与两处措辞一致。
- [ ] 2a.6 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；十个 job 绿，贴 `office-sidecar` 的 job 链接与脚本输出里「0 次请求 / 对照 ≥ 1 次」两行；PR 标题与正文都标「CI 改动」（owner 已于 2026-10-17 批准，B10）；请求白盒审查（design D13 S2a 清单）。
Suggested fixture level: compact - 不改产品代码；新增一个 CI job、一个脚本与合同同步；行为由规格 delta、合同行与 job 输出钉住。
Minimal mergeable slice: atomic - 新 job、`needs`、harness 合同与 AGENTS 行互为前提（少任一项 `make test-guardrails` 或聚合门禁之一必红）。

## 2b. S2b — 测试主机实测（office-preview「转换隔离边界」「真实转换的人工验证」）

- [ ] 2b.1 开工核对：S1a、S1b 已合入；重读 design D11 (a)–(f) 与 system.md 9.7 草稿（S3 尚未合入时按 design Migration Plan 的五步部署）；主机上备好 `pdfinfo` / `pdftotext`（poppler-utils）；备好 2026-10-12 的带 http 图片 docx、带 `file://` 图片的 docx / pptx、含中文正文的 docx / xlsx / pptx、归档 D17 那种约 25 s 的文档，以及六份 fail-closed 用的**未缓存的新文档**（① 两份、② 两份、③、④ 各一份），另加一份在可用形态下先经 `/o/` 预览过一次的**已缓存对照文档**（缓存命中只在 `available=true` 时生效：运行期停掉 sidecar 时它仍 200，预检失败后它也 503——`preview/app.ts:262-264`、`office-cache.ts:159`）。
- [ ] 2b.2 两种部署形态各一次（app 裸机 + sidecar 容器；app 容器 + sidecar 容器），`OMP_USER` 两种模式各起一次 app：按 design D11 (a)–(e) 执行并记录；(b′)「两种 uid 模式转换链相同」四项核对：两种模式转出的 PDF `pdfinfo` 页数相同、`pdftotext` 输出 `diff` 为空、`grep -a -c '/Subtype */Image'` 相同；`stat -c %U` 看 spool 作业目录与 `pdf/` 输出属应用用户；app 进程树（`pstree -p <app>`）里没有 `sudo`；`OMP_USER` 模式下 `ps -u <omp 用户>` 没有 `soffice`；(c) 终止链重复 5 次，另加**一次客户端断开**（请求 25 s 文档后 2 s 关闭连接）看同样的三个时刻；(d) fail-closed 按 design D11 (d) 的五步顺序执行并数 stderr 行数——**每个「停掉 sidecar」之后等 ≥ 10 s（心跳过期）再动作，「新文档」每次都是一份新的未缓存文档**：⓪ `start converter`、等 `heartbeat` 新鲜、启动 app（可用形态）→ 令牌 `true`、无行；① app 在跑时 stop → ≥ 10 s → 已缓存文档 200、新文档 503 + 恰一行、第二份新文档 503 + 无新行、令牌仍 `officeAvailable=true`；② 同一 app 进程里 start → 等 `heartbeat` 新鲜（≤ 2 s）→ 新文档 200、无新行 → 再 stop → ≥ 10 s → 新文档 503 + 恰再一行、已缓存文档仍 200；③ sidecar 仍停着（距 ② 的 stop 已 ≥ 10 s）→ 重启 app → 启动时恰一行 + `officeAvailable=false`，已缓存文档与新文档**都** 503、无新行；④ start → 等 `heartbeat` 新鲜 → 重启 app（可用形态）→ 无行、`officeAvailable=true`，已缓存文档与新文档都 200；变异列两条（`network_mode: host` 重跑 http 例 → 应命中——不用 `bridge`，容器内 `127.0.0.1` 打不到宿主监听器；挂入输入所在目录重跑 `file://` 例 → 应有图），做后撤销。
- [ ] 2b.3 结果表（design D11 (f)：内核、Docker、镜像基底与 LibreOffice 版本、(b)–(e) 各项、变异列；每行带证据等级；宿主不留文件；被跟踪文本只称「测试主机」）贴进 S3 的 PR 正文（S2a 若在做则同时链接到那里）。
  **两种结果**：(1) 全绿 → S3 按此写 ADR，D-25 残余按 (c) 的观察改写；(2) (b) 任一例有命中 / 有图、xlsx / pptx / 中文转不出 → **停下报告**，镜像配方回 design D7（不在实现 PR 里自行加包）；(d) 任一步的任一期望不成立 → S1b 缺陷，回 S1b。
Suggested fixture level: none - 不改任何文件；一次手工实测，结果进 S3 的文档。
Minimal mergeable slice: atomic - 没有 PR；实测项互为对照（http 例与对照、`file://` 例与变异、两种形态），拆开任一项结论都不完整。

## 3. S3 — 文档终态、ADR-0010 补充、验收行、关闭 issue（docs only）

- [ ] 3.1 开工核对：重读 `docs/adr/0010-dedicated-omp-uid.md:222-288`；`docs/adr/0014-isolated-preview-origin.md:31-37`、`:61-74`、`:104-133`、`:150-171`、`:185-223`；`docs/architecture/system.md:378-396`（9.6 是末节）；`docs/acceptance/functional-checklist.md:241-243`、`:254`；`CONTEXT.md:25`；`IMPLEMENTATION_PLAN.md:334-335`、`:342`、`:463`；`server/src/preview/app.ts:10`、`:34-52`、`:84-88`、`office.ts:1-16`、`office-cache.ts:1-45`（S1b 已改写的部分核对措辞）；S2b 的结果表。行号有出入先改 design。
- [ ] 3.2 ADR-0010：2026-10-12 补充（`:222-288`）节首加头注「2026-10-17 起退役（#1350，change `office-convert-sandbox`）：办公文档转换不再以 omp 用户、不再经 sudo；两行 sudoers 规则删除；下文保留为历史」；新一节「2026-10-17 补充：#1350 办公文档转换移入 `--network none` 的 sidecar」——B1–B10 的裁定（含 B8 细节）与两轮 bwrap 实测为何否决（背景）、spool 协议一段、身份（同 uid、无 sudo）、退役清单、预检 / fail-closed / 排障、B1 向量「未测、视为跟随，按构造覆盖（读手册推出）」、**同一 sidecar 内并发作业共享 fs / ipc / uid 的残余**（design D12 的措辞，读代码推出）、D-25 残余按 S2b (c) 改写、S2b 结果表；每条结论带证据等级。
- [ ] 3.3 ADR-0014：决定 6（`:31-37`）加「转换在 sidecar 容器里，app 不运行 LibreOffice」；已知残余表（`:61-74`）#1350 两行改为「已缓解（sidecar，`network_mode: none`、只挂 spool）：链接资源不再被取回（测试主机实测，S2b 结果表）；数据类向量未测、按构造覆盖」、`soffice.bin` 行按 S2b、**新增一行「同一 sidecar 内并发作业共享 fs / ipc / uid：作业间隔离只靠 128 位随机作业 id；LibreOffice 代码执行漏洞下另一在途作业的输入 / 输出可读可伪造（读代码推出，未测）」**；「LibreOffice 与 `OFFICE_BIN`」节（`:104-113`）改为「转换 sidecar 与 `OFFICE_SPOOL_DIR`」（两种部署形态步骤、`WORKBUDDY_UID/GID`、`CONVERTER_CONCURRENCY ≥ OFFICE_CONVERT_CONCURRENCY`、镜像由部署方自建（owner B9）、sudoers 两行删除）；「十二个环境变量」表（`:114-133`）`OFFICE_BIN` 行换成 `OFFICE_SPOOL_DIR`；`:157` 与「被终止的转换留下的进程」（`:161-171`）按 S2b 改写；「真实转换的验证记录」（`:185-223`）节首加「2026-10-12 的记录，对应 sidecar 之前的转换链」头注，不删。
- [ ] 3.4 system.md §9 新小节「9.7 办公文档转换的 sidecar 容器（#1350，change `office-convert-sandbox`）」：Docker 前提；裸机形态与容器形态各自的步骤（Migration Plan 1–3）；`office_convert_sidecar_unavailable` 的排障（`docker compose ps`、`heartbeat` 年龄与属主、spool 属主与 mode、`CONVERTER_*`）；fail-closed 的用户可见表现（503 固定页、令牌 `officeAvailable`、sidecar 死在作业中途是 504；运行期 sidecar 宕机时已缓存文档照常 200，启动预检失败后已缓存文档同样 503）；`OFFICE_BIN` 升级提示（owner B8 与细节：旧键还在时 app 启动失败，stderr 只有 `server_start_failed` / `reason:"config"`、不点名该键，所以本节写明「升级后启动失败、`reason` 为 `config` 时先查 `OFFICE_BIN` 是否已去掉」）。
- [ ] 3.5 头注释：`preview/app.ts:34-52` ① 段改为「输入侧：转换在 `--network none`、只挂 spool 的 sidecar 容器里进行，app 只把输入的字节经 `openRegularFile` 复制进作业目录——`lstat` 之后换入成符号链接 → `failed`（与 `/w/` 同守末段）；文档引用的资源：网络不存在、本地文件不在容器里（测试主机实测：http 图 0 请求、`file://` 图不进 PDF；数据类向量未测、按构造覆盖）；同一 sidecar 内并发作业共享 fs / ipc / uid，作业间只靠 128 位随机作业 id 隔离；LibreOffice 代码执行漏洞下另一在途作业的输入 / 输出可读可伪造（读代码推出，未测）」；`app.ts:10`（「入口已清空 `work/`」→ `jobs/`）与 `:84-88`（`officeReady` 文档里的 `work/`）两处注释改写；`office.ts:1-16` 与 `office-cache.ts:1-45` 核对 S1b 的措辞与 S2b 一致（D-25 段按观察）；`server.ts:575-579` 同。
  验证：`app.ts` ≤ 330（净零或净减）、`office.ts` ≤ 330、`office-cache.ts` ≤ 230；`npm test --workspace server` 全绿（只改注释）。
- [ ] 3.6 验收清单：FL-25 / FL-26 / FL-27 的 `OFFICE_BIN` 改为 `OFFICE_SPOOL_DIR`（含「由启动服务的人启动 / 停掉 sidecar 容器」的操作措辞）；新增 `FL-39`——操作：「由启动服务的人确认 sidecar 容器在跑（`docker compose ps` 为 healthy）且服务 stderr 没有 `office_convert_sidecar_unavailable`；由有服务器访问权的人在**服务器上、工作空间之外**放一张图片，并在服务器上起一个记录请求的本机监听器（如 `python3 -m http.server`，服务器自己能访问的地址）；在本机备一个 fl-link.docx（正文里插入一张『链接到文件』而不是嵌入的图片，链接指向服务器上那张图；另插入一张链接到该监听器地址的 http 图片）；经「+」菜单上传后在文件页点它」——预期：「浏览器自带的 PDF 查看器里显示转换出的文档，两张链接图片的位置是空白或占位框，没有图片内容；其余文字可辨认；**监听器的访问日志里没有任何请求**」，结论 `待签`。
- [ ] 3.7 `CONTEXT.md:25` 术语里的 `OFFICE_BIN` 改为 `OFFICE_SPOOL_DIR` 并加一句「转换在 sidecar 容器里」；`IMPLEMENTATION_PLAN.md:334-335`、`:342`、`:463` 同步键名与部署要求（Docker + sidecar）。
- [ ] 3.8 规格核对：归档后主规格（office-preview 五条新 requirement 与三条 MODIFIED、http-service-skeleton 两条、preview-origin、omp-uid-isolation）与 ADR / system.md / 头注释对同一事实说同一种话；D-25 与 B1 的措辞不强于证据；并发作业残余的句子四处（design D12 列的 Risks、ADR-0010 补充、ADR-0014 残余表、`app.ts` 头注释）一致。
- [ ] 3.9 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；PR 贴 design D13 S3 清单请轻量复核；合并后关闭 #1350，关闭评论引用本 change 的归档路径、S1a / S1b / S2a / S3 的 PR 号与 S2b 结果表。
Suggested fixture level: none - 只改文档、ADR、头注释与验收行，无运行时行为。
Minimal mergeable slice: atomic - 一次文档终态更新；拆开会让 ADR 与头注释在一段时间内对同一事实说两种话。
