# Tasks: regenerate-turn（#465）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.4 原文）

- [ ] 4.4 `turn-control.ts` + `store-branch.ts` 重新生成：`regenerate(sessionId, ownerId)`——前置形态校验通过即登记控制占用（持有到派发完成/响应返回）；经与 prompt 相同的懒 spawn 路径取得**正常 generation**（进程已回收时 epoch+1、建 ring，计入池）；`get_branch_messages` 末项 text 与 SQLite 末条用户消息相等（否则 `agent_unavailable`）、`branch`、`get_state` 新文件；单事务 CAS 复核（`status` 非 running 且末条 assistant id 等于预检读到的 id，否则 409 `session_busy` 并 retire 该进程）后删旧助手行/插新 running 行/更新 `omp_session_file`、以 text 派发。验证（新建测试文件，fake-omp `branch`）：历史只剩新回答且新文件路径落库；进程已回收后 regenerate 时 `streamCursor.epoch` 为旧值+1、SSE 收到 `turn.start`→`turn.end`；在每个 RPC 间隙（get_branch_messages/branch/get_state 之后）注入并发 prompt/regenerate/fork → 409 `session_busy` 且行与会话文件不变；regenerate 删旧助手行后其 `chat_approvals` 行不存在（tool-approval「级联删除」）；「branch 后提交前失败 retire + 502」
- [ ] （本 fixture 追加，非父 tasks 原文，见 proposal「偏离与决定」1）前置纯移动：`ReadmissionRequired`、`#adapter`、`#releaseDispatch`/`#releasePump`/`#sealGeneration` 从 `supervisor.ts` 移入 `pool.ts`，独立首个 commit；验证：既有测试零 diff 全绿、`git diff --color-moved` 只含移动块与 design 所列替换、`supervisor.ts` ≤705
- [ ] （#473 移交，issue「In Scope 补充」）stop 在调用期间持有控制占用、永不因占用 409；验证：design R8(a)(b)(c)
- [ ] （本 fixture 追加，见 design 步骤 2(a)）首个命令新取得 generation 时恰一次 `releaseDispatch`；空闲回收窗口 `ReadmissionRequired` 只从首个命令浮出一次，`#onProcessExit` 在占用期间不退役 slot；验证：design F7、R9、F2(a)(b)
- [ ] （fixture 评审第 1 轮追加，见 design 执行序 (d)）提交段先查 `#closed`，按提交前失败处理：retire，行与文件不动；`acceptRegenerate` 的非 `HttpError` 映射为 `agent_unavailable`，CAS 未命中为 `session_busy`；验证：design R10/M15、R5/M16
- [ ] （carry-forward :83）提交后派发失败 `finishTurn(newId,"failed",settled)` 并经 `approvals.settled` 路由；验证：design F6

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionSupervisor` 新增 `regenerate`/`controlHeld`；`stop` 语义加占用；`SessionStore` 新方法 → R1–R8、F1–F7；knip 零新增 |
| Config / project setup | no | 无配置项；cap 语义沿用 #463 |
| File IO / path safety / overwrite | yes | `omp_session_file` 仅在 CAS 事务内换成 `get_state` 回报的新路径，提交前任何失败不改 → R1（新路径落库）、R4/R5/F2（原路径保留、`--resume <P>`）、R1 后续 `--resume <新文件>` |
| Schema / columns / units / field names | yes | 无 schema 变更，但删行依赖 `chat_steps`/`chat_approvals` 的 `ON DELETE CASCADE` → R1 断言步骤与审批行为 0；守护 `migration-034.test.ts:449-453` |
| Auth / permissions / secrets | no | owner 由 `getMessages(sessionId, ownerId)` 兜底（R7 他人 → `not_found`）；鉴权与 REST 归 #467；token 签发次序不变 |
| Concurrency / shared state / ordering | yes | 本刀核心：占用计数、RPC 间隙注入、CAS 与派发同一同步段、stop 意图 → R3、R6、R8、F3、F5；M1–M9 |
| Resource limits / large input / discovery | yes | 占用期间不可驱逐、池满 503 无行变更、关停后无残留 → F3、F4、G 关停（`liveProcessCount() === 0`） |
| Legacy compatibility / examples | yes | prompt/stop/意图/准入既有行为不变 → Sibling surfaces 全部零 diff；前置纯移动 commit 单独零 diff |
| Error handling / rollback / partial outputs | yes | 预检、提交前、提交后三段失败映射与「不复活旧行」→ R4、R5、R6、R7、F1、F2、F6；占用每条路径释放 → 各例 `controlHeld === false` |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | `docs/architecture/system.md` 归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/{supervisor,turn-control,store-branch,pool,store}.ts`；`pool.ts` 只接受前置纯移动（偏离 1），`store.ts` 只接受 Turn 登记接线与 `openTurn` 抽取（偏离 2）。`omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`app.ts`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] 模块边界：编排在 `turn-control.ts`，CAS 在 `store-branch.ts`，`supervisor.ts` 只接线；`pool.ts`/`turn-control.ts` 不值导入 `./supervisor.js`；`store-branch.ts` 不值导入 `store.ts`/`store-approvals.ts`；值导入无环；不经 `sessions/index.ts` 导出新符号。
- [ ] 命令帧一律字面量（`{type:"branch",entryId}` 等），`get_state` 恒在 `branch` 之后；不展开任何外来对象（carry-forward :63）。
- [ ] 新测试只写进新建文件 `server/test/session-regenerate.test.ts`、`server/test/session-regenerate-faults.test.ts`、`server/test/session-regenerate-helpers.ts`，各 ≤800 行；不 import `pool.ts`/`turn-control.ts`，不访问私有字段。
- [ ] 延后义务已由编排者写入 `.workplans/epic-448/carry-forward.md`，本刀不另行处理：
  - fork 注入 regenerate 各间隙；
  - spawn 契约句的 fork 一半；
  - omp-pool「上限恒成立」并发版与「进程退出即释放名额」的路径枚举；
  - #467 的合并措辞；
  - 父 delta 对本 fixture 自写部分的采纳。
- [ ] 既有测试允许的改动：**无**（design「Sibling surfaces」所列全部零 diff 全绿）。
- [ ] 红/绿：R1–R10、F1–F7 在去掉对应机制时失败并记录失败输出；G 项恒绿；M1–M16 逐一临时变异确认对应用例变红，结果记入 PR body。
- [ ] 实测 `wc -l` 五个源文件与三个新测试文件，与 proposal Impact 对照记入 PR body（`supervisor.ts` 起点 785，终点 ≤798）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate regenerate-turn --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions；commit 1（纯移动）与 commit 2（功能）分开。
