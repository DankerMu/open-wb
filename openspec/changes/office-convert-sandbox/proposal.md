# Proposal: office-convert-sandbox

## Why

#1350：办公文档转 PDF 时 LibreOffice 会去取文档里引用的资源——http 链接图片被取回并进了 PDF（issue 2026-10-12 表；测试主机 2026-10-16 对照复核：不加边界时监听器 3 次命中、PDF 含 1 张图），`file://` 链接读得到转换进程 uid 读得到的任何本地文件（`OMP_USER` 模式下是其它账号的工作空间；同 uid 模式下是应用用户的一切）。uid 分离挡不住这一类（ADR-0010 2026-10-12 补充、归档 `2026-10-12-s1f-files-page/design.md` D22 的已知残余）。

owner 裁定（grill ledger B1–B7）：数据类向量登记为「未测、视为跟随」、不造文档验证（B1）；缓解 = 无网络 + 只看得见输入与作业目录的隔离边界，先实测（B2）；边界不可用即 fail-closed、不回退裸 `soffice`（B3）；一个 change 走完整流水线（B4）；结果写进本 change 的 design 与 `preview/app.ts` 头注释，归档件不改（B5）；**边界必须在 app 以 Docker 容器部署时也可用**（B6，2026-10-16）；**单机制 sidecar**（B7，2026-10-17）：长驻 `--network none` 的转换容器经共享 spool 目录交接作业，不要 docker socket、不要容器特权，裸机部署同样跑这个容器；bubblewrap 整体不进本 change——两轮实测：裸机只在装了 AppArmor profile 时可用，容器里非特权 userns 与 setuid-root 两种在五个特权档全部起不来（`capset failed` / `RTM_NEWADDR` / uid map）；sidecar 实测 `--network none` 下 http 图 0 请求 0 图、`file://` 外部图不可见、1.0 s（热）/ 2.3 s（冷），对照有网络时 3 请求 1 图。`OMP_USER` 的 `sudo → setpriv → soffice` 链不再用于转换。

## What Changes

- **转换移出 app 进程**：新增 `converter/`（`sidecar.mjs` 小 Node 脚本、`healthcheck.mjs`、`Dockerfile`：`node:24-bookworm-slim` + LibreOffice writer/calc/impress nogui + DejaVu/Noto CJK 字体、`compose.yml`：`network_mode: none`、`read_only`、`tmpfs /tmp`、`init`、`cap_drop ALL`、`no-new-privileges`、`user: ${WORKBUDDY_UID:?}:${WORKBUDDY_GID:?}`、只挂 spool 的 bind mount；Dockerfile `USER node` 作非 root 地板）。镜像由部署方自建；裸机与容器部署同一形态。
- **spool 协议**（design D3）：app 在 `OFFICE_SPOOL_DIR/jobs/<id>/` 写输入的**字节**（经 `openRegularFile` 的 fd 复制，`in/<basename>`）与 `request.json`（恰 `version`、`input`、`timeoutMs` 三键，无路径），`request.json` 的原子 rename 即就绪；sidecar 转换后原子 rename 出 `done` 或一行原因码的 `failed`；app 写 `cancel` 终止；sidecar 每 2 s touch `heartbeat`，新鲜 = 年龄 < 10 s。**app 一侧的任何路径都不进 spool**。
- **app 侧转换器**（`server/src/preview/office.ts` 重写 spawn 段，接口 `{available, convert, close}` 不变）：输入复制、等待标记、取 PDF 进既有缓存（复制纪律与 200 MiB 上界不变）、超时 / 中止 / 关停写 `cancel`、每次转换前看心跳（不新鲜 → `unavailable` → 既有 503 固定页，边沿触发一行 stderr）。缓存键 / 命中 / 排队 / 并发上限 / 失败文案 / `/o/` 路由不变。
- **预检 + fail-closed**（B3）：启动 `app` 阶段在 `officeOf` 与 `createApp` 之前检查 spool 根（目录、属本进程 uid、无组/其它写位）并等心跳新鲜至多 5 s（冷启动竞态）；失败 → 转换器以未配置形态构造（`officeAvailable=false`、`/o/` 503「服务器未启用文档转换，请下载后查看」）+ stderr 恰一行 `{"event":"office_convert_sidecar_unavailable"}`；不是启动阶段、不加 `StartupStage`。
- **退役**：`sudo → setpriv → soffice` 前缀、两行办公文档 sudoers 规则、`clearWork` 的 `sudo … find` 与 `stopWorkClear`、事件 `preview_work_clear_failed`、`<PREVIEW_CACHE_DIR>/work`（作业目录改在 spool 的 `jobs/`，启动时由 app 自己清空）、`fake-sudo-find.mjs`、`office-work-clear.test.ts`、D-25 残余（同一进程组被杀，随链消失——由测试主机实测 5 次记录）。`OMP_USER` 与办公文档转换解耦。
- **配置** **BREAKING**：`OFFICE_BIN` → `OFFICE_SPOOL_DIR`（绝对路径，未配置即办公文档预览关闭；十二个预览键仍是十二个）；`OFFICE_BIN` 仍被设置 → 启动失败、message 命名该键。`OFFICE_CONVERT_TIMEOUT_MS` / `OFFICE_CONVERT_CONCURRENCY` 不变（后者 SHALL ≤ sidecar 的 `CONVERTER_CONCURRENCY`）。
- **测试**：app 侧对着进程内假 sidecar（临时 spool 目录的应答器，与 `fake-soffice.mjs` 同一套 `@标记`）；sidecar 脚本以子进程对着 `fake-soffice.mjs`；单元与编译入口测试不需要 Docker 与 LibreOffice；旧 spawn 形状的断言随 REMOVED 的 requirement 在同一 PR 删除（design D9 封闭表，第 5 种改法）。
- **CI**（「CI 改动，需 owner 确认」，S2a）：新 job `office-sidecar`（`runs-on: ubuntu-24.04`）构建镜像、`--network none` 起 sidecar、以产品代码的 spool 客户端转换一份 runner 上生成的带 http 外链图片的 docx → 0 请求 0 图；对照 `--network host` 直接 `soffice` → 有请求有图；runner 的 uid 不在镜像 passwd 里，顺带实测该项。入 `all-checks-passed.needs`（九 → 十）；harness / constraints / AGENTS 合同同步；`fast-checks` 的 `biome check` 加 `converter`。owner 不批则退回测试主机手工实测（S2b 独立成立）。uid-isolation job 不动。
- **实测**（S2b，编排方 / owner 本人）：两种部署形态下经 `/o/` 的 http 图 / `file://` 图 / docx·xlsx·pptx·中文、终止链 5 次、fail-closed 两个方向、耗时；结果表进 ADR。
- **文档**（S3）：ADR-0010 新补充（2026-10-12 补充整节加「已退役」头注）、ADR-0014（决定 6、残余表、`OFFICE_BIN` 节、环境变量表、运维）、system.md 9.7（两种部署形态的步骤、排障、fail-closed 表现）、头注释（`app.ts` `office.ts` `office-cache.ts` `server.ts`）、FL-25/26/27 改键名 + 新增 FL-39、CONTEXT.md 术语、IMPLEMENTATION_PLAN 两处；S3 合并后关闭 #1350。
- **不做**：bubblewrap 与任何第二种机制；B1 向量的实测；omp 的沙箱；app 的容器化与 compose 里的 app 服务；多 sidecar / 跨主机；非 Debian 镜像；`/o/` 输入侧换入残余的全闭合（收窄到与 `/w/` 一致：只守末段）。

## Capabilities

### New Capabilities

无。sidecar 的契约、隔离边界、健康与镜像作为 office-preview 的新 requirement 进入既有 capability。

### Modified Capabilities

- `office-preview`：**REMOVED**「转换器调用契约」「转换缓存」（整条替换——openspec `--strict` 不接受丢弃场景的 MODIFIED 块，两条的多数场景钉的是 spawn / `sudo` 形状）；**ADDED**「sidecar 转换契约」（构造签名、输入字节复制、spool 的 app 一侧、kind 与检查次序、输出复制纪律、`cancel`）、「转换缓存与作业目录清理」（缓存不变；`jobs/` 的启动清空；`work` 与 `sudo … find` 退役）、「转换隔离边界」（无网络、可见文件系统、身份、终止、不变量、收窄的残余）、「转换 sidecar 的健康与 fail-closed」（心跳、预检、5 s 等待、503、一行 stderr、边沿触发）、「转换 sidecar 实现与镜像」（`converter/` 的协议一侧、镜像与 compose 标志、CI e2e 可观察）；**MODIFIED**「并发上限与排队」（去掉残留后代一句）、「真实转换的人工验证」（记录项改为 sidecar 形态、新增 CI e2e 场景）。「办公文档预览路由」不改。
- `http-service-skeleton`：MODIFIED「服务启动与装配」（`OFFICE_SPOOL_DIR` 替换 `OFFICE_BIN`、`OFFICE_BIN` 被拒、成功顺序句插入预检一步）、「预览监听器的装配与关停」（建 `pdf/` 与 `jobs/`、无 `work`、无 `sudo`、无 `preview_work_clear_failed`；关停首步并入转换器 `close()` 的 `cancel`）。
- `preview-origin`：MODIFIED「预览令牌签发端点」（`officeAvailable` 当且仅当配置了 `OFFICE_SPOOL_DIR` 且启动预检通过；新增场景）。
- `omp-uid-isolation`：MODIFIED「CI uid-isolation job」——只改场景里「九个 direct job」→「十个」（新 job 入聚合；owner 不批 S2a 则归档前撤回这条 delta）。uid-isolation job 本身不动。

## Impact

- 新目录 `converter/`（`sidecar.mjs`、`healthcheck.mjs`、`Dockerfile`、`compose.yml`）；守卫接线：`biome.json`、`Makefile lint`、`scripts/size-guard.sh`（+`.mjs`）、`.jscpd.json`、`scripts/test-guardrails.sh`。
- `server/src/preview/office.ts`（重写 spawn 段）、`office-cache.ts`（删 `sudo … find`）、`preview-config.ts`（键替换）、`server.ts`（预检、`officeOf`、`preparePreviewCache`、删 `stopWorkClear` 与 `preview_work_clear_failed`）、`preview/app.ts`（头注释）。
- 测试：新 `support/fake-sidecar.ts`、`converter-sidecar.test.ts`；重写 `office-converter.test.ts`；改接缝 `office-converter-output` / `office-queue` / `office-cache` / `office-cache-helpers` / `server-startup-office` / `preview-config` / `omp-max-processes-config`；删 `office-work-clear.test.ts`、`fixtures/fake-sudo-find.mjs`。
- CI：新 job + `.github/scripts/ci-office-sidecar.sh` + harness / `constraints.yaml ci:` / AGENTS Enforcement Index 合同（S2a，需 owner）。
- 文档：ADR-0010、ADR-0014、system.md、functional-checklist、CONTEXT.md、IMPLEMENTATION_PLAN.md。
- 部署：Docker 成为办公文档预览的前提；`OFFICE_BIN` → `OFFICE_SPOOL_DIR`；两行 sudoers 删除；详见 design「Migration Plan」。

## 流程记录

- 2026-10-13 grill（Q5/Q6/Q7/Q11）→ B1–B4；2026-10-16 owner 批准测试主机安装与实测 → B5；bubblewrap 两轮实测（容器缺省 / root+SYS_ADMIN / 裸机无 profile / 裸机有 profile / setuid 五档）；2026-10-16 owner B6（容器部署必须可用）；2026-10-17 owner B7（sidecar 单机制，采纳编排方推荐）。
- 编排方补充（2026-10-16）：真预检 / 假转换的测试分层；`runs-on: ubuntu-24.04`（现落在新 job 上，uid-isolation job 不动）；部署形态两列 → B6/B7 定为同一容器；裸机对照 (b) 无效、只引用容器对照与 issue 表。
- Stage 2 两次改稿：2026-10-16 行为级（机制开放）→ 2026-10-17 定稿（sidecar）。
