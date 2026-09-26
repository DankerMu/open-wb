# Proposal: omp-max-processes-config（#451）

## Why
父 change `s1c-turn-control-governance` tasks 1.3（epic #448）。进程池治理（4.1 #463）需要全局活进程上限；该上限必须与 `OMP_IDLE_MS` 走同一配置解析纪律与同一 runtime settings 对象，不能由 supervisor 直读 `process.env`，也不能有第二条配置路径。本切片只解析与传递，消费归 4.1。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 生产配置新增、启动失败信号、跨 server → app → sessions 装配边界)
Blast radius: 全部生产启动路径——非法值若不在副作用前失败会留下半启动状态；若存在第二条配置路径，4.1 的上限可能与部署值不一致；错误消息若回显输入值违反既有配置纪律。
Selected risk packs: Config / project setup；Public API / CLI / script entry（环境键即运维接口）；Error handling / rollback / partial outputs（副作用前失败）；Legacy compatibility / examples（十二项既有配置行为不变、exact startup record 不变）；Resource limits（进程上限值域）
Evidence floor: 新建 server vitest 测试文件覆盖缺省/合法/非法三态（纯 resolver）、main path 启动失败信号（stderr 恰一行 generic record、错误命名键不含值、无副作用）、cap 经同一 runtime 对象到达 sessions；正向断言先红后绿；`npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。

## What Changes
- `server/src/agent-config.ts`：`AgentSettings` 增 `ompMaxProcesses: number`；`DEFAULT_OMP_MAX_PROCESSES = 16`；解析复用 `resolveIdleMs` 同一 canonical 纪律（抽出共享的正整数解析，按键名出错，不重复实现）。
- `server/src/server.ts`：抽出纯函数 `sessionRuntimeOf(config)`（pure config seam，无副作用），`start()` 以它组装 `assembly.runtime`（含 `idleMs` 与新增 `maxProcesses: config.ompMaxProcesses`，同一对象）。
- `server/src/sessions/supervisor.ts`：`SessionSupervisorRuntime` 增可选字段 `maxProcesses?: number`（仅类型，不消费——4.1）。
- 新建测试文件。

## Capabilities
- MODIFIED `http-service-skeleton`「服务启动与装配」「Shared agent module assembly」：整段取父 delta（十三项配置、同一解析纪律、cap 经同一 runtime settings 对象）；本 issue 全量交付两块父 delta。
- ADDED `omp-pool`「OMP_MAX_PROCESSES 配置」：整段取父 delta。Scenario「缺省与覆盖」中「supervisor 的上限」在本切片的可观测面是 sessions 模块收到的 runtime options `maxProcesses`；上限的执行（准入/驱逐/503）归 4.1。

## Impact
- 部署：新增可选环境键，缺省 16；CI/Makefile 不传。
- 不改 exact startup record（`server_started` 记录的字段集是既有合同）；父 tasks 1.3 原子声明中「写入 startup 记录」不落实为新增字段，以免破坏该合同（非死代码的依据是 runtime options 被 sessions 模块接收）。

## Non-goals
- supervisor 对上限的消费（4.1）、fork 临时进程计入上限（4.5）、文档（9.1）。
