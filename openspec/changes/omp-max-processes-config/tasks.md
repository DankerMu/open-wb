# Tasks: omp-max-processes-config（#451）

## 1. 配置键（父 tasks 1.3 原文）

- [ ] 1.3 `server/src/agent-config.ts` + `server/src/server.ts`：`OMP_MAX_PROCESSES` 解析（canonical 正整数 1..2147483647、默认 16、超限启动失败，同 `OMP_IDLE_MS` 纪律），传入 supervisor runtime options 的 `maxProcesses` 字段（4.1 消费）；验证：新建测试文件覆盖缺省/合法/非法三态与启动失败信号

## 2. Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Config / project setup | yes | 新增生产配置键 → resolver 缺省/合法/非法三态测试 |
| Public API / CLI / script entry | yes | 环境键是运维接口 → 错误消息命名键、main path 失败信号测试 |
| Error handling / rollback / partial outputs | yes | 非法值必须在副作用前失败 → 真实编译入口子进程对全部九个非法值断言无 DB/var/listen |
| Legacy compatibility / examples | yes | 十二项既有配置与 exact startup record 不变 → 既有 server-config/启动测试不改全绿 + 新测试断言其它十二项缺省 |
| Resource limits / large input / discovery | yes | 上限值域 1..2147483647 → 边界 `1`/`2147483647` 合法、`0`/`2147483648` 非法 |
| Concurrency / shared state / ordering | no | 本刀不消费上限（4.1） |
| Auth / permissions / secrets | no | 不涉凭证；错误消息不回显输入值由 Public API 包覆盖 |
| Schema / columns / units / field names | no | 无持久化 |
| File IO / path safety / overwrite | no | 仅断言失败时无文件副作用（Error handling 包） |
| Release / packaging / dependency compatibility | yes | 编译入口与源码入口同一 config identity → `npm run build --workspace server` + compiled entry resolver 断言 |
| Documentation / migration notes | no | 文档归 9.1（#486）；Migration Plan 已载 |

## 3. 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/*.test.ts`；既有测试不改（若全等断言因新字段失败，只补 `ompMaxProcesses` 期望值）。
- [ ] 正向断言先对未改源码跑红再跑绿；负向（非法值被拒）在未改源码上因键未被读取而「不抛」，同样为红，须记录。
- [ ] `git grep -n OMP_MAX_PROCESSES -- server/src` 只命中 `agent-config.ts`（无第二配置路径）；supervisor 不读 env；`app.ts` 不改。
- [ ] `npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。
