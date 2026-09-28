# Tasks: fork-session（#466）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.5 原文）

- [ ] 4.5 `turn-control.ts` + `store-branch.ts` fork：`fork(sessionId, ownerId, messageId)`——用户消息校验；源会话 running → 409；登记控制占用（记下预检读到的末条 assistant id）；先对源会话存活 idle 进程执行既有 retire（数据在文件里、无损）；新会话行（`parent_session_id`、title 复制；`status` = 拷贝历史中末条 assistant 消息的状态 done/failed/stopped，无历史时 `idle`）；临时 runtime 经 `#admitProcess` 以 `--resume` 原文件起、序号+文本对齐选 entryId、`branch`、`get_state`、关停临时进程；单事务先做 CAS 复核（源会话 status 非 running 且末条 assistant id 仍等于预检读到的 id，否则不写入、删除新会话行并 409 `session_busy`），再写新文件、拷贝分叉点前消息/步骤行与其 `chat_approvals` 行（保持 decision）；不一致回滚并 `agent_unavailable`。验证（新建测试文件，fake-omp `branch`）：原会话文件不动、新会话行与拷贝内容（含 approvals decision）、新会话 status 规则三态；cap=1 源进程存活时 fork → 201、源进程先于临时进程退出、全程活进程数 ≤1；临时进程计入上限（cap=1 时 fork 期间新 prompt 得 503）；RPC 间隙注入并发 prompt/regenerate → 409 且行与文件不变；「提交时 CAS 复核」（`get_state` 之后、提交之前由测试直接改写源会话末条 assistant 或 status → 409 `session_busy`、新会话行被删除、源会话行与文件不变）
  - 本刀落实（见 proposal「偏离与决定」）：
    - 新会话行在 CAS 事务内插入，「删除新会话行」改为「不留下新会话行」（偏离 1）；
    - 编排落在 `branching.ts`（偏离 2）；
    - 「201」为 supervisor 兑现 `{session, draft}`，REST 归 #469。
  - 验证：design R1–R10、F1–F13、G1。
- [ ] （本 fixture 追加，非父 tasks 原文，见 proposal 偏离 2）前置纯移动，独立首个 commit：
  - `Regenerations` 簇（`turn-control.ts:204-363`）移入 `branching.ts`；
  - `SessionRuntimeOpts` 组装（`supervisor.ts:392-415`）抽成 `pool.ts` 的 `sessionRuntimeOpts`。
  - 验证：既有测试零 diff 全绿；`git diff --color-moved` 只含移动块与 design 所列替换；`turn-control.ts` ≤290、`supervisor.ts` ≤760。
- [ ] （carry-forward :95，#465 延后）regenerate 各 RPC 间隙注入 fork → 409 `session_busy`；验证：design R4。
- [ ] （carry-forward :100，#622 评审项；守卫的如实定位见 design (d)）：
  - fork 提交段的 liveness 守卫（关停前、与 `get_state` 续体同段）；
  - 源 slot 由 `retireSource` 在占用同段无条件 retire，不改 `#onProcessExit`；
  - `during` 同步抛错释放占用；事务中途故障整体回滚。
  - 验证：design F1、R9、R8、F4。
- [ ] （本 fixture 追加，见 design (e)(f)）：
  - 临时进程在每条路径都关停、释放名额、撤销 token；
  - `shutdown()` 在等待 admissions 前经 `Forks.close()` 关停在途临时进程；
  - 准入后与关停后各复查一次 `closed()`；
  - 临时 token 只 issue 一次，子进程死后不惰性重 spawn。
  - 验证：design F9、F6、F11、F10、R10。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionSupervisor.fork`、`SessionStore.commitFork` 新增；`controlHeld` 语义含 fork → R1、R7、R8；knip 零新增；`SessionSupervisorPort` 不变（#469） |
| Config / project setup | no | 无配置项；cap 语义沿用 #463 |
| File IO / path safety / overwrite | yes | 源会话文件只读、临时进程 `--resume` 源文件、新文件只写进新会话行 → R1（字节与 mtime 不变、新文件路径）、R6/F2（源文件与 `omp_session_file` 不变）、R1/F7 后续 `--resume <新文件>` |
| Schema / columns / units / field names | yes | 无 schema 变更；新会话行 `parent_session_id`/`stream_epoch=0`，显式列拷贝消息/步骤/审批（TEXT 字节原样）→ R1 逐字段比对、R2 三态、F4 回滚；守护 `migration-034.test.ts` |
| Auth / permissions / secrets | yes | owner 由 `getMessages(sessionId, ownerId)` 兜底（R7 他人 → `not_found`）；临时 token 键为新会话 id，fork 结束即撤销 → R1、R10、F13 `tokens.lookup(...) === null`（F13/M23 钉住 fork 自身的撤销）；REST 鉴权归 #469 |
| Concurrency / shared state / ordering | yes | 本刀核心：源先 retire 再准入、占用挡住源会话新请求、间隙注入、CAS 复核、shutdown 竞争 → R3、R4、R5、R9、F2、F3、F6、F9、F11；M5–M7、M11、M14、M18、M20、M22 |
| Resource limits / large input / discovery | yes | 临时进程计入上限、不可驱逐、每条路径释放名额、无 pid 失败释放 → F7、F8、F10、R10、G1；M12、M19、M21 |
| Legacy compatibility / examples | yes | regenerate/prompt/stop/池既有行为不变 → Sibling surfaces 全部零 diff；前置纯移动 commit 单独零 diff |
| Error handling / rollback / partial outputs | yes | 预检、RPC、liveness、关停后 closed、事务（CAS/存储故障/running 守卫）各段映射，失败零写入 → R6、R7、F1、F2、F4、F5、F6；占用每条路径释放 → 各例 `controlHeld === false` |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | `docs/architecture/system.md` 归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/{supervisor,turn-control,branching,store-branch,pool,store}.ts`（`branching.ts` 新建）。
  - `pool.ts` 只接受 `sessionRuntimeOpts` 抽取与 `temporaryTokens`，判定规则 `:131-162` 不动；
  - `store.ts` 只接受 `commitFork` 接线；
  - `omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`app.ts`、`store-approvals.ts`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] 模块边界：
  - 编排在 `branching.ts`，事务在 `store-branch.ts`，`supervisor.ts` 只接线；
  - `pool.ts`/`turn-control.ts`/`branching.ts` 不值导入 `./supervisor.js`；
  - `store-branch.ts` 不值导入 `store.ts`/`store-approvals.ts`（carry-forward :10）；
  - 值导入无环；不经 `sessions/index.ts` 导出新符号。
- [ ] 命令帧一律字面量（`{type:"branch",entryId}` 等），`get_state` 恒在 `branch` 之后；不展开任何外来对象（carry-forward :63）。
- [ ] 拷贝一律显式列 `INSERT … SELECT`（change B D14 将在其上追加 035 列）。
- [ ] 新测试只写进新建文件 `server/test/session-fork.test.ts`、`server/test/session-fork-faults.test.ts`、`server/test/session-fork-helpers.ts`，各 ≤800 行；不 import `pool.ts`/`turn-control.ts`/`branching.ts`/`store-branch.ts`，不访问私有字段。
- [ ] 既有测试允许的改动：**无**（design「Sibling surfaces」所列全部零 diff 全绿）。
- [ ] 红/绿：
  - R1–R10、F1–F13 在去掉对应机制时失败，记录失败输出；G1 为恒绿不变量；
  - M1–M24 逐一临时变异，确认对应用例变红，结果记入 PR body。
- [ ] 实测 `wc -l` 六个源文件与三个新测试文件，与 proposal Impact 对照，记入 PR body（`supervisor.ts` 起点 767，终点 ≤798）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate fork-session --strict --no-interactive` 通过。
- [ ] PR body：
  - 标注「Critical Path：请求白盒审查」；
  - 列出 proposal「偏离与决定」各条与 Open questions；
  - commit 1（纯移动）与 commit 2（功能）分开。
