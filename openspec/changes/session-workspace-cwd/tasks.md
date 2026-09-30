# Tasks: session-workspace-cwd（#521）

## 2. chat-sessions — 空间绑定 cwd（父 tasks 2.2 原文）

- [ ] 2.2 `server/src/app.ts` + `server/src/sessions/index.ts` + `store.ts` + `supervisor.ts`（及 A 的 `turn-control.ts` 惰性获取处）：`cwd` 由可选改为必填，同刀按头部「增长例外」清单给既有夹具各补一行；`createWorkspaceStore` 移到 `registerSessions` 之前；`RegisterSessionsOptions.workspaceRootOf(ownerId, workspaceId)` 由 `app.ts` 以 `rootOf({id: ownerId}, workspaceId)` 包装注入；`store.runtimeState` 返回值增 `workspaceId`，由 supervisor 解析 cwd；`#dispatchNew`、regenerate 惰性获取、fork 临时进程统一计算 `cwd`：未绑定 → 所有者根；绑定 → `workspaceRootOf`：返回 null（不变量破坏：工作空间行已不存在）→ 通用失败（5xx 通用信封，非 502 信封）；返回路径但存在性检查失败（缺失或非目录）→ `agent_unavailable` 502；两支都不调用 `spawnOmp`、不创建目录、不回退所有者根，prompt 走既有受理对补偿。验证：新建 `server/test/session-workspace-cwd.test.ts`（supervisor + 真实 fake-omp）：绑定会话 probe `cwd=` 为空间根、未绑定为所有者根；闲置回收后再 prompt，首次与 resume 两次 spawn 的 argv `--cwd` 逐字相等且 probe `cwd=` 相同；空间根目录被删 → prompt 502 `agent_unavailable` 信封字节、未 spawn、目录未被重建、受理对已移除；`workspaceRootOf` 返回 null（删工作空间行后以注入桩保持绑定）→ 通用 5xx 信封字节、未 spawn、受理对已移除；同文件 createApp 级用例：经 production `createApp` 以 `POST /api/workspaces` 建 W → SQL 直写 `chat_sessions.workspace_id` 绑定（4.1 前无绑定路由）→ prompt → probe `cwd=` 为 W 根。既有断言改期望值：`session-store.test.ts:122-127`/`:150`/`:328` `runtimeState` 增 `workspaceId: null`；装配次序既有断言在 `server/test/server-assembly.test.ts:455-478`（order spy，仅在次序期望变化时改期望值），`server/test/app.test.ts`（790）只允许改期望值不增长

注：父任务行中「删工作空间行后以注入桩保持绑定」不可行（035 `ON DELETE SET NULL`），null 分支按 proposal「有意偏差」与 design 证据 4 以跨所有者绑定构造，不写桩；`session-store.test.ts` 三处期望的当前行号与 `omp-spawn-cwd.test.ts` 迁移见 design。A 拆分后 regenerate 惰性获取经 supervisor `#onSlot`/`#onNewSlot`（与 prompt 共用），fork 临时进程在 `branching.ts`，spawn 选项唯一组装点为 `pool.ts` 的 `sessionRuntimeOpts`；解析函数落新模块 `session-cwd.ts`（见 proposal Impact）。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `RegisterSessionsOptions.workspaceRootOf`、`cwd` 必填 → 证据 1、6、7 + typecheck |
| File IO / path safety / overwrite | yes | 空间根存在性检查、不 mkdir、不回退 → 证据 3、5 |
| Error handling / rollback / partial outputs | yes | null → 通用 5xx、缺失 → 502，均补偿、未 spawn、未占名额 → 证据 3、4、5 |
| Concurrency / shared state / ordering | yes | 同一会话各 generation cwd 一致、装配次序 → 证据 2、6、7 |
| Config / project setup | yes | `app.ts` 装配换序与注入 → 证据 6、7 |
| Legacy compatibility / examples | yes | 未绑定会话与既有夹具不变 → 证据 1、7 |
| Auth / permissions / secrets | no | 所有者作用域由既有 `rootOf` 保证，不新增授权面 |
| Resource limits / large input / discovery | no | 失败在 `pool.admit` 前，不占名额（证据 3 顺带断言） |
| Schema / columns / units / field names | no | 只读既有列 |
| Release / packaging / dependency compatibility | no | sudoers 尾 `*` 覆盖（D4） |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建的 `server/test/session-workspace-cwd.test.ts`（≤800 行）；既有测试只按「增长例外」清单补一行 `cwd` 或改期望值。
- [ ] RED 集合以 design「Required evidence」的划分为准：先在实现前跑红，再实现跑绿（记录命令与结果）；其余按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-workspace-cwd --strict --no-interactive` 通过。
