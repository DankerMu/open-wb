# Tasks: runtime-exit-pending（#462）

## 2. omp-runtime — 命令面与退出上报（父 tasks 2.2a 原文）

- [ ] 2.2a `runtime.ts`/`commands.ts`：`onExit` 恒接线到 owner（空闲/崩溃/retire/驱逐/关停全部上报恰一次）；审批挂起时 `markPending(approvalId)/clearPending(approvalId)` 暂停/恢复空闲计时（按 `approvalId` 为键的集合，重复调用无副作用；集合非空即暂停、清空后恢复）。验证（新建测试文件，真实 fake-omp 子进程 + 可注入时钟）：挂起期不回收、结算后按原 idle 回收；两条同时 pending，结算一条不恢复、最后一条结算后恢复；同一 `approvalId` 重复 mark/clear 无副作用；五种退出路径各上报恰一次
- [ ] （编排者追加，非父 tasks 原文，见 proposal「偏离与决定」1）`runtime.ts` 审批转接：
  - 构造选项 `onApproval(request)` 只转发当前 generation 上活跃回合（`prompt` 帧已写出）的 `OmpProcess` `approval` 事件，闸门与 `#onFrame` 相同，其余丢弃，且不自动 `markPending`。
  - `respondApproval(id, "allow"|"deny")` 同步透传给当前 generation 的 `OmpProcess`，没有当前 generation 时为空操作。
  - 验证：design F1–F6、G1–G2。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionRuntime` 新增 `markPending`/`clearPending`/`respondApproval` 与 `onApproval` 选项；`onExit` 从「仅活跃回合」扩为恒接线 → X1–X9、P1–P5、F1–F6 |
| Schema / columns / units / field names | yes | `onExit` 载荷 `{code, signal}` 形状不变，且等于 Node 观察值；`onApproval` 载荷 `{id,title,tool}` 原样透传；应答帧 `value:"Approve"` → X 系列比对 `observeChild().exit`，F1/F4 用 `toEqual` |
| Auth / permissions / secrets | yes | token 撤销先于 `onExit`（凭证寿命）；审批是 exec 工具的权限闸门，runtime 不得替 owner 作答，也不得把终态或过期代的审批交给 owner → X 系列调用时快照、F2、F3、F5、F6、G1、G2 |
| Concurrency / shared state / ordering | yes | 每代恰一次、撤销后回调；generation/回合闸门；pending 集合与空闲定时器的交错（活动不重装、缺席 clear 不重置）；同步透传次序（#473 依赖）→ X9、P3、P4、F2、F3、F4 |
| Resource limits / large input / discovery | yes | pending 暂停若泄漏会让进程永不回收，靠集合随 generation 丢弃兜底；`onExit` 是 #463 名额释放的唯一信号，漏报即泄漏名额 → P5、X1–X9 |
| Legacy compatibility / examples | yes | `onExit(exit)` 签名不变；supervisor、app 回退 runtime、helpers 不传新回调时行为不变；#460 E9 依赖「不自动挂起」→ 既有测试零改动全绿、F6 |
| Error handling / rollback / partial outputs | yes | 从未取得 pid 的启动失败不回调，取得 pid 后的启动失败回调一次；retire 中与关停后作答不写、不抛 → X7、X8、F5 |
| Config / project setup | no | 无配置项；`OMP_IDLE_MS` 语义不变 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/omp/runtime.ts` 与 `commands.ts`。`process.ts`、`ui-requests.ts`、`supervisor.ts`、store、`app.ts`、`server/test/support/fake-omp*.mjs`、全部既有测试与 helper 零 diff。
- [ ] `runtime.ts` 以语句级 `import type { ApprovalDecision, ApprovalRequest } from "./ui-requests.js"` 引入类型，不写行内 `type` 修饰。`runtime.ts`/`commands.ts` 中不得出现 `extension_ui_response` 字面量，注释里也不行（#460 E10）。
- [ ] 新测试只写进一个新建文件（建议 `server/test/omp-runtime-exit-pending.test.ts`），≤800 行。`yolo→write` 替换与 stdin 记录在该文件内包装 `createRealFakeRuntime(...).runtime.spawnImpl` 完成，不改 `session-supervisor-helpers.ts`（它不做替换）。FakeChild 世界在该文件内搭建，照 `omp-runtime-io.test.ts:319-380`。
- [ ] 既有测试允许的改动：**无**（design「Sibling surfaces」已逐一核对）。runtime、process、rpc、dispatch、supervisor 的既有测试不改动全绿。
- [ ] 红/绿：X1–X3、X5、X6、X8、X9、P1–P5、F1、F4–F6，以及 F2/F3 的正对照项，在未改源码时失败，记录失败输出（`exits` 缺失，`markPending`/`respondApproval` 不是函数，未转接）。X4、X7、G1、G2 为守护，恒绿。F2/F3 的丢弃项按 design.md 的变异矩阵 M1–M3 做检查（按语义谓词，不按单个子条件），确认对应用例变红，结果记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/omp/runtime.ts server/src/sessions/omp/commands.ts <新测试文件>`，与 proposal Impact 估算对照，记入 PR body。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate runtime-exit-pending --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，并列出 proposal「偏离与决定」各条。
