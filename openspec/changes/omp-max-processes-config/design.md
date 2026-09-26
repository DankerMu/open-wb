# Design: omp-max-processes-config（#451）

父设计：D1「配置」段、Migration Plan。

- **Change surface**：`server/src/agent-config.ts`（纯 resolver）→ `server/src/server.ts`（`resolveServerConfig` 与 main path 组装 `assembly.runtime`）→ `server/src/app.ts` `createApp`（不改；把 `assembly.runtime` 原样交 `registerSessions`）→ `server/src/sessions/supervisor.ts` `SessionSupervisorRuntime`（类型新增可选 `maxProcesses`）。
- **Must preserve**：
  - 既有十二项配置的缺省/覆盖/非法语义逐项不变；`OMP_IDLE_MS` 的错误消息文本不变（既有测试断言其命名）。
  - main path 非法配置在任何 filesystem/database/listen 副作用前 nonzero，stderr 恰一行 `{"event":"server_start_failed"}`，无 success record；import-without-main 静默。
  - exact `server_started` startup record 字段集不变。
  - `http → feature → core` 依赖方向；supervisor 不读 `process.env`。
- **Must add/change**：`OMP_MAX_PROCESSES`：canonical ASCII decimal 正整数 `1..2147483647`，缺省 16；错误消息命名 `OMP_MAX_PROCESSES` 且不含输入值；`AgentSettings.ompMaxProcesses`；`server.ts` 纯函数 `sessionRuntimeOf(config)` 产出含 `maxProcesses` 的 runtime（`start()` 必须调用它）。`app.ts` 无 assembly 的缺省 runtime 不加该字段（issue PR Boundary；缺省值唯一来源是 resolver，supervisor 侧缺省归 4.1）。`DEFAULT_OMP_MAX_PROCESSES` 仅在被新测试引用时导出（knip）。
- **Governing invariant**：进程上限只有一个来源——`resolveAgentSettings` 解析 `OMP_MAX_PROCESSES` 的结果——并经与 `idleMs` 相同的 runtime settings 对象到达 sessions 模块。
- **Sibling surfaces**：
  - 解析纪律：`resolveIdleMs`（`agent-config.ts:69-79`）——两键共用一个正整数解析实现（重构为按键名参数化，`OMP_IDLE_MS` 行为/消息不变），避免 jscpd 与双实现。
  - 生产者：`server.ts:61` `resolveServerConfig`（`ServerConfig extends AgentSettings`）；`server.ts:220-227` `assembly.runtime`。
  - 缺省路径：`app.ts:139-146` 无 assembly 时的 runtime 缺省——本刀不改（不产生第二来源）。
  - 消费者：`registerSessions` → `SessionSupervisor` 的 `#runtime`（本刀只收类型字段）；`server/test/session-supervisor-helpers.ts` 等构造 runtime 的测试无需改（字段可选）。
  - 既有测试：`server/test/server-config.test.ts` 用 `toMatchObject`/子集 helper，新增字段不破坏；若任何既有断言对 settings 做全等比较而失败，只允许补 `ompMaxProcesses` 期望值。
  - 失败路径：main path 的 generic failure 记录（`emitStderrRecord`）。
- **Seams under test**：
  - 纯 resolver：`resolveAgentSettings(env, repoRoot)` 与 `resolveServerConfig(env, entry)`（source 与 compiled entry 同一身份，按既有 server-config 测试做法）。
  - 启动失败信号：用 `server/test/server-startup-helpers.ts`（`compileServerEntry`、`startCompiledServer`、`reserveWildcardPort`）的真实编译入口子进程做法；`beforeAll` 只 `compileServerEntry()` 一次，`it.each` 覆盖全部九个非法值（不照搬 `server-startup-order.test.ts:560-610` 每例编译）。
  - 到达 sessions：(a) `sessionRuntimeOf(resolveServerConfig(env, entry))` 纯函数断言；(b) 以 `vi.spyOn(sessions, "registerSessions")`（先例 `server/test/server-assembly.test.ts:466`）断言 `createApp({assembly:{runtime}})` 把含 `maxProcesses` 的同一 runtime 对象交给 sessions 模块。不得经 supervisor 私有字段取值。
- **Required evidence**：
  - 缺省：`{}` → `ompMaxProcesses === 16`，其它十二项与既有缺省一致。
  - 合法：`"1"`、`"2"`、`"2147483647"` → 原样数值。
  - 非法：`""`、`"0"`、`"abc"`、`"-1"`、`"1.5"`、`"+3"`、`"016"`、`" 8"`、`"2147483648"` → resolver 抛出，消息含 `OMP_MAX_PROCESSES` 且不含输入值（空串不做「不含」断言——任何串都含空串——改为断言消息恰为固定文本之一）；main path 对**全部九个**真实执行：exit≠0、stderr 恰一行 `{"event":"server_start_failed"}`、stdout 无 success、DB 文件/`var/`/listen 均未发生。
  - 到达：`sessionRuntimeOf(resolveServerConfig({OMP_MAX_PROCESSES:"7",OMP_IDLE_MS:"1234"}, entry))` 含 `{idleMs:1234, maxProcesses:7}`；`sessionRuntimeOf(resolveServerConfig({}, entry)).maxProcesses === 16`（「干净启动…上限为 16」在本刀唯一可执行的证明）；spy 断言 `registerSessions` 收到的 `runtime.maxProcesses` 与注入值相等。
- **Non-goals**：上限执行、fork 计数、文档、CI 传参、startup record 新字段。
- **Review focus**：单一解析实现（无复制）、错误消息不含输入值、副作用前失败、无第二配置路径（`git grep -n OMP_MAX_PROCESSES -- server/src` 只命中 `agent-config.ts`）、`start()` 调用 `sessionRuntimeOf`、startup record 未变、`app.ts` 未改。
