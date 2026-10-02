# Proposal: session-meta-smoke（#539，父 change `s1c-session-metadata-presentation` tasks 8.1）

## Why
会话创建绑定、PATCH、DELETE、`session.bind` / `session.delete` 审计与 `thinking` 落库都已合入，但它们在真 omp v18.0.10 下没有任何 HTTP 端到端证据：`make smoke` 只跑 public/auth/chat/files 四个文件，`chat.hurl` 用的是未绑定会话且不断言 `thinking`。

## What Changes
- 新建 `smoke/session-meta.hurl`：独立登录 → 创建或采用工作空间 `smoke-sessions` → 绑定创建（八键 + `session.bind` 审计）→ 未知空间 404 / 多余键 400（无审计行）→ 无 body 创建 → PATCH title/scene/pinned 与多余键 400、列表反映、取消置顶 → `WORKBUDDY_THINK` prompt、作答唯一 bash 审批、done → `thinking` 逐字断言与标题未被覆盖 → DELETE 204 + `session.delete` 审计、删除后 404 → `lisi` 的三种越权 404 → 清理。
- `Makefile` `smoke` 配方在 `smoke/files.hurl` 之后追加一个参数 `smoke/session-meta.hurl`。
- `AGENTS.md` Verification Matrix 的 `HTTP smoke` 行四文件改五文件。
- `scripts/test-ci-harness.sh`：`contract()` 基线的 smoke 配方串与 HTTP smoke 证据行、所有查找/替换串含旧配方文件列表或旧证据行的既有变异同步；新增四条拒绝变异。
- 规格：chat-harness MODIFIED「手动真实上游冒烟入口」+ ADDED「会话元数据 HTTP 冒烟」；thinking-fold ADDED「reasoning 前提与真运行时取证」；files-harness、verification-harness、omp-uid-isolation 五条 Requirement 里「四文件」的现状句改为五文件。

## Non-goals
- 父文第 6 步（`GET /api/commands`、`/todo`、转义的 `/session …`）：归 #557（父 tasks 10.6）。
- 删除 running 会话的路径（服务端集成测试已证明）、`MODEL_REASONING` 开关与真实模型 reasoning（#544，`smoke-live`）、ui-walk（#540/#541）。
- `smoke-live` 配方、`smoke/chat.hurl` 与 public/auth/files 三文件、CI workflow、任何 server/web 源码：零 diff。新增 Make 目标、Hurl 变量、CI job 或 env：无。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **ADDED「会话元数据 HTTP 冒烟」不含父文第 6 步**：`session-meta.hurl` 在本刀不执行 slash 白名单步骤（issue 明确其由 10.6 追加），子 delta 删去该步与两个 Scenario 里的对应子句，其后两步顺延为 6、7。#557 的 delta 须把它插回并恢复父文编号。
2. **审计断言比父文多钉三处**：父文只要求最新审计的 `kind`（与 `actorId`）。只看 `kind` 时，上一轮 `make smoke` 留下的同类事件也能满足（同一个库连跑两遍）。子 delta 加 `detail.sessionId` 等于本次捕获的 `session_id`（绑定后、两次被拒创建后、删除后各一处），绑定事件另加 `workspaceId`。字段来自 `server/src/sessions/store-metadata.ts:97-103`、`:154-160`。
3. **另外三个 capability 的五条 Requirement 被修改**（父 delta 没有）：主规格里有规范句把 `make smoke` 钉为四文件——files-harness「沙箱夹具与 files.hurl」「控制面与 oracle 同步」、verification-harness「HTTP smoke（hurl）」「CI 接线与控制面同步」、omp-uid-isolation「CI uid-isolation job」。追加第五个文件后它们不再成立，子 delta 逐条整段重述，只改文件数与文件清单（verification-harness 的 Scenario「文件控制面反映已执行四文件」随之更名为「…五文件」）。omp-uid-isolation「已证明 UID 门禁关闭同 uid 降级」里的 `four-file smoke` 是对历史 run 的陈述，不改；`docs/acceptance/demo-parity-checklist.md:300` 的「四文件 38 请求」是历史验收记录，不改。
4. **thinking-fold「reasoning 前提与真运行时取证」整条在本刀并入主规格**：issue 只点名其 Scenario「真 omp 帧到达」。该 Requirement 此前没有随任何子 change 归档；它的前提段（#511 的 `models.yml` 声明、#528 的假上游标记）在 master 上已成立，取证段靠本刀的文件成立，所以整条逐字并入。
5. **「四条新变异先 FAIL、后 PASS」的含义**：oracle 精确钉配方，基线更新之后任何偏离都会被拒。四条里只有「遗漏」在旧基线下不被拒（遗漏后的候选正是旧基线本身）；另外三条在新旧基线下都被拒。所以 RED 记录按阶段如实写（design D4），不把「查找串不存在导致 `ed` 退出 2」说成「缺失断言」。
6. **既有变异标签不改名**：`contract Make smoke four-file order mutation` 的名字在五文件之后不再贴切；issue 要求按标签锚定同步，本刀只改它的查找/替换串，不改标签。
7. **CI 的 smoke job 每次只跑一遍 `make smoke`**（`.github/scripts/ci-compiled-server.sh:113`，全新 DB）：父文「`make smoke` runs twice」「第二遍在已采用的空间上通过」由本地取证（同一 DB 与沙箱连跑两遍），CI 证明的是首跑（201）路径。

## Impact
- 新文件 `smoke/session-meta.hurl`；`Makefile` 一个参数；`AGENTS.md` 一行；`scripts/test-ci-harness.sh` 多处查找/替换串与四条新变异。
- CI：`smoke` 与 `uid-isolation` 两个 job 的 `make smoke` 各多跑一个文件（一个绑定工作空间的真实回合，含一次审批）；`uid-isolation` 是第一次在 `OMP_USER=omp` 下跑绑定空间的回合（omp 进程的工作目录是空间根）。
- 主规格：chat-harness、thinking-fold、files-harness、verification-harness、omp-uid-isolation。
