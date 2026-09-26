# Tasks: omp-approval-recognition（#460）

## 2. 审批请求识别与 respondApproval（父 tasks 2.1a 原文）

- [ ] 2.1a `process.ts`/`ui-requests.ts` 审批请求识别与 `respondApproval`：`extension_ui_request` 中 `method==="select"` + options 恰为 `["Approve","Deny"]` + title 前缀 `Allow tool: ` 抛给 owner（不自动应答，**不加** runtime 兜底 Deny——omp-runtime spec 规定 transport 不自行作答）；其余 UI 请求仍即时 `cancelled`；`respondApproval(requestId, "Approve"|"Deny")` 写 `extension_ui_response`。生产 argv 仍为 `yolo`，故该分支在生产不可达。验证：新建帧层测试文件，经测试侧 argv 注入（`yolo`→`write`）对 fake-omp `approval` 场景断言未自动应答、`respondApproval` 后 probe `frames=` 含 `extension_ui_response`；对 `confirm` 类 UI 请求仍 `cancelled`

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `OmpProcess` 新公开方法 `respondApproval` 与 `approval` 事件（owner 契约）→ E1–E4、E7 |
| Schema / columns / units / field names | yes | 载荷 `{id,title,tool}` 与应答帧 `value:"Approve"\|"Deny"` / `cancelled:true` 逐字形状 → E1–E6 `toEqual` 精确比较 |
| Auth / permissions / secrets | yes | 审批是 exec 工具的权限闸门：误判即静默拒绝或绕过；spawn env/凭证边界（ADR-0010）不变，argv 替换仅在测试侧 → E1、E6、E8、E9；`process.ts:63-121` 零 diff |
| Concurrency / shared state / ordering | yes | `frame`→`approval` 次序、每 id 至多一帧、同步写出（#473 的 Deny 先于 abort 依赖它）、abort 挂起期间不作答、退出与应答竞争 → E1、E2、E3、E7、E11、E12（写出次序） |
| Legacy compatibility / examples | yes | 非审批 UI 回绝、缺 id、死后不写、`frame` 事件照发、argv 仍 `yolo` → E5、E6、E7 + 既有测试零改动全绿 |
| Error handling / rollback / partial outputs | yes | retire/关停/退出后应答不写、不抛、不触发 transport 错误；transport 在超时、停止、retire、关停、退出时都不自行作答 → E7、E8、E9、E10、E11 |
| Config / project setup | no | 无配置项；argv 切换归 #481 |
| File IO / path safety / overwrite | no | 不涉文件（probe 写入 tmp 属 fake 既有行为） |
| Resource limits / large input / discovery | no | outstanding 集合随 writes 关闭清空，寿命不超过子进程；帧大小上限不变 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：新建 `server/src/sessions/omp/ui-requests.ts` + 改 `process.ts`；`runtime.ts`、`commands.ts`、supervisor、store、`server/test/support/fake-omp.mjs`、既有测试与 helper 零 diff。
- [ ] 新测试只写进一个新建文件（建议 `server/test/omp-approval-requests.test.ts`）；argv `yolo`→`write` 与 stdin 记录在该文件内包装 `createRealFakeRuntime(...).runtime.spawnImpl` 完成，不改 `session-supervisor-helpers.ts`。
- [ ] 既有测试允许的改动：**无**（design「Sibling surfaces」已逐一核对）；既有 process/runtime/rpc 测试不改动全绿。
- [ ] 红/绿：E1–E4、E7–E9、E11、E12 在未改源码时失败（记录失败输出：无 `approval` 事件 / stdin 出现 `cancelled:true` / `respondApproval` 不存在）；E5、E6、E10 以及 E7 末项为守护，恒绿。
- [ ] 实测并在 PR body 记录 `wc -l server/src/sessions/omp/process.ts server/src/sessions/omp/ui-requests.ts`，与 proposal Impact 估算对照。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`（新测试文件同样 ≤800 行）、knip 零新增 退出 0；`openspec validate omp-approval-recognition --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」。
