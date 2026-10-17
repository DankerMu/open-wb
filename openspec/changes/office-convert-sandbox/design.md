# Design: office-convert-sandbox

> **状态（2026-10-17）**：owner B7 裁定**单机制 sidecar**——办公文档转换移出 app 进程，由一个长驻、`--network none`、只挂 spool 卷的转换容器承接；bubblewrap 整体不进本 change（两轮实测见 Context，只作背景）。本文是定稿：D1–D14 全部已决，「待编排方确认」里只剩实现层的默认值。

## Context

owner 裁定见「owner 的裁定」表（grill ledger B1–B7）。本节记设计依赖的现状（读代码，`4bac35cc`——`sandbox-boundary-closure` 已归档合入，2026-10-17）与测试主机的实测。证据等级逐条标注：「实测」= 在测试主机上跑过并观察到；「读代码推出」= 未跑；「读手册推出」= 依据 Docker / LibreOffice / Node 文档，未在本仓库场景下验证。

**今天的转换链（将被整体替换）**

- `server/src/preview/office.ts`（332 行）：`createOfficeConverter({officeBin, cacheDir, timeoutMs, ompUser?, spawn?})`（`:51-61`）返回 `{available, convert(absInput, signal?), close()}`（`:63-69`）。每次转换在 `<cacheDir>/work/<随机名>`（`2770`，`:26`、`:287-289`）里 spawn `soffice`：argv 与环境只在 `buildLaunch`（`:87-119`）拼，`ompUser` 存在时前缀 `sudo -n -u <omp> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL --`（`:116-118`）；spawn 选项 `:226-232`；`terminate`（`:127-146`）同 uid 杀进程组、`ompUser` 只杀 `sudo`；`collectOutput`（`:158-200`）以 `O_NOFOLLOW` 打开 `<job>/out/<去扩展名>.pdf`、`fstat` 取 `size`、恰复制 `size` 字节进 `pdf/<随机名>.pdf`（`0600`、`wx`）、上限 200 MiB（`:29`）——**这段复制纪律与 `OfficeConvertError` 五种 kind（`:31`）、`convert` 的检查次序（`:270-286`）在新链里原样保留**；`runOne`（`:270-302`）、`removeJob`（`:201-207`）。头注释 `:1-16` 写着 D-25 残余。
- `server/src/preview/office-cache.ts`（326 行）：缓存键 `officeCacheKey`（`:71-76`，`lstat` 的 mtime/size）、命中 `touchIfCached`（`:82-95`）、`createOfficeCache`（`:101-173`，排队经 `office-queue.ts`）——**不变**。`createOfficeCleanup`（`:193-326`）：`clearWork` 在 `ompUser` 与 `officeBin` 同时存在时先 `sudo -n -u <omp> -- /usr/bin/find <work> -mindepth 1 -delete`（`:234-283`，10 s 时限、`SIGTERM`→`SIGKILL`、`stopWorkClear`），失败记 `preview_work_clear_failed`（`:293`）；`removeOwnEntries`（`:176-191`）；`sweepPdf`（`:304-324`）——**`sudo … find` 整段退役**（D6），`sweepPdf` 不变。头注释 `:14-44` 写着 `sudo … find` 与 `rmSync` 的残余。
- `server/src/preview/office-queue.ts`（194 行）：并发上限与排队——不变。
- `server/src/preview-config.ts`（153 行）：十二个预览键；`officeBin`（`:38-39`、`:63`、`:73`）与 `resolveOfficeBin`（`:144-153`，绝对路径、错误 message `OFFICE_BIN must be an absolute path`）。头注释 `:2`「十二个」。
- `server/src/server.ts`（726 行）：`writeRecord` 的记录联合类型含 `preview_work_clear_failed`（`:200`）；`officeOf(config)`（`:207-227`）同步构造转换器与清理对象，`identity` 带 `officeBin` / `ompUser`（`:215-219`）；`app` 阶段 `:435` 调它、`:438-442` 把 `office.converter.available` 作为**布尔快照**传进 `appAssemblyOf` → `rest-preview-token.ts:33`、`:97`；`StartupStage` `:296-307`；`emitStderrRecord` `:336-343`，一键记录先例 `emitSandboxRootUnchanged` `:331-333`；`listen` `:460`；`:474` 起主 listen 之后的无 `await` 不变量；`preparePreviewCache`（`:580-586`）建 `cacheDir`（`2750`）、`work`（`2770`）、`pdf`（`0700`）并 `await cleanup.clearWork()`；头注释 `:575-579`。
- `server/src/preview/app.ts`（330 行）：`/o/` 的 `locate`（`:196-230`）只 `lstat` 输入、把 `absPath` 交给 `convert`（`:284`、`:304`）——**今天路由不打开输入的 fd**，它打开的是转出的 PDF（`:314-321`）；`refusalOf`（`:253-266`）第三项 `!converter.available` → 503 `UNAVAILABLE_TEXT`「服务器未启用文档转换，请下载后查看」（`:100`）；`convertFailure`（`:125-`）把 `unavailable` 映射到同一 503——所以运行期转换器返回 `unavailable` 也落到固定页，路由不改。头注释 `:34-52` 是 #1350 的现状陈述（B5 的落点）。`server/src/workspaces/regular-file.ts`（68 行）`openRegularFile(absPath)`（`:40-68`）：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开 + `fstat` 判普通文件，返回 `{fd, size}`——新转换器以它打开输入（D4）。
- `server/src/core/process-path.ts`（32 行）：`assertSafeSudoPath` / `assertSetprivExecutable` / `SETPRIV_PATH`——omp 仍用，转换不再用（`office.ts:23` 的 import 删除）。

**测试与夹具（既有接缝）**

- `server/test/fixtures/fake-soffice.mjs`（152 行）：按 `--outdir` 的上一级找作业目录（`:30-36`），行为由最后一项 argv 文件名里的 `@标记` 决定（`:38`），记录到 `<作业目录的上一级>/<作业目录名>.record.json`（`:40-46`）。sidecar 在 `jobs/<id>/` 里以 `--outdir jobs/<id>/out` 启动它 → 记录落在 `jobs/<id>.record.json`——**不改即可复用**（D8）。
- `server/test/fixtures/fake-sudo-find.mjs`（76 行）：只为 `sudo … find` 存在——**退役**。
- `server/test/office-converter.test.ts`（**795 行**）：`stage()` `:135-178`、`converterFor` `:180-192`、`contractArgs` `:200-215`、`sudoPrefix` `:217-229`，断言钉的是 spawn argv、`detached`、`sudo` 形状、`officeBin` 不存在 → 无 pid、超时杀进程组、`OMP_USER` 终止 `sudo`（`:355-367`、`:447-477`、`:551-582`、`:696-732`、`:776-793`）——**绝大多数钉住的是被删除的行为**（D9 表）；输出复制纪律的用例（`office-converter-output.test.ts`，189 行）钉的是保留的行为。
- `server/test/office-work-clear.test.ts`（496 行）：全部关于 `sudo … find`——**退役**。
- `server/test/office-queue.test.ts`（603 行）、`office-cache.test.ts`（462 行）、`office-cache-helpers.ts`（160 行）：构造转换器时传 `officeBin: FAKE_SOFFICE`（`office-queue.test.ts:72-90`、`:220-249`；`office-cache.test.ts:62-70`、`:335-384` `standIn`）；`office-queue.test.ts:220-249` 把 `sudo` 链到假 `soffice` 并断言 `commands toEqual(["sudo","sudo"])`、派生子进程不随之结束（`:241` 注释「D-25 残余的同 uid 等价物」）。
- `server/test/server-startup-office.test.ts`（434 行）：`describe` `:104`（`OFFICE_BIN` 指向假 `soffice` `:109`、`:189`；`:229` 未配置 → `officeAvailable=false`）；`describe` `:274`「以 omp 用户清空 work/」（`:313-337` 入口把 `sudo` 链到 `fake-sudo-find`；`:339`、`:403` 两例）——**第二个 `describe` 整体退役**。
- `server/test/preview-config.test.ts`（271 行）：`FIELDS` 十二项（`:34-45`）、`toHaveLength(12)`（`:195`）、`OFFICE_BIN` 非法值（`:89-90`、`:120-121`）、「十二」字样（`:2`、`:4`、`:34`、`:128`、`:157`、`:176`、`:186`）。`server/test/omp-max-processes-config.test.ts:302-303`（`["OFFICE_BIN",""]`、`["OFFICE_BIN","soffice"]` 在一张非法值表里）——**办公文档套件之外的命中**。
- `server/test/preview-office-route*.test.ts`（651 + 251 行）：转换器替身；「传给替身的输入是该文件在工作空间内的绝对路径」（office-preview「办公文档预览路由」场景「成功与缓存」）——D4 让转换器自己打开输入，所以**不改**。
- `server/test/support/setpriv.ts`：omp 用，不改。`server/test/linux/uid-isolation.test.ts`：没有办公文档断言。

**CI、守卫与工具面**

- `.github/workflows/ci.yml`：九个 direct job 全部 `runs-on: ubuntu-latest`；`all-checks-passed.needs` 逐字列出九个（`:158-160`）；`fast-checks` 的 `npx biome check server web scripts`（`:18`）。GitHub 注记：`ubuntu-latest` 自 2026-10-19 起为 Ubuntu 26。
- `scripts/test-ci-harness.sh`（≈ 500 行）：`check_wf` 把聚合 job 的 `needs` 列表、`runs-on`、`if: always()` 等作为字面合同（`:118`，`aggregate = (... ("needs", "[fast-checks, …, uid-isolation]"), ("runs-on", "ubuntu-latest") …)`）；逐 job 的 `runs-on` / `if` / `continue-on-error` / `timeout-minutes` 变异合同（`:182-197`）；`constraints.yaml:106` `ci.matrix: ["ubuntu-latest"]`；AGENTS.md Enforcement Index 行有合同（`:156-157`）。`scripts/inspect-ci-workflow.js` 是 knip 的根入口。**往 ci.yml 加一个 job、或改任何既有 job 的任何键，都要同步这份合同**——第一步是把 job 的桩放进去跑 `make test-guardrails`，让合同自己列出被拒的项（D10）。
- `omp-uid-isolation` 规格 `:99-112`「CI uid-isolation job」：三行 sudoers 规则（假 omp、真 omp、`/usr/bin/env`），**没有任何办公文档规则**——uid-isolation job 不被本 change 触碰；场景「job 全绿并入聚合」`:103`「`all-checks-passed.needs` 含九个 direct job」是新 job 唯一碰到的句子。
- 守卫覆盖面：`biome.json` `files.includes` 为 `server/**`、`web/**`、`scripts/**`、`vitest.shared.mjs`（`:4-11`）；`Makefile` `lint` 与 ci `fast-checks` 都是 `biome check server web scripts`；`scripts/size-guard.sh` 只扫 `server/src server/test web/src web/test kbservice/src kbservice/tests` 下的 `.ts/.tsx/.py`（`:12-13`、`:22`）；`.jscpd.json` pattern `{server,web,kbservice}/**`；`knip.json` 只有 `.`、`server`、`web` 三个 workspace；根 `package.json` workspaces `["server","web"]`；`scripts/test-guardrails.sh:45-63` 对 size-guard 的自证只用临时 `.py` 探针。**`converter/` 今天在每一个守卫之外**（D7）。
- 仓库没有任何 Dockerfile / compose 文件，也没有任何二进制测试夹具（`git ls-files` 全部是文本）。

**规格与文档里将变假的句子**

- `openspec/specs/office-preview/spec.md`：「转换器调用契约」`:8-61` 整条（构造签名、argv、sudo 前缀、两行 sudoers、两种终止、D-25 残余、9 个场景里 8 个钉 spawn 形状）；「并发上限与排队」`:63`（残留后代一句）；「转换缓存」`:78`（`work` 2770）、`:82`（整段 `sudo … find` 与 `preview_work_clear_failed`）、场景 `:96-103`（两例 `sudo`）；「真实转换的人工验证」`:141`（「CI 与单元测试 SHALL NOT 依赖 LibreOffice」仍对，但 `OMP_USER` 模式的 uid、残留进程、两行 sudoers 的记录项全部过期）。
- `openspec/specs/http-service-skeleton/spec.md`：`:9`（`OMP_USER`…「共三十五项」清单不变）、`:11`（`OFFICE_BIN` 的解析规则）、`:15`（成功顺序句）、`:98-99`、`:102`（`OFFICE_BIN` 的两个场景）、`:310`（建 `work` 2770、`sudo … find`、`preview_work_clear_failed`）、`:314`（关停首步「终止启动时那次对 work 的清空」）、`:318`（THEN「`work` 为 `2770`」）、`:328`（「`OMP_USER` 模式下 `sudo` 进程已不存在」）。
- `openspec/specs/preview-origin/spec.md:28`（`officeAvailable` 当且仅当配置了 `OFFICE_BIN`）、`:35-36`。
- `openspec/specs/omp-uid-isolation/spec.md:103`（九个 direct job）。
- `docs/adr/0010-dedicated-omp-uid.md:222-288`（2026-10-12 补充：身份、两行 sudoers、残余——整节成为历史，需加「2026-10-17 起已退役」的头注与新补充）；`docs/adr/0014-isolated-preview-origin.md:31-37`（决定 6）、`:61-74`（已知残余表）、`:104-113`（「LibreOffice 与 `OFFICE_BIN`」）、`:114-133`（十二个环境变量表）、`:157`、`:161-171`（被终止的转换留下的进程）、`:185-223`（真实转换验证记录——历史，保留并加头注）；`docs/architecture/system.md` §9 最后一小节是 9.6（`:378-396`），没有办公文档的部署说明；`docs/acceptance/functional-checklist.md:241-243`（FL-25/26/27 写着 `OFFICE_BIN`）、`:254`（末行 FL-38）；`CONTEXT.md:25`（术语「隔离预览来源」提到 `OFFICE_BIN`）；`IMPLEMENTATION_PLAN.md:334-335`、`:342`、`:463`；源码头注释 `server/src/preview/app.ts:34-52`、`office.ts:1-16`、`office-cache.ts:1-45`、`server.ts:575-579`。归档 `openspec/changes/archive/2026-10-12-s1f-files-page/design.md` D17/D18/D22——不改（B5）。

**实测，第一轮（2026-10-16，测试主机；bubblewrap——背景，不是选项）**

| # | 环境 | 观察 | 证据 |
|---|---|---|---|
| 1 | 一次性 `ubuntu:24.04` 容器，docker 缺省 flags；宿主 `apparmor_restrict_unprivileged_userns=1` | 非特权用户 `bwrap --unshare-all` → `No permissions to create new namespace`；六个带 bwrap 的转换全部 rc=1 | 实测 |
| 2 | 同上，**对照：不加任何边界**，按 `office.ts` 的真实 argv 与环境转换带 http 图片的文档 | rc=0，本机监听器 3 次命中，PDF 含 1 张图 | 实测；与 issue 2026-10-12 表一致。**「不加边界时链接资源被取回」的有效证据**（裸机对照因包装脚本 `cd $HOME` 失败而无效，不引用） |
| 3 | 容器 root + `--cap-add SYS_ADMIN` + seccomp/AppArmor unconfined | `Can't mount proc on /newroot/proc` | 实测 |
| 4 | **裸机**，没有 bwrap 的 AppArmor profile | `loopback: Failed RTM_NEWADDR` / `setting up uid map: Permission denied` | 实测 |
| 5 | 裸机，装 `apparmor-profiles` 并载入 `bwrap-userns-restrict` | 非特权用户 bwrap 可用；三个 HTML 输入转换 rc=0、0.9 s、http 图 0 命中 0 图、`file://` 外部图 0 图；`sudo → setpriv → bwrap → soffice.bin` 链被杀后无存活（一次） | 实测。bwrap **只在裸机 + AppArmor profile 前提下可用**——B6 否决了「只支持裸机」 |

**实测，第二轮（2026-10-16，测试主机；两种容器内机制）**

| # | 机制 | 做法 | 观察 | 证据 |
|---|---|---|---|---|
| 6 | setuid-root bwrap（`dpkg-statoverride 4755`）在容器里 | 五个特权档：无 flags、`SYS_ADMIN`、+ AppArmor unconfined、+ seccomp/systempaths unconfined、`SYS_ADMIN+NET_ADMIN`（含 caps-only、`--proc` 两种写法） | **全部** `bwrap: capset failed: Operation not permitted`；每档的无 bwrap 对照都取回 http 图（3 命中 1 图） | 实测。根因未隔离、不再追 |
| 7 | **`--network none` 的转换 sidecar 容器**：`ubuntu:24.04` + `libreoffice-writer-nogui` 24.2.7，非 root 固定 uid，`--read-only --tmpfs /tmp`，只把作业目录挂到 `/job`，`HOME=/job`，`soffice --headless … -env:UserInstallation=file:///job/profile --convert-to pdf --outdir /job/out /job/<输入>` | 对照 `--network host`：rc=0、2.3 s（冷）、监听器 3 命中、PDF 1 图。`--network none`：带 http 图 → rc=0、PDF、**0 命中、0 图**；`file://` 外部图（宿主上存在、未挂载）→ PDF、**0 图**；第二次（profile 已热）1.0 s | 实测（`round2-sidecar.log`）。**隔离由 Docker 构造给出：没有网络接口、只有 `/job` 可见；不需要 bwrap、userns、宿主 AppArmor 前提、任何容器特权** |
| 8 | 同上，副作用 | 输出 PDF、`profile`、`.cache` 属 sidecar 的 uid，宿主用户 `rm` 得到 `Permission denied`，要 root 才删得掉 | 实测。→ D6 的 uid 对齐是必答题 |

**没有实测的**（进 Risks / D11 (b)）：sidecar 里转换 xlsx / pptx（只装了 writer-nogui；输入都是 HTML——对照里 writer-web 过滤器跟随了链接，向量等价，但真 docx 带 http 图片在 sidecar 里没有跑过）；以**不在镜像 `/etc/passwd` 里的 uid** 运行 LibreOffice（第二轮的 uid 是 `useradd` 建的）；`node:24-bookworm-slim` 基底 + Debian 的 LibreOffice 包（第二轮是 `ubuntu:24.04`）；DejaVu 之外的字体、CJK 字体；并发；归档 D17 的约 25 s / 133 s 文档；sidecar 内杀进程组后的存活；经 `/o/` 与产品代码的端到端；spool 协议本身（本 change 新造）；GitHub `ubuntu-24.04` runner 上的 docker 构建与 `--network none`。

**文件行数**（800 行硬上限，`scripts/size-guard.sh`）：`office.ts` 332、`office-cache.ts` 326、`office-queue.ts` 194、`preview/app.ts` 330、`server.ts` 726、`preview-config.ts` 153、`regular-file.ts` 68；测试 `office-converter.test.ts` **795**、`office-converter-output.test.ts` 189、`office-queue.test.ts` 603、`office-cache.test.ts` 462、`office-cache-helpers.ts` 160、`office-work-clear.test.ts` 496、`server-startup-office.test.ts` 434、`preview-config.test.ts` 271、`fake-soffice.mjs` 152、`fake-sudo-find.mjs` 76。预算表见文末。

## Goals / Non-Goals

**Goals**

- 每次办公文档转换都在一个 app 进程之外、**没有网络、只看得见本次作业目录**的转换容器（sidecar）里运行：`SANDBOX_ROOT`、工作空间路径、状态目录、数据库、其它作业对它不存在；app 与 sidecar 之间只经 spool 目录交接**字节**与一个小 JSON，不经 docker socket、不给任何容器特权。
- 裸机与容器部署同一形态：都跑这个 sidecar 容器（Docker 成为办公文档预览的部署前提）。
- sidecar 不在 / 不健康就不转换：启动预检与每次转换前的心跳检查失败 → `/o/` 答既有 503 固定页、令牌 `officeAvailable=false`、stderr 一行 `office_convert_sidecar_unavailable`；绝不回退为 app 进程内的 `soffice`。
- `sudo → setpriv → soffice` 链与两行办公文档 sudoers 规则从转换路径上**退役**；`OMP_USER` 不再影响办公文档转换；D-25 残余（`soffice.bin` 存活）随链消失。
- 终止（超时、断开、关停）结束 sidecar 里本次作业的全部进程。
- 单元与编译入口测试不需要 Docker、LibreOffice：app 侧对着进程内的假 sidecar（临时 spool 目录的应答器），sidecar 脚本对着既有的假 `soffice`；真实端到端（含 http 外链 0 请求对照）在 CI 的新 job 或测试主机做一次。
- 既有行为不变：缓存键与命中、排队与并发上限、超时与失败文案、输出复制纪律与 200 MiB 上界、`/o/` 路由的次序与文案。

**Non-Goals**

- bubblewrap、userns、seccomp、任何第二种机制（B7：bwrap 不进本 change；两轮实测只作背景）。
- 实测 B1 的数据类向量或为此造文档（B1：登记「未测、视为跟随」，由构造覆盖）。
- 办公文档转换之外任何进程的网络隔离（omp、kb-service）；给 omp 自身加沙箱。
- app 自身的容器化、compose 里 app 服务的定义、反向代理——本 change 只给出 sidecar 服务与 app 的接线要求。
- 非 Debian 基底的 sidecar 镜像配方；多架构镜像；镜像仓库发布（镜像由部署方按 `converter/Dockerfile` 自建，owner 2026-10-17）。
- sidecar 的多实例 / 跨主机部署；spool 之外的任何 RPC（unix socket、HTTP）。
- `/o/` 输入侧「`lstat` 之后换入」竞态的全闭合：D4 以 `openRegularFile`（末段 `O_NOFOLLOW` + `fstat`）把它收窄到与 `/w/` 相同的「只守末段」（regular-file.ts 头注释的书面残余），不闭合中间目录被换成符号链接的情形。
- 转换结果的总量上限、缓存策略的任何改变。

## Decisions

### owner 的裁定（已定，不是选项）

| # | 裁定 | 日期 | 落点 |
|---|---|---|---|
| B1 | 数据类向量登记为「未测、视为跟随」；不绕过安全分类器去造这些文档；不以「未测」为由推迟缓解 | 2026-10-13 Q5 | D12、Risks、Non-Goals；ADR-0010 补充（S3） |
| B2 | 缓解手段 = 无网络 + 只看得见输入与作业目录的隔离边界（原文「bubblewrap」，B7 改为 sidecar 实现同一边界）；先在测试主机实测 | 2026-10-13 Q6 / 2026-10-16 | D1、D2、D11；office-preview「转换隔离边界」ADDED |
| B3 | 部署镜像一律带边界工具；运行时边界不存在或起不来 → fail-closed：拒绝办公文档预览、不回退到裸 `soffice`，文档写明。编排方默认：复用 503 固定页 + 启动预检 + 一行 stderr | 2026-10-13 Q7 → 编排方 | D5；office-preview「转换 sidecar 的健康与 fail-closed」ADDED；preview-origin「预览令牌签发端点」MODIFIED |
| B4 | 走完整 stage-change-pipeline；一个 change | 2026-10-13 Q11 | proposal「流程记录」 |
| B5 | 结果写进本 change 的 design（引用归档 D22）与 `preview/app.ts` 头注释，归档件不改；ADR-0010 的 sudoers 行随之改（B7 之下：退役） | 2026-10-16 | Context、D11；tasks S3 |
| B6 | 边界必须在 app 以 Docker 容器部署时也可用；「裸机 + AppArmor profile 前提」被否决为唯一形态 | 2026-10-16 | D1、D6、Migration Plan |
| B7 | **sidecar 单机制**：长驻 `--network none` 的转换容器（compose 服务），经共享卷 spool 目录交接作业；不要 docker socket、不要任何容器特权；裸机部署同样跑这个容器（要求有 Docker）；sidecar 不在 / 不健康 → fail-closed。bwrap 不进本 change。`OMP_USER` 的 `sudo→setpriv→soffice` 链不再用于转换。镜像由我们自己做 | 2026-10-17 | D1、D3–D7、D10、Migration Plan；office-preview 两条 REMOVED + 两条 ADDED |

编排方默认（sidecar 协议；本设计核对后的采用情况写在各 D 里）：spool 目录 `OFFICE_SPOOL_DIR`（采用，D3）；每作业 `jobs/<id>/`、输入**字节**从已打开的 fd 复制、`request.json`、原子 rename 的标记（采用；标记形状见 D3）；sidecar 轮询 ≤ 200 ms（采用 200 ms 固定；不用 inotify，D7）；逐作业独立 `UserInstallation`（采用）；作业内自己的超时与 kill（采用，D7）；app 等 `done` / `failed` / 超时、取 PDF 进既有缓存、删作业目录（采用，D4）；健康 = `heartbeat` 文件 mtime 新鲜 < 10 s（采用；启动预检加 5 s 有界等待，D5）；sidecar 代码 = 仓库内小 Node 脚本 `converter/`、镜像 `node:24-bookworm-slim` + LibreOffice 三件 nogui + fonts、非 root、`--read-only`、只挂 spool（采用，D7；uid 由部署方以 `user:` 对齐，D6）；app 侧用临时目录假 sidecar、sidecar 脚本用 `fake-soffice.mjs`（采用，D8）；真实端到端在 CI 新 job（`ubuntu-24.04`）——CI 改动需 owner 确认，否则退回测试主机手工实测（采用，D10）。与默认不同的：spool 目录 `0700` + 同一数值 uid/gid，不用 `2770` + 共享组（D6，理由在那里）。

### 起草者的技术决定

**D1 机制 = sidecar（B2、B6、B7）。** 办公文档转换从 app 进程移到一个长驻的转换容器：`converter/sidecar.mjs` 在容器里轮询 spool 的 `jobs/`，对每个就绪作业以容器自己的 LibreOffice 转换，结果写回同一作业目录。隔离由 Docker 构造给出（实测第 7 行）：`network_mode: none` 使转换进程没有任何网络接口（含回环之外的一切；回环上也没有 app 的监听器，因为那是另一个网络命名空间）；容器根文件系统只读、`/tmp` 是 tmpfs、唯一挂载是 spool 卷——`SANDBOX_ROOT`、状态目录、数据库、app 的任何路径对 sidecar 不存在，连路径字符串都不进 spool（D3）。不用 bwrap 的理由是实测：裸机需要 AppArmor profile（第 5 行），容器里非特权与 setuid 两种在五个特权档全部起不来（第 1、3、6 行）。不用 docker socket / `docker run` 每作业的理由：那是比 setuid bwrap 更大的提权面，owner B7 明令排除。

**D2 边界的行为契约（B2）。** 写进 office-preview 新 requirement「转换隔离边界」（本轮定稿，机制已定但句子仍写可观察行为）：

1. **网络**：转换进程及其全部后代不可达任何网络。可观察：经 `/o/` 转换带 http 链接图片的文档，该地址的监听器 0 次请求、PDF 无图；对照（同一镜像 `--network host` 直接跑 `soffice`）有请求、有图。
2. **可见文件系统**：转换进程可见的 SHALL 恰为 sidecar 镜像自己的只读根文件系统、tmpfs 的 `/tmp`，与 spool 卷；spool 里与本次转换有关的只有 `jobs/<id>/`（输入的字节副本、`request.json`、`out/`、`profile`）。**app 一侧的任何路径都不进 spool**：输入以字节复制、以其 basename 命名，`request.json` 里没有路径字段；sidecar 看不到 `SANDBOX_ROOT`、工作空间、`OMP_STATE_DIR`、数据库、`PREVIEW_CACHE_DIR`。可观察（单元）：一次转换后 `jobs/<id>/` 下恰有 `in/<basename>`、`request.json`（键恰为 `version`、`input`、`timeoutMs`）、以及 sidecar 写的东西；整个 spool 树里任何文件的内容都不含输入的绝对路径、`SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`、`OMP_STATE_DIR`（测试把这些路径都造成含哨兵段）。可观察（端到端）：引用 `file://` 外部图片的文档转出的 PDF 无图。
3. **身份**：转换进程以 sidecar 容器的 uid 运行，与 `OMP_USER` 无关——`OMP_USER` 模式与同 uid 模式的转换链完全相同，没有 `sudo`、没有 `setpriv`；部署以 compose `user:` 把该 uid/gid 对齐到 app 用户（D6），所以 spool 里的一切都属 app 用户、app 自己删得掉（实测第 8 行是不对齐时的后果）。
4. **终止**：超时、客户端断开、`close()` 时 app 写 `cancel` 标记并把结果落定；sidecar 在 ≤ 200 ms 内看到标记即对该作业的 `soffice` 进程组发 `SIGKILL`；sidecar 自己的作业超时（= `request.json` 的 `timeoutMs`）到期同样杀整组。可观察：作业目录里再无进程（`soffice.bin` 在同一进程组里，随组被杀——这是旧同 uid 模式一直有的行为，sidecar 里只有这一种模式；D-25 残余由此消失，D11 (c) 实测记录）。
5. **不变的**：`soffice` 的参数集（`--headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file://<job>/profile --convert-to pdf --outdir <job>/out <job>/in/<name>`，路径是 sidecar 视角的）、环境键集恰为 `PATH`、`HOME`（= 作业目录）与存在时的 `LANG`、`stdio` 丢弃、输出的复制纪律与 200 MiB 上界、缓存、排队、超时与失败文案。
6. **收窄而不闭合的残余**：`/o/` 的 `lstat` 之后输入末段被换成符号链接 → 转换器的 `openRegularFile` 以 `O_NOFOLLOW` 拒绝（`not_found`，与 `/w/` 相同）；中间目录被换成符号链接仍跟随（regular-file.ts 头注释的书面残余，Non-Goals）。边界里因此多出的最多是「那一个被换入的普通文件的字节」。

**D3 spool 协议（编排方默认，细化）。** 单一真相在 `converter/sidecar.mjs` 头注释与 office-preview「sidecar 转换契约」里；app 侧 `office.ts` 按它写。

- **布局**（`<spool>` = app 视角的 `OFFICE_SPOOL_DIR`，sidecar 视角恒为 `/spool`；下文相对路径两侧同形）：
  - `heartbeat`：sidecar 每 2 s `utimes` 一次的空文件（启动时以 `wx` 创建、已存在则只 touch）。新鲜 = `now − mtime < 10 000 ms`。spool 根下只有它与 `jobs/`。
  - `jobs/<id>/`：`id` 是 app 取的 32 个小写十六进制随机字符（与今天 `randomName()` 同源）。目录 `0700`。
  - `jobs/<id>/in/<name>`：输入的字节副本，`name` = `basename(absInput)`（已经过 `sandbox.resolve`，是单一路径段）；`0600`、`wx`。
  - `jobs/<id>/request.json`：`{"version":1,"input":"<name>","timeoutMs":<正整数>}`，恰这三个键，无路径、无用户名、无时间戳。**它的出现就是就绪标记**：app 先写 `request.json.part` 再 `rename`——sidecar 只认 `request.json`，看不到半截。
  - `jobs/<id>/cancel`：app 写的空文件（`wx`；已存在即无事）。sidecar 看到即杀该作业。
  - `jobs/<id>/out/<去扩展名>.pdf`：`soffice` 自己写（它建 `out/`）。
  - `jobs/<id>/done`：sidecar 在 `soffice` 以 0 退出**且**输出是大小 > 0 的普通文件之后写的空文件（`.part` + `rename`）。
  - `jobs/<id>/failed`：sidecar 写的一行原因码（`.part` + `rename`），取值封闭：`bad-request`（`request.json` 不合法 / `in/<name>` 缺席 / `name` 不是单一路径段或扩展名不在 `docx|xlsx|pptx`）、`exit`（非 0 退出）、`signal`（被 sidecar 之外的信号结束）、`timeout`（sidecar 自己的时限到期）、`cancelled`（看到 `cancel`）、`no-output`（退出 0 但没有合格输出）。app **不区分原因码**（都落为契约里的 kind，见 D4），原因码只给排障用、不进日志。
  - `done` 与 `failed` 互斥；两者都不出现、`request.json` 也不在 → 作业从未就绪或已被 app 删掉。
- **顺序与原子性**：app：`mkdir jobs/<id>` → `mkdir in` → 写 `in/<name>` → `rename` 出 `request.json` → 轮询 `done` / `failed`（100 ms）→ 读 PDF → `rm -r jobs/<id>`。sidecar：轮询 `jobs/`（200 ms）找「有 `request.json`、没有 `done` / `failed`、不在自己的在途表里」的目录，按 `request.json` 的 mtime 升序领取，受 `CONVERTER_CONCURRENCY` 上限；领取后先 `cancel` 核对、再 spawn；结束后 `rename` 出 `done` 或 `failed`。**`jobs/` 由 app 建**（`preview_cache` 阶段，预检通过后）；sidecar 在它出现之前每轮 `readdir` 得到 `ENOENT`，视为空列表、不建目录、不限次数——两个容器谁先起都行。**sidecar 从不删除作业目录**（归 app）；app 删目录时 sidecar 若正好在写标记，`rename` 得到 `ENOENT`，sidecar 吞掉——那个作业 app 已经不等了。sidecar 重启：在途作业的 `soffice` 随容器死；重启后它看到的「有 `request.json`、无标记」目录会被重新领取——app 侧要么还在等（正常收到结果），要么已超时并删掉目录（sidecar 的 `ENOENT` 吞掉）；app 重启：`preview_cache` 阶段清空 `jobs/*`（D6），sidecar 在途的 `soffice` 写不进不存在的目录 → 非 0 退出 → `failed` 的 `rename` `ENOENT` 吞掉。两种重启都不会让一个作业被重复计入缓存：缓存写入只发生在 app 读到 `done` 之后、由 app 自己复制。
- **超时**：app 的 `timeoutMs`（`OFFICE_CONVERT_TIMEOUT_MS`）与 `request.json` 的 `timeoutMs` 是同一个数。app 到期 → 写 `cancel`、结果 `timeout`、删目录；sidecar 到期 → 杀组、`failed: timeout`。正常情况下 app 先到期（它先开始计时）；两边都有时限是为了 sidecar 不依赖 app 活着才能回收。
- **并发**：app 的队列（`OFFICE_CONVERT_CONCURRENCY`，缺省 2）是限流器；sidecar 的 `CONVERTER_CONCURRENCY`（缺省 2）是它自己的保险，部署时 SHALL ≥ app 的值（system.md 写明；sidecar 不知道 app 的配置，也不该知道）。小于时 app 看到的只是作业排在 spool 里多等一会儿，不会出错。
- **为什么是文件标记而不是 socket / HTTP**：零协议栈、零依赖、天然经卷共享、原子 `rename` 是文件系统给的；sidecar 的攻击面只有「读 `request.json`、写两个标记」。代价是 ≤ 300 ms 的轮询延迟（两侧之和），相对 1–2 s 的转换可忽略。
- **为什么输入复制字节而不是把输入所在目录挂进去**：挂目录等于把 `SANDBOX_ROOT` 的一部分给 sidecar，B2 明令只给输入；复制走 `openRegularFile` 的 fd（D4），还顺带把 `/o/` 输入侧的换入残余收窄到与 `/w/` 一致。

**D4 app 侧转换器（替换 `office.ts` 的 spawn 段，接口不变）。** `createOfficeConverter({spoolDir?, cacheDir, timeoutMs, pollMs?, log?})` 仍返回 `{available, convert(absInput, signal?), close()}`；`office-cache.ts` / `office-queue.ts` / `preview/app.ts` 的调用方不改一行。

- `available: spoolDir !== undefined`（构造时的布尔，与今天同形；D5 的预检失败让入口不传 `spoolDir`）。
- `convert` 的检查次序：`spoolDir` 未提供 → `unavailable`；已 `close()` 或 `signal` 已中止 → `aborted`；`absInput` 不是绝对路径 → `failed`；**心跳不新鲜 → `unavailable`**（新；路由把它答成同一个 503 固定页，`convertFailure` 已有该映射）；随后才建作业目录。
- **输入侧**：`openRegularFile(absInput)`（`regular-file.ts`；末段 `O_NOFOLLOW`、`fstat` 判普通文件、取 `size`）→ 以与 `collectOutput` 相同的纪律把恰 `size` 字节复制进 `jobs/<id>/in/<basename>`（`wx`、`0600`；短读即 `failed`；`HttpError("not_found")` 落为 `failed`——转换器的错误对象只带 kind）。**谁打开 fd**：转换器，不是路由——路由今天只 `lstat`、不开输入（Context），改路由意味着改 `convert` 的签名与「办公文档预览路由」的场景「传给替身的输入是…绝对路径」；转换器自己打开则路由与其测试一行不改（「待编排方确认」1）。
- **等待**：每 `pollMs`（缺省 100，测试可注入）`stat` `done` / `failed`；`done` → `collectOutput`（既有函数，改为读 `jobs/<id>/out/<stem>.pdf`，纪律与 200 MiB 上界不变）→ `pdf/<随机名>.pdf`；`failed` → `failed`；`timeoutMs` 到期 → 写 `cancel`、`timeout`；`signal` 中止或 `close()` → 写 `cancel`、`aborted`。**sidecar 死在作业中途** → app 看到的是自己的超时 → `timeout`（504），不是 503；下一次转换前的心跳检查才给 503（「待编排方确认」4）。
- **缓存命中不经转换器**（`office-cache.ts:159-162` 命中直接返回）：sidecar 宕机期间已缓存的文档照常可预览，只有未命中的才 503。
- **收尾**：无论成败 `rmSync(jobs/<id>, {recursive, force})`——同一 uid（D6），删得掉；删不掉不改变结果，留给启动清空。
- `close()`：对全部在途作业写 `cancel`、以 `aborted` 落定、等它们收尾。
- `OfficeConvertError` 五种 kind 不增不减；`office-cache.ts` 对转换器的使用不变（`convertInto` 的 `rename` 进 `pdf/<key>.pdf`）。
- 删除：`buildLaunch`、`spawnAndWait`、`terminate`、`OfficeSpawn`、`spawn` 选项、`ompUser`、`officeBin`、`process-path.js` 的 import、`ensureOwnedDir` 的 `2770`（作业目录改 `0700`）。`office.ts` 预计 332 → ≤ 330（删的多于加的）。

**D5 预检、心跳与 fail-closed（B3）。**

- **启动预检**（`server.ts` `app` 阶段、`officeOf(config)` 之前；位置理由同前版：`officeAvailable` 是 `:438-442` 的布尔快照）：`config.officeSpoolDir === undefined` → 跳过。否则 `preflightOfficeSidecar({spoolDir, waitMs: 5000, pollMs: 100, freshMs: 10000})`（新模块 `server/src/preview/office-sidecar-health.ts`，≤ 100 行：`heartbeatFresh(spoolDir, freshMs, now)` 给转换器与预检共用；三个时间参数可注入，单元测试以 `utimes` 伪造心跳年龄、以 20 ms 的 `pollMs` 跑完 2 s / 6 s 两个方向，编译入口各留一例真实墙钟）：(1) `lstat(spoolDir)` 是目录、属本进程 uid、不带组 / 其它写位（`mode & 0o022 === 0`）——否则 `false`（不校正、不 chmod：这是部署方的卷，属主不对不是 app 能修的；**不**走 `ensureOwnedDir` 的启动失败路径——B3 要的是 fail-closed，不是进程退出）；(2) 等 `heartbeat` 新鲜，至多 `waitMs`（每 100 ms 看一次）——**冷启动竞态**：compose 同时起两个容器，sidecar 的第一次心跳可能晚于 app 的预检，不等就每次开机都 fail-closed；5 s 覆盖 Node 启动 + 第一次 touch（sidecar 启动即 touch，不等 LibreOffice）；部署方另以 compose `depends_on: condition: service_healthy` + sidecar 的 `healthcheck`（`test: ["CMD","node","/app/healthcheck.mjs"]`，看 heartbeat 年龄）消掉大部分等待（system.md）。预检永不 reject，任何抛出落为 `false`；`StartupStage` 不加值。
- **失败后果**：`officeOf(config, "unavailable")` 不把 `officeSpoolDir` 传给转换器（`available=false`，与未配置同形），`officeAvailable` 快照为 `false`，`/o/` 503「服务器未启用文档转换，请下载后查看」；清理对象不受影响（它只管 `pdf/` 与 `jobs/`，见 D6）；随后恰一行 `{"event":"office_convert_sidecar_unavailable"}`（新 `emitOfficeSidecarUnavailable`，形同 `emitSandboxRootUnchanged`，只有 `event` 一个键，`void` 调用，写失败吞掉），位于 `server_started` 之前。预检通过不写任何记录。
- **运行期心跳**：`convert` 在建作业目录之前 `stat` `heartbeat`，不新鲜 → `unavailable`（503 固定页），不写 spool、不建目录。**日志策略**：边沿触发——转换器持有一个 `staleReported` 标志，从新鲜到不新鲜的第一次 `unavailable` 经注入的 `log` 写一行同名记录 `{"event":"office_convert_sidecar_unavailable"}`，再次见到新鲜时复位；一次宕机无论多少请求至多一行，恢复后再宕再一行（「待编排方确认」3）。`available` 快照不随运行期变化（令牌仍说可用、`/o/` 答 503）：与今天 `available` 的语义一致，重启前不翻转；文档写明。
- **sidecar 死在作业中途**：见 D4——`timeout` 504；下一次请求 503。
- **规格落点**：office-preview ADDED「转换 sidecar 的健康与 fail-closed」；http-service-skeleton「服务启动与装配」成功顺序句插入预检一步、事件名 `office_convert_sidecar_unavailable`；preview-origin「预览令牌签发端点」`officeAvailable` 当且仅当配置了 `OFFICE_SPOOL_DIR` 且启动预检通过。

**D6 身份、属主与退役的提权面（B7）。**

- **uid/gid 对齐**：sidecar 以**与 app 进程相同的数值 uid/gid** 运行（compose `user: "${WORKBUDDY_UID}:${WORKBUDDY_GID}"`，部署方填 app 用户的 `id -u` / `id -g`；镜像里不 `USER`、不 `useradd`）。spool 目录由部署方建、属 app 用户、`0700`；app 建的 `jobs/<id>` `0700`。为什么不用编排方默认的 `2770` + 共享组：同一 uid 下不需要组语义，少一个部署变量（组名 / gid）与一类残余（组可写目录里的换入）；代价是「sidecar 以一个不在镜像 `/etc/passwd` 里的 uid 运行 LibreOffice」——未测（Context），由 D10 的 CI e2e 以 runner 的 uid（不在 `node` 镜像的 passwd 里）顺带实测；LibreOffice 对此的已知依赖只有 `HOME`（我们设成作业目录）与 `UserInstallation`（我们显式给出）——读手册推出（「待编排方确认」2）。
- **退役**：`sudo … setpriv … soffice` 前缀、sudoers 第一行（`… setpriv --pdeathsig KILL -- <OFFICE_BIN> *`）与第二行（`… /usr/bin/find <work> -mindepth 1 -delete`）、`clearWork` 的 `sudo … find` 段与 `stopWorkClear`、事件 `preview_work_clear_failed`（没有别的失败需要它：本进程自己的删除失败一直是静默的；`server.ts:200` 的联合类型与 `office-cache.ts:201` 的 `log` 选项一并删）、`<cacheDir>/work`（不再建；`preparePreviewCache` 改为建 `pdf/` 与 `<spool>/jobs/`（后者只在配置了 `OFFICE_SPOOL_DIR` 且预检通过时）并以本进程递归删 `jobs/*`）、`fake-sudo-find.mjs`、`office-work-clear.test.ts`。`cacheDir` 的 `2750` 保留不动（没有理由在本 change 里碰它）；`pdf/` `0700` 不变。
- **`officeReady` 门不变**：`preview/app.ts:88`、`:159`、`:265` 与 `server.ts:362`、`:397`、`:457`、`:551`——启动清空落定前 `/o/` 答 503 `BUSY_TEXT` 的门照旧，只是清空的对象从 `work/` 变成 `jobs/`；不在 D9 表里，因为没有断言要改。
- **`OMP_USER` 与办公文档解耦**：`officeOf` 不再读 `config.ompUser`；omp-uid-isolation 规格不需要改任何 omp 侧句子（Context：它从未含办公文档规则）。ADR-0010 的 2026-10-12 补充整节加头注「2026-10-17 起退役，见下文补充」，不删历史。
- **`OFFICE_BIN` → `OFFICE_SPOOL_DIR`（1:1 替换，十二个键仍是十二个）**：`officeSpoolDir?: string`，给出时须绝对路径（`resolveOwnedPath` 不适用——它绑 repo root 给相对路径；这里沿用 `resolveOfficeBin` 的形状：绝对路径、不查存在性、不建目录、错误 message `OFFICE_SPOOL_DIR must be an absolute path`）；未配置即办公文档预览关闭。**`OFFICE_BIN` 仍被设置时启动失败**，错误 message `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR`（命名键、不含值、`reason:"config"`）：静默忽略会让升级后的部署把「没配 spool」看成 sidecar 宕机（「待编排方确认」5）。
- **对 `OMP_USER` 部署的升级**：删掉两行办公文档 sudoers 规则（留着无害但不再匹配任何命令）；`Defaults>omp umask=0007` 是 omp 的，不动。

**D7 sidecar 实现与镜像（`converter/`）。**

- `converter/sidecar.mjs`（ESM，Node 24，零依赖，≤ 400 行）：环境 `CONVERTER_SPOOL_DIR`（缺省 `/spool`）、`CONVERTER_SOFFICE_BIN`（缺省 `/usr/bin/soffice`；测试指向 `fake-soffice.mjs`）、`CONVERTER_CONCURRENCY`（缺省 2，正整数）、`CONVERTER_POLL_MS`（缺省 200，只为测试缩短）、`CONVERTER_HEARTBEAT_MS`（缺省 2000，同上）。启动：校验 spool 可写、`wx` 建 `heartbeat`（已存在则 touch）、进入循环。每轮：touch 心跳（按周期）；列 `jobs/`，领取就绪作业直到并发上限；对每个在途作业每轮看 `cancel`。作业：读 `request.json`（`JSON.parse`，键集与类型严格；`input` 单一路径段、不以 `-` 开头、扩展名 `docx|xlsx|pptx`；`timeoutMs` 正整数 ≤ 2147483647）→ 不合法 `failed: bad-request`；`spawn(sofficeBin, [...固定参数, '--outdir', <job>/out, <job>/in/<name>], {cwd: job, env: {PATH, HOME: job, LANG?}, stdio: 'ignore', detached: true})`；`timeoutMs` 到期或 `cancel` → `process.kill(-pid, 'SIGKILL')`；`exit` → 0 且 `out/<stem>.pdf` 是 size > 0 的普通文件（`lstat`）→ `done`，否则按原因 `failed`。标记写法 `.part` + `rename`，`ENOENT` 吞掉。信号：`SIGTERM` → 对全部在途作业杀组、退出 0（容器停止时 compose 发 `SIGTERM`；`init: true` 让 PID 1 是 tini，僵尸被回收、信号被转发——读 Docker 手册推出）。日志：stderr 每作业一行 `{"event":"convert","id":"<id>","result":"done|failed","reason":"<码>","ms":<n>}`——不含输入名、不含路径；它在容器日志里，不进 app 的 stderr。
- `converter/healthcheck.mjs`（≤ 30 行）：`heartbeat` 年龄 < 10 s → 0，否则 1；给 compose `healthcheck` 用。
- `converter/Dockerfile`：`FROM node:24-bookworm-slim`（与仓库钉的 Node 24 同主版本）；`apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu-core fonts-noto-cjk`（CJK 字体：产品是中文界面，文档多半中文——第二轮只有 DejaVu，没有测 CJK，D11 (b) 补）+ `rm -rf /var/lib/apt/lists/*`；`COPY sidecar.mjs healthcheck.mjs /app/`；`ENV CONVERTER_SPOOL_DIR=/spool`；`ENTRYPOINT ["node","/app/sidecar.mjs"]`；`USER node`（镜像自带的 uid 1000）作为**非 root 的地板**——忘了传 `user:` 时也不会以 root 跑在挂着 spool 的容器里；compose 的 `user:` 覆盖它；不 `VOLUME`。镜像大小约 600–900 MB（LibreOffice），由部署方 `docker compose build`。
- `converter/compose.yml`：只定义 `converter` 一个服务：`build: .`、`network_mode: none`、`read_only: true`、`tmpfs: ["/tmp"]`、`init: true`、`user: "${WORKBUDDY_UID:?set to the app user's uid}:${WORKBUDDY_GID:?set to the app user's gid}"`（两个变量缺席时 compose 拒绝启动而不是落成空串）、`volumes: ["${OFFICE_SPOOL_DIR:?}:/spool"]`（bind mount；不用命名卷——命名卷根属 root，预检第 (1) 步会拒）、`healthcheck`（`healthcheck.mjs`，`interval: 5s`、`start_period: 10s`）、`restart: unless-stopped`、`environment: [CONVERTER_CONCURRENCY=${OFFICE_CONVERT_CONCURRENCY:-2}]`、`security_opt: ["no-new-privileges:true"]`、`cap_drop: [ALL]`（LibreOffice 不需要任何 capability——读手册推出，e2e 验证）。app 容器化时把这个服务 `include` 进 app 的 compose 并加 `depends_on: converter: condition: service_healthy`；**裸机**部署在同一主机上 `docker compose -f converter/compose.yml up -d --build`，`OFFICE_SPOOL_DIR` 指向 app 用户的目录——两种形态跑的是同一个容器（B6/B7）。没有 Docker 的主机：办公文档预览不可用（fail-closed），其余功能不受影响。
- **工具面接线**（S1 任务，不让实现者自己发现）：`biome.json` `files.includes` 加 `converter/**`；`Makefile` `lint` 与 ci `fast-checks` 的 `biome check` 加 `converter`（后者是 CI 改动，归 S2a，S1 先只改 Makefile 并在 PR 注明）；`scripts/size-guard.sh` 的 `find` 加 `converter` 目录与 `-name '*.mjs'`（自证 `test-guardrails.sh` 加一条 `.mjs` 探针）；`.jscpd.json` pattern 加 `converter`；knip 不加（不是 workspace，sidecar 不被 TS 代码 import——knip 不扫它，`converter/` 不进根 `package.json` 的 workspaces；它没有依赖、没有 `package.json`）。`converter/` 不是 npm workspace 的理由：零依赖、零构建，Dockerfile 只 `COPY` 两个文件；做成 workspace 会把 vitest 的 `coverage.include: src/**` 阈值与 `typecheck --workspaces` 都拖进来，换不来任何东西。

**D8 测试接缝（T4）。**

- **进程内假 sidecar**（`server/test/support/fake-sidecar.ts`，≤ 200 行）：`startFakeSidecar(spool, {heartbeat?: boolean | "stale", behaviour?})` 在测试进程里以 `fs.watch` + 100 ms 轮询兜底监视 `jobs/`，对出现的 `request.json`：按 `input` 文件名里的 `@标记`（与 `fake-soffice.mjs` 同一词汇：`ok` 写出同一份 `PDF` 字面量到 `out/<stem>.pdf` 再 `done`；`exit1` → `failed: exit`；`empty` → 0 字节输出 → `failed: no-output`；`hang` → 不写标记直到看到 `cancel`（记录看到的时刻）；`symlink` → 输出是符号链接 → `done`（让 app 侧的 `O_NOFOLLOW` 判 `failed`）；`append` / `truncate` / `sparse` → 复刻 `office-converter-output.test.ts` 的四种输出边界）；记录每个作业的 `request.json` 内容、`in/` 下的文件名与字节、看到 `cancel` 的时刻；心跳线程每 500 ms touch（`"stale"` 则写一个 mtime 为 30 s 前的 heartbeat 后不再 touch）。**它不做任何隔离**，头注释写明。编译入口测试同样在测试进程里起它（纯文件操作，不需要子进程）。
- **sidecar 脚本测试**（`server/test/converter-sidecar.test.ts`，≤ 500 行）：`spawn(node, ["../converter/sidecar.mjs"], {env: {CONVERTER_SPOOL_DIR: <tmp>, CONVERTER_SOFFICE_BIN: FAKE_SOFFICE, CONVERTER_POLL_MS: "20", CONVERTER_HEARTBEAT_MS: "50", CONVERTER_CONCURRENCY: "1"}})`，测试充当 app 写作业：正常（`done`、PDF 字节等于假 `soffice` 的字面量、假 `soffice` 记录的 argv 恰为固定参数 + `--outdir <job>/out` + `<job>/in/<name>`、环境键恰为 `PATH`/`HOME`/`LANG`、`HOME === job`、cwd 为 job）；`bad-request` 六种（缺键、多键、`input` 含 `/`、`input` 以 `-` 开头、扩展名 `html`、`timeoutMs` 为 0 / 字符串）→ `failed` 行恰为 `bad-request`、假 `soffice` 零记录；`@exit1` → `exit`；`@empty` → `no-output`；`@sleep`（假 `soffice` 自带的睡眠标记）+ `timeoutMs: 200` → `failed: timeout`、假 `soffice` 及其子进程在有界时间内不存在（`fake-soffice.mjs` 的 `@spawn-child` 类标记派生子进程，验证整组被杀）；`@sleep` + 写 `cancel` → `cancelled`、同上；并发 1 时两个作业按 `request.json` mtime 顺序、第二个在第一个落定后才启动；心跳文件在 `HEARTBEAT_MS` 内被 touch；`SIGTERM` → 在途作业的进程组被杀、sidecar 退出 0；作业目录在落定前被删 → sidecar 不崩、继续服务下一个。**不 import `sidecar.mjs`**（它是守护进程，有顶层副作用；也避免 TS 对 `.mjs` 的类型问题）。
- **app 侧转换器**（`server/test/office-converter.test.ts` **重写**，≤ 700 行；旧文件的 795 行里只保留检查次序、`unavailable`/`aborted`/绝对路径三例与「作业目录被删」的用例骨架；其余按 D9 退役）：对着假 sidecar——`request.json` 键集恰为三键、`timeoutMs` 等于构造值、`input` 等于 basename；`in/<name>` 字节逐字节等于输入（含 1 MiB 的随机内容）；**不泄露路径**：把 `SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`、`OMP_STATE_DIR`、输入目录都造成含哨兵段，一次转换后递归读 spool 树的每个文件，没有一个含任一哨兵；输入是符号链接 / 在 `lstat` 之后被换成符号链接（钩子辅助复现，与 `regular-file` 的测试同一手法）→ `failed`、spool 里没有 `in/`；`done` → 结果是 `pdf/` 下 `0600` 新文件、字节等于假 sidecar 写的；`failed` → `failed`；心跳 stale → `unavailable`、spool 里零作业目录、`log` 恰一行、再来三次仍一行、恢复新鲜后一次成功、再 stale 再一行；`timeoutMs` 200 + `@hang` → `timeout`、假 sidecar 记录到 `cancel`、作业目录被删；`signal` 中止 → `aborted` + `cancel`；`close()` → 在途全部 `aborted` + `cancel`、之后 `convert` 立即 `aborted`；四种输出边界（append/truncate/sparse ×2）结论同今天（`office-converter-output.test.ts` 改接缝即可，第 4 种改法）；构造参数不是绝对路径 → 抛出 message `cacheDir and spoolDir must be absolute paths`。
- **编译入口**（`server-startup-office.test.ts` 改写，第二个 `describe` 退役；≤ 450 行）：`OFFICE_SPOOL_DIR` 指向临时 spool、假 sidecar 在测试进程里跑——既有三例（转换 + SIGTERM 杀在途、并发 1、未配置时 `officeAvailable=false` + 启动清空 `pdf/`）改接缝：SIGTERM 例改为断言假 sidecar 记录到 `cancel`、`jobs/` 为空；新例：spool 不存在 / 属主不对（`chmod 0777` 让组写位为 1 即可，不需要换 uid）/ 无心跳 → 启动成功、`server_started` 照常、stderr 在它之前恰一行 `{"event":"office_convert_sidecar_unavailable"}`、令牌 `officeAvailable=false`、`/o/` 503 固定文案、`jobs/` 下零目录；心跳在启动后 2 s 才出现 → 启动成功且**没有**该行、`officeAvailable=true`（冷启动等待）；心跳 6 s 后才出现 → 有该行（5 s 上限）；`OFFICE_BIN` 仍设置 → `server_start_failed reason:"config"`、`resolveServerConfig` 的 message 含 `OFFICE_BIN` 不含值；`jobs/` 下有上次的遗留目录 → 启动后为空（本进程删）。
- **变异证据**（逐条做、撤销，结果贴进 PR）：app 侧——`request.json` 多写一个 `path` 键 → 键集断言判红；输入改为 `rename` / 硬链接而不是复制字节 → 字节相等仍绿但「换入成符号链接 → failed」判红（必须经 `openRegularFile`）；去掉心跳检查 → stale 例判红；`staleReported` 不复位 → 「恢复后再 stale 再一行」判红；超时不写 `cancel` → 假 sidecar 的 `cancel` 记录判红；预检结果被忽略 → 编译入口 `officeAvailable=false` 与 503 判红；预检不等心跳（`waitMs` 0）→ 「2 s 后出现」例判红；`waitMs` 30 s → 「6 s 后出现」例判红。sidecar——去掉扩展名校验 → `html` 例判红；去掉 `detached` / 改为只杀 pid → `@spawn-child` 的子进程存活例判红；标记不经 `.part` + `rename` → 原子性例（测试以紧循环 `readdir` + `readFile` 读作业目录直到 `done` / `failed` 出现，断言从未观察到 `.part` 名、也从未读到半截的 `failed` 内容）判红；`done` 在输出校验之前写 → `@empty` 例判红；吞掉 `ENOENT` 改为抛出 → 「落定前被删」例判红（sidecar 崩）。

**D9 封闭的退役与改写表（T4；替代前版 D5）。** 本 change 删除整条 requirement，所以在 sandbox-boundary-closure 的四种改法之外加**第 5 种**：「钉住被规格 delta 删除（REMOVED）的行为的断言与文件，随该 requirement 的归档在同一 PR 删除，逐文件列入本表」。表外的删除停下先补表。

| 文件:行 | 钉住的旧行为 | 改法 | 处置 | 切片 |
|---|---|---|---|---|
| `server/test/office-work-clear.test.ts`（496 行，整文件） | `sudo … find`、超时、`stopWorkClear`、`preview_work_clear_failed` | 5 | **删除**（「转换缓存」REMOVED） | S1 |
| `server/test/fixtures/fake-sudo-find.mjs`（76 行） | 假 `sudo … find` | 5 | **删除**；开工核对 `grep -rn fake-sudo-find server/test` 只剩上一行与 `server-startup-office.test.ts:42` | S1 |
| `server/test/office-converter.test.ts:135-178`（`stage()`）、`:195-197`、`:200-229`（`contractArgs`/`sudoPrefix`）、`:355-367`、`:447-477`、`:551-582`、`:696-732`、`:776-793` 及全部以 spawn argv / `detached` / `sudo` / 「没有 pid 可杀」为断言的用例 | spawn 形状、两种终止、`officeBin` 不存在 | 5 | **重写为 D8 的 app 侧用例**（「转换器调用契约」REMOVED → 「sidecar 转换契约」ADDED）；保留并改接缝（第 4 种）的只有：检查次序三例（`unavailable` / `aborted` / 非绝对路径 → 不建目录）、「构造参数不是绝对路径」（message 改为 `cacheDir and spoolDir must be absolute paths`，第 3 种）、「作业目录被删」 | S1 |
| `server/test/office-converter-output.test.ts`（189 行） | 输出复制的四种边界 | 4 | 输出由假 sidecar 写而不是假 `soffice`，断言不变 | S1 |
| `server/test/office-queue.test.ts:72-90`（`cacheOn`）、`:220-249` | 构造带 `officeBin`；`sudo` 链到假 `soffice`、`commands toEqual(["sudo","sudo"])`、派生子进程不随之结束（`:241` D-25 等价物） | 4 / 5 | `cacheOn` 改传 `spoolDir`（假 sidecar）；`:220-249` 整例删除（它钉的是 `OMP_USER` 终止只杀 `sudo`——REMOVED） | S1 |
| `server/test/office-cache.test.ts:62-70`、`:335-384`（`standIn` 换 `node -e`） | 构造带 `officeBin`；`standIn` 换下一次启动的命令 | 4 | 改传 `spoolDir`；`standIn` 改为让假 sidecar 对下一个作业按指定行为应答（同一事实：失败不入缓存、再次转换成功） | S1 |
| `server/test/office-cache-helpers.ts` `bench()` | 构造带 `officeBin` | 4 | 改传 `spoolDir` 并启动假 sidecar；导出 `FAKE_SIDECAR` 常量 | S1 |
| `server/test/server-startup-office.test.ts:104-272` | `OFFICE_BIN` 指向假 `soffice`；SIGTERM 杀在途 `soffice` | 4 | env 改 `OFFICE_SPOOL_DIR`；杀在途改为「假 sidecar 记录到 `cancel`」 | S1 |
| `server-startup-office.test.ts:274-434`（第二个 `describe`） | 以 omp 用户清空 `work/` 的两例 | 5 | **删除** | S1 |
| `server/test/preview-config.test.ts:34-45`、`:89-90`、`:120-121`、`:195`、「十二」字样 | 十二个键含 `OFFICE_BIN` | 3 | `OFFICE_BIN` 一行换成 `OFFICE_SPOOL_DIR`（同形：绝对路径、未配置即关），数量仍 12；非法值四例换键名；新增「`OFFICE_BIN` 被设置 → 抛出且 message 含 `OFFICE_BIN`」一例 | S1 |
| `server/test/omp-max-processes-config.test.ts:302-303` | `OFFICE_BIN` 的 empty / 裸名非法 | 3 | 两行改为 `OFFICE_SPOOL_DIR`；另加 `["OFFICE_BIN","/usr/bin/soffice"]`（任何值都非法） | S1 |
| `server/test/preview-office-route*.test.ts`、`uid-isolation.test.ts`、`office-work-clear` 之外的 `linux/` | 替身；无办公文档断言 | — | 不改 | — |

**D10 CI（编排方补充；「CI 改动，需 owner 确认」）。**

- **新 job `office-sidecar`**（`runs-on: ubuntu-24.04`，`timeout-minutes: 15`）：checkout → setup-node（同其它 job）→ `npm ci` → `npm run build --workspace server` → `docker build -t workbuddy-converter:ci converter/` → `bash .github/scripts/ci-office-sidecar.sh`。脚本：(1) 建 spool（`0700`，runner 用户）；(2) `docker run -d --network none --read-only --tmpfs /tmp --init --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" -v "$spool:/spool" workbuddy-converter:ci`——与 `compose.yml` 逐项相同的标志（harness 合同里把这一行钉成字面）；等 `heartbeat` 出现（≤ 30 s，LibreOffice 不参与心跳）；(3) 在 runner 上起一个记录请求的 `python3 -m http.server`；用 `python3` 的 `zipfile` 生成一份最小 docx（`word/document.xml` 里一张 `r:link` 指向 `http://127.0.0.1:<port>/probe.png` 的外部图片，`TargetMode="External"`；不提交二进制、不进仓库）——这是 issue 2026-10-12 表里的那一种向量，不是 B1 的数据类向量；(4) **走产品代码**：`node --input-type=module -e` 导入 `server/dist/preview/office.js` 的 `createOfficeConverter({spoolDir, cacheDir, timeoutMs: 60000})` 转换该 docx（`snapshot_probe` 的手法，bash 里没有第二份协议实现）→ 断言结果 PDF 存在、`grep -a -c '/Subtype */Image'` 为 0、监听器 0 次请求、`jobs/` 为空、PDF 属 runner uid；(5) **对照**：`docker run --rm --network host -v "$tmp:/job" --user … workbuddy-converter:ci soffice --headless … --convert-to pdf --outdir /job/out /job/<同一 docx>` → 监听器 ≥ 1 次请求且 PDF 含图（对照红就是 fixture 失效，不是产品红）；(6) `docker stop` → 容器退出 0、无残留进程。runner 的 uid 不在 `node:24-bookworm-slim` 的 `/etc/passwd` 里——这一跑顺带实测 D6 的未测项。
- **合同同步**（同一 PR）：`ci.yml` `all-checks-passed.needs` 加 `office-sidecar`；`scripts/test-ci-harness.sh` 的 `aggregate` 字面、job 存在 / `runs-on` / `if` / `continue-on-error` / `timeout` 的变异合同为新 job 各加一条（`runs-on` 合同以 `ubuntu-24.04` 为基线，变异到 `ubuntu-latest` 应被拒——与其它 job 相反，因为本 job 的全部实测只对 24.04 成立）、`check_wf` 对 `constraints.yaml` `ci.matrix` 的核对（`matrix` 加 `ubuntu-24.04` 或为该 job 单列——由第一次 `make test-guardrails` 的拒绝项定）、`fast-checks` 的 `biome check` 加 `converter`；`AGENTS.md` Enforcement Index 加一行「办公文档转换隔离 | `.github/workflows/ci.yml`（job `office-sidecar`） | CI `office-sidecar`/`all-checks-passed` | block」并补 harness 合同；`omp-uid-isolation`「CI uid-isolation job」场景「九个 direct job」→ 十个（delta 已写）。**第一个任务是把 job 桩放进去跑 `make test-guardrails`**：合同会自己列出每一处被拒的地方，那是测量，不是猜。
- **uid-isolation job 不动**：它没有办公文档规则（Context），本 change 不触碰它；它的 `runs-on: ubuntu-latest` 在 2026-10-19 之后迁到 Ubuntu 26 是仓库级风险，**不在 #1350 范围**，列在「待编排方确认」9 由编排方另开 issue。
- **owner 不批 CI 改动时**：S2a 不做，S2b（测试主机手工实测，D11）独立成立；规格里「真实转换的人工验证」的 CI 场景那时改为「测试主机」措辞（tasks 2.5 的分支）。
- **证据等级**：这个 job 证明 GitHub 24.04 runner 上「真镜像 + `--network none` + 产品代码的 spool 客户端」能转换一份 docx 且 http 外链不被取回、runner uid 能跑 LibreOffice；不证明 xlsx / pptx、字体、长文档——那些是 D11。

**D11 测试主机实测与两种结果（S2b）。** 执行者是编排方 / owner 本人（实现子代理不接触远端主机），在 S1 合并之后、以 S1 的构建按 **B6 的两种部署形态**各做一次：app 裸机 + sidecar 容器（`converter/compose.yml`）；app 容器 + sidecar 容器（临时 compose，`include` 本仓库的 `compose.yml`）。

- (a) 部署：按 system.md 9.7 的步骤（`WORKBUDDY_UID/GID`、`OFFICE_SPOOL_DIR` `0700`、`docker compose up -d --build`、app `OFFICE_SPOOL_DIR` 同一路径）；`OMP_USER` 两种模式各起一次 app（确认办公文档转换与之无关）；本机起记录请求的 http 监听器；工作空间之外放一张图。
- (b) 经文件页与 `/o/`：真 docx 带 http 图片（2026-10-12 的那份）→ 监听器 0 次、PDF 无图；docx / pptx 带 `file://` 外部图 → PDF 无图；docx / xlsx / pptx 各一份普通文档（含中文正文）→ 可翻页、中文可辨认（CJK 字体）；对照：同一 docx 以同一镜像 `--network host` 直接转 → 监听器命中、PDF 含图。
- (c) 终止链：`OFFICE_CONVERT_TIMEOUT_MS=3000` 请求归档 D17 那种约 25 s 的文档 → 504 之后 1.5 s、5 s、30 s 三个时刻 `docker top <converter>` 与 `ps` 看作业目录相关进程；重复 5 次；记录 `jobs/` 是否为空。
- (d) fail-closed：`docker compose stop converter` 后重启 app → stderr 恰一行 `office_convert_sidecar_unavailable`、令牌 `officeAvailable=false`、`/o/` 503；app 在跑时 `stop converter` → 下一次 `/o/` 503、stderr 恰一行；`start converter` → `/o/` 恢复，不再多行；再 `stop` → 再一行（边沿触发）。
- (e) 耗时：三个小文档各 3 次，与对照的直接 `soffice` 比；冷 / 热 profile 各记。
- (f) 结果表（内核、Docker、镜像基底与 LibreOffice 版本、(b)–(e)、变异列：临时把 `network_mode` 改成 `bridge` 重跑 (b) 的 http 例 → 应命中；临时把输入所在目录挂进 sidecar 并把外部图放进同目录重跑 `file://` 例 → 应有图；两条撤销）。宿主不留文件，被跟踪文本只称「测试主机」。
- **两种结果**：(1) 全绿 → S3 按此写 ADR；D-25 残余在 ADR 改为「sidecar 下不再出现（测试主机实测 5 次，含 25 s 文档）」或按观察改写。(2) (b) 任一例有命中 / 有图、或 xlsx / pptx / 中文转不出 → **停下报告**（字体或包缺失是 D7 镜像配方的变更，回 design；不在实现 PR 里自行加包）；(d) 任一方向不成立 → S1 缺陷，回 S1。

**D12 B1 向量的登记（B1，T7）。** xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、`INCLUDETEXT` / `INCLUDEPICTURE`、odt 链接节、ods 外部引用：**未测，视为跟随**。sidecar 覆盖它们的方式是构造性的——要读的本地文件不在容器里（只有镜像根、`/tmp`、spool），要走的网络不存在（`network_mode: none`），DDE 的进程间通信在容器自己的 ipc 命名空间里、没有别的进程——读代码 / 读 Docker 手册推出，不是实测；不写得比这更强，不为验证它们造文档（owner B1）。登记位置：Risks、ADR-0010 补充、ADR-0014 残余表、`app.ts` 头注释。

**D13 关键路径与白盒（AGENTS.md「沙箱与文件边界」「omp 子进程治理」）。** S1、S2a 的 PR 请求人工白盒审查；S2b、S3 不含运行时代码，贴清单请轻量复核。清单：

- S1：`office.ts` 的输入复制（`openRegularFile` → 恰 `size` 字节 → `wx 0600`；短读失败；`HttpError` 落为 `failed`）、`request.json` 的三键、`cancel` 的三个写点、心跳检查与 `staleReported` 边沿、收尾删目录；`office-cache.ts` 删掉的 `sudo` 段没有留下半截（`stopWorkClear` 的调用点 `server.ts:437` 一并删）；`server.ts` 预检的位置与五个落为 `false` 的分支、`emitOfficeSidecarUnavailable` 键集、`preparePreviewCache` 对 `jobs/` 的清空只删条目不删 `jobs/` 自身；`preview-config.ts` 两处（新键、`OFFICE_BIN` 拒绝）；`converter/sidecar.mjs` 的 `request.json` 校验、`detached` + 杀组、标记原子性、`ENOENT` 吞掉的范围（只吞标记写入与目录读取，不吞 spawn 错误）、不记录输入名；`Dockerfile` 的包清单、无 `USER`；`compose.yml` 的六个安全标志；假 sidecar 不做隔离在头注释里写明。
- S2a：`ci-office-sidecar.sh` 的 `docker run` 标志与 `compose.yml` 逐项相同、对照步骤真的用 `--network host`、断言用的是产品代码的 `createOfficeConverter`；harness 合同的每一条新增。
- S3：ADR / system.md / 头注释与 D11 结果表一致；D-25 的措辞不强于证据；FL-25/26/27 的新措辞可操作。

**D14 行数预算。** 见文末表。`office.ts` 332 → ≤ 330（删 spawn/terminate/sudo ≈ 120 行，加输入复制 / 轮询 / 心跳 ≈ 110 行）；`office-cache.ts` 326 → ≤ 230；`server.ts` 726 → ≤ 735（预检 `await`、`emit`、`officeOf` 参数；删 `stopWorkClear` 与 `preview_work_clear_failed`）；`preview-config.ts` 153 → ≤ 165；`converter/sidecar.mjs` ≤ 400；`office-converter.test.ts` 795 → ≤ 700（重写，净减）。

### 通用纪律（沿用 sandbox-boundary-closure；tasks.md 各组照此执行）

- **合入门槛。** 每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿，主干可运行。
- **永远不打真实模型端点。** 单测、冒烟、走查一律打假上游；本 change 的实测不涉及模型。
- **CI 与单元测试不需要 LibreOffice、不需要 Docker**（归档 D20 延续）：app 侧测试对着进程内假 sidecar，sidecar 脚本对着假 `soffice`；只有 CI 新 job `office-sidecar`（D10）与测试主机（D11）用真镜像。任何单元 / 编译入口测试里启动过的可执行文件，basename 不得是 `soffice`、`libreoffice`、`docker`。
- **路径不进 spool。** app 写进 spool 的任何字节不含 app 一侧的绝对路径；sidecar 的日志不含输入名。单元测试以哨兵段断言（D8）。
- **证据等级严格分开**：「实测」（平台、版本、次数）/「读代码推出」/「读手册推出」。PR、ADR、头注释里每条结论带其一。D-25 残余的新措辞不得强于 D11 (c) 的观察。
- **公开仓库卫生。** 测试主机在被跟踪文件里只称「测试主机」：不出现地址、任何登录名或账号名（含实测时临时建的账号）、密钥；实测命令里的用户以「应用用户」代称。
- **新逻辑进新模块，行数有预算**（D14 与文末表）。`scripts/size-guard.sh` 是硬门槛，不调阈值；`converter/*.mjs` 纳入它的扫描（D7）。
- **行号核对。** 本文与 tasks 里的 `文件:行` 是在 `4bac35cc` 上读的。每组开工先重跑该组第一个任务的核对；有出入先改本 change 的 design 与该组任务。
- **既有断言不删不削弱，除 D9 表所列。** 五种改法：① 改为「逐字节相等」；② 注入时钟 / 哨兵下改为确定次数；③ 钉住的正是被 MODIFIED 改写的旧行为时，改写为钉住新行为并引用裁定；④ 换接缝（构造参数、env、夹具），事实不变；⑤ **钉住被 REMOVED 的 requirement 的断言与文件，随归档在同一 PR 删除**——只限 D9 表里标 5 的行。表外需要③④⑤的先停下更新 D9。
- **镜像配方与 compose 标志不在实现期放宽。** 实测或 CI 发现缺字体、缺包、要加 capability、要开网络，停下报告——那是 D7 的变更，回 design。
- **不实现 Non-Goals 与「Not yet specified」。**
- **CI 文件只在 S2a 改**，PR 标题与正文都标「CI 改动，需 owner 确认」；S1、S3 发现非改 `.github/**`、`scripts/test-ci-harness.sh`、`constraints.yaml` 的 `ci:` 段或 `AGENTS.md` Enforcement Index 不可，停下报告。S1 对 `Makefile` / `biome.json` / `size-guard.sh` / `.jscpd.json` / `test-guardrails.sh` 的工具面接线（D7）不算 CI 改动。
- **白盒。** 每个切片在 PR 里请求白盒审查（D13），正文贴该切片的清单。
- `Suggested fixture level` 只用 `none | compact | expanded`。

## 规格影响

- **office-preview**：REMOVED「转换器调用契约」「转换缓存」（整条替换，openspec `--strict` 不接受 MODIFIED 块丢弃场景——两条的场景多数钉 `sudo` / spawn 形状）；ADDED「sidecar 转换契约」（替代前者：构造签名、输入复制、spool 协议的 app 一侧、kind 与检查次序、输出复制纪律、终止）、「转换缓存与作业目录清理」（替代后者：缓存键 / 命中 / 复制 / 周期清理不变，`work` 与 `sudo … find` 退役，`jobs/` 的启动清空）、「转换隔离边界」（D2）、「转换 sidecar 的健康与 fail-closed」（D5）、「转换 sidecar 实现与镜像」（D3 协议的 sidecar 一侧、D7 的镜像与 compose、CI e2e 的可观察）；MODIFIED「并发上限与排队」（去掉残留后代一句，全部场景保留）、「真实转换的人工验证」（记录项改为 sidecar 形态；新增 CI e2e 场景；两个既有场景保留）。「办公文档预览路由」不改。
- **http-service-skeleton**：MODIFIED「服务启动与装配」（`:11` `OFFICE_BIN` → `OFFICE_SPOOL_DIR` 与 `OFFICE_BIN` 被拒；`:15` 成功顺序句插入预检；`:98`、`:102` 两个场景的键名；其余逐字不动）、「预览监听器的装配与关停」（`:310` 建目录与清空改为 `pdf/` + `jobs/`、无 `sudo`、无 `preview_work_clear_failed`；`:314` 关停首步改为「对在途作业写 `cancel`」并入转换器 `close()`；`:318` THEN 的 `work` 2770 改为「没有 `work`」；`:328` THEN 改为「在途作业已被 `cancel`、`jobs/` 下无该作业」；其余场景逐字不动）。
- **preview-origin**：MODIFIED「预览令牌签发端点」（`officeAvailable` 当且仅当配置了 `OFFICE_SPOOL_DIR` 且启动预检通过；场景「对外来源与转换可用」WHEN 改键名并加预检通过；新增场景「sidecar 不可用时转换不可用」）。
- **omp-uid-isolation**：MODIFIED「CI uid-isolation job」——只改场景「job 全绿并入聚合」的「九个 direct job」→「十个」（新 job 入聚合）；requirement 正文逐字不动。owner 不批 S2a 时这条 delta 在归档前撤回。
- **仍成立、不改**：office-preview「办公文档预览路由」；preview-origin 其余；sandbox-core；omp-uid-isolation 其余四条。

## Risks / Trade-offs

- **[Docker 成为办公文档预览的前提]** → 没有 Docker 的主机办公文档预览不可用（fail-closed，其余功能不受影响）。owner B7 接受；system.md 写明。
- **[spool 协议是新造的]** → 两侧实现对不上就是 `failed` / 超时。缓解：协议只有三个文件名、三个 JSON 键、六个原因码；单一真相写在 sidecar 头注释与规格；sidecar 测试与 app 侧测试用同一份假 `soffice` 字面量；CI e2e 走产品代码两端。
- **[冷启动竞态]** → app 预检早于 sidecar 第一次心跳 → 每次开机 fail-closed。缓解：预检等 5 s + compose `depends_on: service_healthy`；编译入口测试钉住「2 s 后出现 → 可用」「6 s 后 → 不可用」。
- **[非 passwd uid 跑 LibreOffice 未测]** → D10 的 CI e2e 以 runner uid 实测；红即回 design（可能要 `nss_wrapper` 或镜像内建用户）。
- **[CJK 字体 / xlsx / pptx 在镜像里未测]** → D11 (b)；红即停下，镜像配方回 design。
- **[sidecar 死在作业中途表现为 504 而不是 503]** → 文档写明；下一次请求才 503。接受（否则 app 要在等待期间持续看心跳——多一个定时器换一次更准的状态码，不值）。
- **[`available` 快照不随运行期心跳翻转]** → 令牌说可用、`/o/` 答 503 固定页；与今天 `available` 语义一致。接受。
- **[CI 合同面大]** → 新 job 要同步 harness / constraints / AGENTS 多处。缓解：S2a 第一个任务用桩跑 `make test-guardrails` 列出全部被拒项；owner 不批则 S2b 独立。
- **[`ubuntu-latest` 迁移影响其它 job]** → 不在本 change 范围；「待编排方确认」9。
- **[删除 1300+ 行测试]** → 第 5 种改法有封闭清单（D9）；每个删除在 PR 偏离记录里对应一条 REMOVED 的 requirement。
- **[`OFFICE_BIN` 被设置即启动失败]** → 升级时部署方必须改配置；Migration Plan 写明；比静默忽略安全。
- **[`/o/` 输入侧换入残余收窄而不闭合]** → 只守末段（与 `/w/` 一致）；头注释与 ADR-0014 表按此写。
- **[B1 向量未测]** → 登记「未测、视为跟随」，按构造覆盖（读手册推出）；不造文档（owner B1）。
- **[macOS 开发机没有 Docker Desktop 时]** → 配了 `OFFICE_SPOOL_DIR` 的服务 fail-closed；真实转换本来就只在 Linux 主机验证。接受；`make smoke` / `ui-walk` 不设 `OFFICE_SPOOL_DIR`。
- **[轮询延迟 ≤ 300 ms]** → 相对转换时长可忽略。接受。

## Migration Plan

- 切片次序：S1（app 侧转换器 + sidecar 脚本 + 镜像 + 预检 / fail-closed + 全部单元与编译入口测试 + 工具面接线，atomic）→ S2a（CI 新 job + 合同同步，← S1；需 owner 确认）与 S2b（测试主机实测，← S1）→ S3（文档、ADR、头注释、验收行、关闭 #1350，← S1、S2b；S2a 若做则 ← S2a）。
- **部署（随 S1 发布）**：
  1. 任何配了办公文档预览的部署：装 Docker（含 compose 插件）；建 `OFFICE_SPOOL_DIR`（属 app 用户、`0700`）；`WORKBUDDY_UID=$(id -u <app 用户>) WORKBUDDY_GID=$(id -g <app 用户>) OFFICE_SPOOL_DIR=<同一路径> docker compose -f converter/compose.yml up -d --build`；app 环境去掉 `OFFICE_BIN`、加 `OFFICE_SPOOL_DIR=<同一路径>`；重启 app；看 stderr：有 `office_convert_sidecar_unavailable` 按 system.md 9.7 排障。
  2. 容器化的 app：把 `converter/compose.yml` `include` 进 app 的 compose，`depends_on: converter: condition: service_healthy`，两个服务挂同一个 bind mount，app 服务的 `user:` 与 converter 相同。
  3. `OMP_USER` 部署：删掉两行办公文档 sudoers 规则（`… setpriv --pdeathsig KILL -- <OFFICE_BIN> *` 与 `… /usr/bin/find <PREVIEW_CACHE_DIR>/work -mindepth 1 -delete`）；omp 的规则与 `Defaults>omp umask=0007` 不动。LibreOffice 可从 app 主机卸载（镜像里有）。
  4. 不设 `OFFICE_BIN` 的部署：无动作（办公文档预览本来就关着）。
  5. `<PREVIEW_CACHE_DIR>/work` 目录升级后不再使用；留着无害，可手工删除。
- **回滚**到旧版本：恢复 `OFFICE_BIN`、去掉 `OFFICE_SPOOL_DIR`（旧代码不认识它——旧的 config seam 忽略未知键，读代码推出）、恢复两行 sudoers；sidecar 容器可停可留。
- S2a 无部署动作；S2b 是实测；S3 无部署动作。

## Not yet specified

- **sidecar 的多实例与 app 多实例共用 spool**：领取语义（`request.json` mtime 升序 + 在途表）在单 sidecar 下成立；两个 sidecar 会重复领取同一作业——需要 `claim` 标记。本 change 只支持一个 sidecar、一个 app（Non-Goals）；问题说清了但不切。
- **spool 在网络文件系统上**（NFS 的 `rename` 原子性与 mtime 精度）：只支持本地 bind mount；未来若要跨主机再议。
- **镜像的发布与版本钉**：`node:24-bookworm-slim` 与 Debian 的 LibreOffice 包版本随 `apt-get` 漂移；owner 说镜像我们自己做，但钉哪个版本、要不要 digest，等 S2b 的实测结果与首次部署再定。
- **`available` 是否应随运行期心跳翻转**（令牌响应随之变化）：取决于前端是否想在 sidecar 宕机时直接显示「下载」而不是先请求再拿 503；没有产品输入前不切。

## 待编排方确认

1. **输入的 fd 由转换器打开**（`openRegularFile`），不改 `/o/` 路由与 `convert(absInput, signal)` 签名——路由今天不开输入的 fd（Context），「从路由已打开的 fd 复制」在代码里对应的是这个位置（D4）。
2. **uid/gid 对齐 = 同一数值 uid/gid + spool `0700`**，不用编排方默认的 `2770` + 共享组；代价是非 passwd uid 跑 LibreOffice 未测，由 CI e2e 顺带实测（D6）。
3. **运行期心跳不新鲜的日志策略 = 边沿触发**（一次宕机至多一行，恢复后再宕再一行）；事件名与启动预检同一个 `office_convert_sidecar_unavailable`（D5）。
4. **sidecar 死在作业中途 → 504 `timeout`**，不是 503；下一次请求才 503（D4）。
5. **`OFFICE_BIN` 仍被设置 → 启动失败**（`reason:"config"`，message 命名 `OFFICE_BIN`），不静默忽略；`OFFICE_SPOOL_DIR` 1:1 替换，十二个键仍是十二个（D6）。
6. **输入在 spool 里的名字 = `basename(absInput)`**（已是单一路径段），不改成固定名——让 `fake-soffice.mjs` 的 `@标记` 机制在 sidecar 测试里原样可用，也让 `out/<stem>.pdf` 的推导与今天同形；sidecar 校验它是单一路径段且扩展名在三种之内（D3）。
7. **`converter/` 不是 npm workspace**，零依赖 `.mjs`；lint / size-guard / jscpd 以显式加目录的方式纳入，knip 不纳入（D7）。
8. **CI e2e 的 docx 由 `python3 zipfile` 在 runner 上生成**（外部链接图片 docx），不提交二进制夹具；xlsx / pptx / 中文留给测试主机（D10、D11）。
9. **uid-isolation job 的 `runs-on` 不在本 change 范围**（它不含办公文档规则，本 change 不触碰它）；`ubuntu-latest` → Ubuntu 26 的迁移风险建议编排方另开仓库级 issue。
10. **office-preview 两条 REMOVED + 五条 ADDED** 的形状由 openspec `--strict` 的规则决定（MODIFIED 不得丢场景），不是起草者偏好；归档后主规格里 requirement 的名字随之变化（「转换器调用契约」→「sidecar 转换契约」，「转换缓存」→「转换缓存与作业目录清理」）。
11. **sidecar 的 CJK 字体包 `fonts-noto-cjk`** 进镜像（产品中文界面）；镜像体积因此 +~100 MB（D7）。
12. **`request.json` 只有三键**（`version`、`input`、`timeoutMs`），不带原文件名之外的任何元数据（D3）。
13. **S2a / S2b 拆分**：S2a = CI 新 job + 合同（需 owner），S2b = 测试主机实测（不需 owner 批 CI）；owner 不批 S2a 时「真实转换的人工验证」的 CI 场景改为测试主机措辞、omp-uid-isolation 的 delta 撤回（D10）。
14. **预检对 spool 根的要求**：目录、属本进程 uid、无组 / 其它写位；不校正、不 chmod；不满足是 fail-closed 不是启动失败（D5）。
15. **`preview_work_clear_failed` 事件退役**（随 `sudo … find`），`server.ts` 的记录联合类型与 `office-cache.ts` 的 `log` 选项一并删（D6）。
16. **`server.ts` 预算 735、`office.ts` 330、`converter/sidecar.mjs` 400**（D14）。
17. **非 root 地板**：Dockerfile `USER node`，compose `user:` 以 `${WORKBUDDY_UID:?}` 强制部署方给值（D7）。
18. **预检与心跳判定进新模块 `office-sidecar-health.ts`**（≤ 100 行），三个时间参数可注入，单元测试伪造心跳年龄（D5）。

## Sketch seams under test

- **spool 协议的 app 一侧（新，`office.ts` + 进程内假 sidecar）**：`request.json` 键集、字节复制、不泄露路径、`cancel` 三个写点、心跳边沿。这是「边界里有什么」在 app 侧唯一可单元断言的地方——没有 argv 可查了，查的是 spool 树。
- **spool 协议的 sidecar 一侧（新，`converter/sidecar.mjs` 子进程 + 假 `soffice`）**：校验、原子标记、杀组、`ENOENT` 容忍、并发、心跳。
- **输入复制（`openRegularFile` → `in/<name>`）**：换入成符号链接 → `failed`；这是收窄残余的证据。
- **编译入口 + 临时 spool + 假 sidecar**：预检两个方向与 5 s 窗口、`OFFICE_BIN` 拒绝、`jobs/` 启动清空、SIGTERM 时 `cancel`。
- **CI `office-sidecar` job（真镜像、`--network none`、产品代码的客户端）**：http 外链 0 请求 + 对照有请求；runner uid 跑 LibreOffice。
- **测试主机 `/o/` 端到端（手工，D11）**：三种格式、中文、`file://`、终止链、fail-closed 两个方向、两种部署形态。

## 行数预算

| 文件 | 现在 | 预计合入后上限 | 改动的切片 |
|---|---|---|---|
| `converter/sidecar.mjs`（新） | — | ≤ 400 | S1 |
| `converter/healthcheck.mjs`（新） | — | ≤ 30 | S1 |
| `converter/Dockerfile`（新） | — | ≤ 30 | S1 |
| `converter/compose.yml`（新） | — | ≤ 40 | S1 |
| `server/src/preview/office-sidecar-health.ts`（新） | — | ≤ 100 | S1 |
| `server/src/preview/office.ts` | 332 | ≤ 330（重写 spawn 段为 spool 客户端） | S1、S3（头注释） |
| `server/src/preview/office-cache.ts` | 326 | ≤ 230（`sudo … find` 段删除） | S1、S3（头注释） |
| `server/src/preview/office-queue.ts` | 194 | 不改 | — |
| `server/src/preview-config.ts` | 153 | ≤ 165 | S1 |
| `server/src/server.ts` | 726 | ≤ 735 | S1 |
| `server/src/preview/app.ts` | 330 | ≤ 335（只改头注释，目标净减） | S3 |
| `server/src/workspaces/regular-file.ts` | 68 | 不改 | — |
| `server/test/support/fake-sidecar.ts`（新） | — | ≤ 200 | S1 |
| `server/test/converter-sidecar.test.ts`（新） | — | ≤ 500 | S1 |
| `server/test/office-converter.test.ts` | 795 | ≤ 700（重写） | S1 |
| `server/test/office-sidecar-health.test.ts`（新） | — | ≤ 200 | S1 |
| `server/test/office-converter-output.test.ts` | 189 | ≤ 200 | S1 |
| `server/test/office-queue.test.ts` | 603 | ≤ 590（删一例） | S1 |
| `server/test/office-cache.test.ts` | 462 | ≤ 470 | S1 |
| `server/test/office-cache-helpers.ts` | 160 | ≤ 190 | S1 |
| `server/test/office-work-clear.test.ts` | 496 | **删除** | S1 |
| `server/test/fixtures/fake-sudo-find.mjs` | 76 | **删除** | S1 |
| `server/test/fixtures/fake-soffice.mjs` | 152 | ≤ 170（若需 `@spawn-child` 类标记） | S1 |
| `server/test/server-startup-office.test.ts` | 434 | ≤ 450 | S1 |
| `server/test/preview-config.test.ts` | 271 | ≤ 285 | S1 |
| `server/test/omp-max-processes-config.test.ts` | — | +1 行 | S1 |
| `.github/scripts/ci-office-sidecar.sh`（新） | — | ≤ 120 | S2a |
| `.github/workflows/ci.yml` | — | 新 job + `needs` + `fast-checks` 一行 | S2a |
| `scripts/test-ci-harness.sh` | ≈ 500 | 合同同步（≤ +40） | S2a |

## Traceability

| 来源 | 落点 |
|---|---|
| B1 | D12、Risks、Non-Goals；ADR-0010 补充、ADR-0014 表（S3） |
| B2 | D1、D2、D11；office-preview「转换隔离边界」ADDED |
| B3 | D5；office-preview「转换 sidecar 的健康与 fail-closed」ADDED；preview-origin、http-service-skeleton MODIFIED |
| B4 | proposal「流程记录」 |
| B5 | Context（归档 D22 的引用）、D6（ADR-0010 补充头注）、D11；tasks S3 |
| B6 | D1、D6、D7（compose）、D11（两种形态）、Migration Plan |
| B7 | D1、D3、D4、D6、D7、D10；office-preview REMOVED ×2 + ADDED ×5；omp-uid-isolation MODIFIED |
| T1 / T2（bwrap 形状，被 B7 否决） | Context 两轮实测表（背景） |
| T3 | D5；待编排方确认 3、4、14 |
| T4 | D8、D9、D11 |
| T5（收窄→新 job） | D10；tasks S2a |
| T6 | D11（f）、S3 |
| T7 | D12 |
| T8 | D14、行数预算；待编排方确认 16 |
| T9 | D13 |
| 编排方补充 1（真预检、假转换） | D8、D10 |
| 编排方补充 2（`ubuntu-24.04`） | D10（新 job）；待编排方确认 9 |
| 编排方补充 3（部署形态） | B6/B7 → D7、Migration Plan |
| 编排方补充 4（对照证据） | Context 第 2、7 行；D10 (5)、D11 (b) |
| 编排方 sidecar 协议默认 | D3–D8 逐条采用 / 修改，差异在「待编排方确认」2、6、12 |
