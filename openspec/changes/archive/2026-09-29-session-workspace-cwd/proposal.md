# Proposal: session-workspace-cwd（#521）

## Why
父 change `s1c-session-metadata-presentation` tasks 2.2（epic #509，design D4「空间绑定 cwd：派发时解析空间根，缺失即失败」）。2.1（#513）让 `spawnOmp`/`SessionRuntime` 接受可选 `cwd`，但没有调用方传入，所有 spawn 仍以所有者根为 `--cwd`；1.1（#510）已加 `chat_sessions.workspace_id` 列；6.2（#520）让 fake-omp probe 回报 `cwd=`。本刀把「会话绑定 → spawn cwd」接通，并把 `cwd` 改为必填。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: omp 子进程治理 × 沙箱与文件边界（AGENTS.md Critical Paths）的交点——cwd 错一次就被写进会话文件头、此后 resume 不可改；mkdir 会重建被外部删除的空间目录；回退所有者根会把绑定会话永久钉在错误目录；app 装配次序变更；spawn 契约签名必填化波及既有夹具。
Selected risk packs: Public API / CLI / script entry（`RegisterSessionsOptions.workspaceRootOf`、`SpawnOmpOpts.cwd`/`SessionRuntimeOpts.cwd` 必填）；File IO / path safety / overwrite（空间根存在性检查、不 mkdir、不回退）；Error handling / rollback / partial outputs（null → 通用 5xx、缺失 → 502 `agent_unavailable`，两支均补偿且未 spawn、未占池名额）；Concurrency / shared state / ordering（同一会话各 generation cwd 一致、`createWorkspaceStore` 装配次序）；Config / project setup（`app.ts` 装配）；Legacy compatibility / examples（未绑定会话与既有夹具行为不变）
Evidence floor: 新建 `server/test/session-workspace-cwd.test.ts` 覆盖 design「Required evidence」；既有夹具只按「增长例外」清单补一行 `cwd` 或改期望值；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`（`supervisor.ts`/`store.ts`/`omp-process.test.ts`/`omp-runtime.test.ts` ≤800，`omp/runtime.ts`（798）净 ≤0，`app.test.ts` 不增长）退出 0。

## What Changes
- 新建 `server/src/sessions/session-cwd.ts`：唯一的 cwd 解析函数（未绑定 → 所有者根；绑定 → 注入的 `workspaceRootOf`；null → 通用 `Error`；非已存在目录 → `AgentUnavailableError`；不 mkdir、不回退）。
- `server/src/sessions/store.ts`：`runtimeState` 增 `workspaceId`（`chat_sessions.workspace_id`）。
- `server/src/sessions/index.ts`：`RegisterSessionsOptions.workspaceRootOf(ownerId, workspaceId): string | null`，转交 supervisor。
- `server/src/app.ts`：`createWorkspaceStore` 移到 `registerSessions` 之前（模块注册次序不变），以 `(ownerId, workspaceId) => store.rootOf({ id: ownerId }, workspaceId)` 注入。
- `server/src/sessions/supervisor.ts`（五刀接线之一）/`pool.ts`/`branching.ts`：prompt 与 regenerate 共用的 `#onNewSlot`、fork 临时进程两处在占用池名额与 claim 之前调用同一解析函数；`sessionRuntimeOpts` 的 `PerRuntime` 增必填 `cwd`。
- `server/src/sessions/omp/process.ts`/`runtime.ts`：`SpawnOmpOpts.cwd`、`SessionRuntimeOpts.cwd` 由可选改必填（去掉缺省）。
- 既有夹具按父 tasks「增长例外」清单各补一行 `cwd`；`session-store.test.ts` 三处 `runtimeState` 精确期望增 `workspaceId: null`。

## Capabilities
- MODIFIED `chat-sessions`「Supervisor dispatch and generation binding」：主 spec 加父 delta 中 2.2 的部分——首句「and workspace binding」、runtimeState `workspaceId` 与 cwd 解析六句、Scenario「Spawn cwd follows the workspace binding」。不含父 delta 同 Requirement 中的 delete 控制占用（4.3）、「removing a pre-created fork session row」（4.4）；父 delta 删去的 regenerate/fork 失败映射两句是父相对 main 的漂移，本刀保留 main 原文。
- MODIFIED `chat-sessions`「Session module registration and teardown」：只并入 `rootOf` 注入与「不自建第二个工作空间 store、不自算根」；`agentDir`（组 10）不并入。
- MODIFIED `omp-runtime`「子进程 spawn 契约」：父 delta 全文，唯独去掉「fork 新会话继承源会话 `workspace_id`，故其后续进程与源会话同根」（4.4）。
- MODIFIED `http-service-skeleton`「Shared agent module assembly」：并入 createApp 先建同一工作空间 store 并注入 `rootOf` 两句与 Scenario「会话与工作空间共用同一 store」；父 delta 在默认值 Scenario 中的「reasoning switch defaulting to on」（1.2）不并入。
- ADDED `session-metadata`（新能力，含父 Purpose）「绑定不可改与工作目录」：父 delta 全文，唯独去掉「`PATCH /api/sessions/:id` 携带 `workspaceId` 键 SHALL 作为多余键 400」一句与 Scenario「PATCH 不能改绑定」（4.2）。

## Impact
- server：上列 src 与一个新测试文件、一个新 src 模块；既有夹具一行补键/期望值。不触碰 web、`http/errors.ts`、迁移文件。本刀之后，经 REST 绑定（4.1）之前，绑定只能由 SQL 直写构造；生产行为对所有既有会话（`workspace_id` 全为 NULL）不变。
- 与 issue PR Boundary 的偏差：新增 `session-cwd.ts`（`supervisor.ts` 现 792 行，解析逻辑不能落在其中）；`pool.ts` 的 `sessionRuntimeOpts` 与 `branching.ts` 的 fork 临时进程是 A 拆出后的实际 spawn 组装点（issue 写作「A 的 `turn-control.ts`」）。

## 与 spec/issue 的有意偏差（留痕）
- `rootOf` 对「存在但不是目录/含 symlink」的根是抛错而非返回路径；为兑现「缺失或不是目录 → 502」，`session-cwd.ts` 把 `workspaceRootOf` 的抛错一律映射为 `agent_unavailable`。副作用：`rootOf` 那条 SELECT 的 SQLite 故障也呈现为 502——chat-sessions「storage faults remain generic」的一处窄例外，只作用于空间根解析。
- issue 的 null 分支构造（删工作空间行后以桩保持绑定）与 035 的 `ON DELETE SET NULL` 矛盾，改为跨所有者绑定让真实 `rootOf` 返回 null。
- `server/test/omp-spawn-cwd.test.ts`（2.1 的缺省行为测试）需要超出「一行」的迁移：删除描述已不存在缺省的一个用例、两个用例改为断言显式所有者根（design 列明）。

## Non-goals
- REST 绑定（4.1）、PATCH 拒绝改绑（4.2）、fork 继承 `workspace_id`（4.4）、`files.changed` 归属（3.4）、空间目录丢失后的修复路径。
