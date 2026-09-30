# Design: session-workspace-cwd（#521）

父设计：D4「空间绑定 cwd：派发时解析空间根，缺失即失败」（两支失败、不可变、sudo 模式、为什么注入 `rootOf`）；tasks.md 头部「增长例外」2.2 条与「服务端集成测试经 `spawnImpl` 注入点」。行号为 origin/master。

- **Change surface**：
  - 新建 `server/src/sessions/session-cwd.ts`。
  - `server/src/sessions/store.ts`：`SessionRuntimeState`（:95-100）、`RuntimeDbRow`、`runtimeState`（:600-615，SQL 增 `workspace_id`）。`#prompt` 读取 `runtimeState` 在 `supervisor.ts:338`。
  - `server/src/sessions/index.ts`：`RegisterSessionsOptions`（:15-33）增 `workspaceRootOf`，`new SessionSupervisor`（:46-53）转交。
  - `server/src/app.ts`：`registerSessions`（:154-161）与 `createWorkspaceStore`（:163-167）换序并注入。
  - `server/src/sessions/supervisor.ts`：`SessionSupervisorOptions`（:72 起）增 `workspaceRootOf`；构造器建解析器并交给 `Forks` 端口；`#onSlot`（:387-411）/`#onNewSlot`（:415-472）改收 `resume` 对象并在最前解析 cwd。
  - `server/src/sessions/pool.ts`：`PerRuntime`（:174-177）增必填 `cwd`，`sessionRuntimeOpts`（:182-208）透传。
  - `server/src/sessions/branching.ts`：`Resume`（:24）增 `workspaceId`；`ForkPorts`（:159）增 `cwdOf`；fork `#precheck`（:215-）把 `workspaceId` 放进 plan；临时进程（:250-270）在 `pool.admit` 之前解析 cwd 并传入。
  - `server/src/sessions/omp/process.ts`（:38-39、:62）与 `omp/runtime.ts`（:69、:115、:148、:435）：`cwd` 必填，去掉 `?? ownerRoot` 缺省与条件展开。
  - 测试：新建 `server/test/session-workspace-cwd.test.ts`；既有夹具见下。
- **Must preserve**：
  - 未绑定会话（`workspace_id` NULL，含全部 035 前旧行）的 argv、env、目录准备与 probe `cwd=` 逐字不变（所有者根，`ensureSharedDir` 只对所有者根）。
  - spawn 契约唯一组装点仍是 `pool.ts` 的 `sessionRuntimeOpts`；不出现第二套 argv/env 组装。
  - 获取失败的既有补偿：prompt 受理对移除与状态复原、`#translate` 把 `AgentUnavailableError` 译为 502 `agent_unavailable`、非 typed 错误保持通用 5xx provenance；regenerate/fork 的既有失败映射不变。
  - 模块注册次序 model-proxy → sessions → workspaces → accounts 不变（`server-assembly.test.ts:452-478` 的 `spyRegistrationOrder` 只 spy `register*`，移动 `createWorkspaceStore` 不改变被 spy 的次序）；sessions 不 import `workspaces/`、不自建第二个工作空间 store、不自算根。
  - `supervisor.ts` ≤800（现 792）；`omp/runtime.ts` 现 798，本刀四处改动须净 ≤0 行；若 `supervisor.ts` 超出，把与本刀无关的纯函数（如 `#translate` 的等价模块级函数）原样移到既有 `supervisor-faults.ts`，不改行为，PR 记录。
- **Must add/change**：
  - `session-cwd.ts` 导出唯一解析器工厂：
    ```ts
    export type WorkspaceRootOf = (ownerId: string, workspaceId: string) => string | null;
    export function sessionCwdResolver(sandboxRoot: string, workspaceRootOf: WorkspaceRootOf) {
      return (ownerId: string, workspaceId: string | null): string => {
        if (workspaceId === null) return join(sandboxRoot, ownerId);
        let root: string | null;
        try {
          root = workspaceRootOf(ownerId, workspaceId);
        } catch {
          // rootOf throws when the root exists but is not a plain directory (file, symlink, unsafe path)
          throw new AgentUnavailableError("session workspace root is unusable");
        }
        if (root === null) throw new Error("session workspace root is unresolvable"); // generic 5xx
        if (!isDirectory(root)) throw new AgentUnavailableError("session workspace root is missing");
        return root;
      };
    }
    ```
    `isDirectory` = `statSync(root)` 成功且 `isDirectory()`（stat 抛错即 false）。注意 `rootOf` 自身的路径语义（`workspaces/store.ts:212-224` `computeSafeRoot`）：路径不存在时返回路径（→ 本函数 stat 失败 → 502）；路径存在但不是目录（被同名文件占据）或任一分量为 symlink/不安全时**抛错**而非返回——该抛错在本函数内捕获并映射为 `AgentUnavailableError`（502），与 spec「缺失或不是目录 → 502」一致。代价：`rootOf` 内那条 `SELECT`（`ROOT_OF_SQL`）若发生 SQLite 故障，也会呈现为 502 而非通用 5xx（偏离 chat-sessions「storage faults remain generic」的一处窄例外，proposal 记录）；不以错误 message/code 区分两类抛错。不 mkdir、不回退、不记录目录内容。通用错误消息不含路径（避免泄露到日志之外的信封；信封本身由既有 5xx 处理为通用文案）。
  - 解析时机：prompt 与 regenerate 共用的 `#onNewSlot` 在 **claim 登记与 `pool.admit` 之前**解析（失败时无需 unclaim/释放名额，也不驱逐其它会话的空闲进程）；fork 临时进程在 `pool.admit` 之前解析。复用现存 live slot 的路径（`#onSlot` 命中 live）不重新解析——该进程已以同一 cwd 运行。
  - `runtimeState` 返回 `{ownerId, ompSessionFile, streamEpoch, activeTurn, workspaceId}`；`workspaceId` 取列值（TEXT 或 NULL），不返回 cwd。`#prompt`（`supervisor.ts:338`）与 `Regenerations` 的 `plan.resume`（`branching.ts:69`）、fork 的 `resume`（`branching.ts:218`）都来自它，类型随之携带 `workspaceId`。
  - `app.ts`：
    ```ts
    const store = createWorkspaceStore(db, { sandboxRoot: runtime.sandboxRoot, ensureSharedDir, emit });
    const registered = registerSessions(app, { …, workspaceRootOf: (ownerId, workspaceId) => store.rootOf({ id: ownerId }, workspaceId) });
    ```
    `registerWorkspaces` 等其余调用位置与参数不变。
  - `cwd` 必填：`SpawnOmpOpts.cwd: string`、`SessionRuntimeOpts.cwd: string`；`process.ts` 用 `opts.cwd`，所有者根判定 `resolve(cwd) === resolve(ownerRoot)` 时才 `ensureSharedDir`（2.1 既有）。
  - 既有夹具（父 tasks「增长例外」清单，每处一行 `cwd`，值等于该夹具的所有者根 `join(sandboxRoot, ownerId)` 以保持既有断言）：`server/test/omp-process.test.ts:506-516`（`optsOf`，≤800，现 791）、`server/test/sudo-launcher.test.ts:43-51`、`server/test/support/omp-rpc.ts:68-76`（`tempOpts`，经展开扇出到 `omp-rpc*`/`omp-dispatch*`/`omp-runtime-io`/`session-supervisor-helpers.ts`）、`server/test/omp-runtime.test.ts:620`（经 `...temp` 继承；类型需要时显式一行，≤800，现 790）、`server/test/linux/uid-isolation.test.ts:70-79`、`:99-108`。期望值：`server/test/session-store.test.ts:131-136`、`:159-164`、`:337-342`（父 tasks 所记 `:122-127`/`:150`/`:328` 的当前位置）的 `runtimeState` 精确 `toEqual` 各增 `workspaceId: null`。`server/test/omp-spawn-cwd.test.ts`（2.1 的测试，断言可选 `cwd` 的缺省行为——本刀删除该缺省）按下列方式迁移，不属于「一行」：`spawnOpts`（:83-95）与 `firstSpawn`（:267-278）的 `cwd` 参数缺省值改为 `roots.ownerRoot` 并无条件传入；`:140`、`:167` 两个用例改标题并改为断言「显式传入所有者根」的同一行为；`:296`「falls back to the owner root when no cwd is given」删除（该行为已不存在，且与 `:287` 重复）；PR 记录该文件行数变化。已知清单外需补一行 `cwd`（literal 构造或经 `...real.runtime` 展开、不含 `cwd`）：`omp-approval-requests.test.ts:117`、`:411`，`omp-runtime-abort-start.test.ts:78`，`omp-runtime-commands.test.ts:107`，`omp-runtime-exit-pending.test.ts:99`，`omp-spawn-gate.test.ts:112`。`server/test/app.test.ts` 只允许改期望值、不增长。清单外若有文件需补 `cwd`（以 `make typecheck` 为准），同样只允许一行并在 PR 列出。
- **Sibling surfaces**：`omp-uid-isolation`（sudo 模式）：`--cwd` 变深，sudoers 行尾 `*` 覆盖（D4）；CI `uid-isolation` job 只跑 `server/test/linux/uid-isolation.test.ts`，本刀只给它补两行 `cwd`。`workspaces/store.ts` 的 `rootOf` 签名与语义不变。`model-proxy`、web 不涉。
- **Required evidence**（`server/test/session-workspace-cwd.test.ts`；supervisor + 真实 fake-omp 子进程，probe 回报末字段 `cwd=`（6.2）；绑定由 SQL 直写 `chat_sessions.workspace_id` 构造（4.1 前无绑定路由），工作空间行与目录由真实工作空间 store 或 `POST /api/workspaces` 建立。RED：证据 1、3、4、5、6 与证据 2 的绑定半在实现前红（cwd 恒为所有者根 / `workspaceRootOf` 选项不存在 / `runtimeState` 无 `workspaceId`），记录；证据 2 的未绑定半与证据 7 为 characterization 守卫）：
  1. **绑定与未绑定**：同一所有者的绑定会话（W，`dir`=`proj`）与未绑定会话各 prompt 一回合 → 绑定会话 spawn argv `--cwd` 为 W 根（`<SANDBOX_ROOT>/<ownerId>/proj`，经 `realpath` 比较）且 probe `cwd=` 相同；未绑定为 `<SANDBOX_ROOT>/<ownerId>`；两者 argv 除 `--cwd`（及 `--resume` 有无）外逐字相同，`--session-dir` 相同。`store.runtimeState` 对绑定会话返回 `workspaceId` 为 W 的 id。
  2. **闲置回收后 resume**：绑定会话闲置回收后再 prompt → 两次 spawn 的 argv `--cwd` 逐字相等、第二次含 `--resume`、`--session-dir` 不变、probe `cwd=` 与前一次相同。
  3. **空间根缺失**：绑定会话首回合完成、闲置回收后删除 W 根目录再 prompt → 502 `agent_unavailable` 信封字节（与既有 502 用例同一断言方式）；spawn 调用数不变（未以任何路径 spawn）；W 根仍不存在（未被 mkdir）；所有者根下未出现新目录；受理对已移除且会话状态复原（`expectCompensatedIdleSession`）；`liveProcessCount()===0`。另测：W 根被同名普通文件占据（`rootOf` 抛错分支）→ 同样 502，文件内容未变、未 spawn。
  4. **`workspaceRootOf` 返回 null**：不用桩——以 SQL 把所有者 A 的会话绑到所有者 B 的工作空间 W（FK 只校验 `workspaces(id)` 存在，`ROOT_OF_SQL` 按 `owner_id` 过滤，真实 `rootOf` 即返回 null，正是 D4「不属于该所有者」的不变量破坏）→ 经真实 REST prompt 得到通用 5xx 信封字节（非 502、非 `agent_unavailable`）；未 spawn；受理对已移除；B 的 W 根未被触碰。（issue 所写「删工作空间行后以注入桩保持绑定」不可行：035 的 `ON DELETE SET NULL` 删行即清空 `workspace_id`。）
  5. **regenerate 与 fork 走同一解析**：绑定会话一回合后闲置回收 → `POST …/regenerate` 的惰性获取 spawn argv `--cwd` 为 W 根；`POST …/fork`（真实 fake-omp `branch` 场景）的临时进程 spawn argv `--cwd` 为 W 根。另：fork 源会话 W 根缺失 → fork 失败为 502 且临时进程未 spawn、无新会话行。
  6. **production createApp**：经 `createApp`（`openSupervisorApp` 或等价入口）以 `POST /api/workspaces` 建 W（前置：`runtime.sandboxRoot` 须已存在——`computeSafeRoot` 对它 realpath，`tempOpts` 不建该目录，用例先 `mkdir`）→ SQL 直写 `chat_sessions.workspace_id` → prompt → probe `cwd=` 与 `GET /api/workspaces` 中 W 的 `root` 相等（或两侧都 `realpathSync` 后相等——`resolveSandboxPath` 对 `sandboxRoot` 做 realpath，macOS tmpdir 下绑定会话的 `--cwd` 为 `/private/var/...`，而未绑定会话仍为 `join(sandboxRoot, ownerId)`），证明 sessions 使用 createApp 构建的同一工作空间 store。证据 1、2、5 的路径比较同样两侧 realpath。
  7. **回归**：既有夹具补一行/改期望值后 `npm test --workspace server` 全绿（含 `server-assembly.test.ts` 次序断言不变、`fake-omp.test.ts` probe、`omp-process`/`omp-runtime`/`sudo-launcher`）；`make typecheck`（`cwd` 必填后无遗漏调用方）、`make lint`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；PR 记录 `supervisor.ts`、`store.ts`、`omp/runtime.ts`、`omp-process.test.ts`、`omp-runtime.test.ts`、`omp-spawn-cwd.test.ts`、`app.test.ts` 前后行数。
