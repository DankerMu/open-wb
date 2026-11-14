# Tasks: s2c-harness-followups

> 三组各一个 issue、一个 PR：组 1 = #2002，组 2 = #2004，组 3 = #2009。三组互不依赖；组 2 用组 1 落地后的默认命令验证。
> 本 change 在三组都合入之后另开一个 PR 归档。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 是 | 组 1 的 worker 上限：CI uid-isolation 上 worker 数不得变化；组 2 的帧序实测 |
| Legacy compatibility / examples | 是 | 未设 `WORKBUDDY_OMP_TEST` 的 server 运行与 CI 分片逐字不变；既有门控用例与入库用例断言不改 |
| Auth / permissions / secrets | 是 | 组 2 项目层同名工具的放行残余（ADR-0012 延伸）；组 3 泄密哨兵 |
| Error handling / rollback / partial outputs | 否 | 不改宿主处理；真实行为与宿主不符时停下另开 issue |
| Public API / CLI / script entry | 否 | 无 |
| Schema / columns / units / field names | 否 | 无 |
| Config / project setup | 是 | 组 1 改 `server/vitest.config.ts`；CI 文件、Makefile、AGENTS.md 不动 |
| File IO / path safety / overwrite | 否 | 无 |
| Resource limits / large input / discovery | 是 | 组 1 限的正是并发拉起的 omp 子进程数，免得压过 10 s 握手期限（`process.ts:726`）；落点同 Concurrency |
| Release / packaging / dependency compatibility | 否 | 不加依赖 |
| Documentation / migration notes | 是 | 组 2 补实测记录与 knowledge-base.md 一句 |

Boundary（全 change）：
- 只读：`server/src/**`、`web/**`、`.github/**`、`Makefile`、`AGENTS.md`、`constraints.yaml`、`app-reference/**`。
- 可改：见各组。
- 真实 omp 的行为若让宿主的生产处理出错，停下按 diagnosing 流程报告（附命令、帧、上游请求），编排方另开 issue；不改 `server/src/**`，也不改断言去迁就。

Must-preserve：
- `server/src/sessions/omp/process.ts` 的握手期限不变；不加重试、不加超时。
- 未设 `WORKBUDDY_OMP_TEST` 时 `npm test --workspace server` 的 worker 数、覆盖率范围与阈值不变。
- 既有官方门控用例与 `kb-*` 用例不改断言、全绿。
- 文件 ≤800 行（`scripts/size-guard.sh`）；重复 ≤3%（jscpd）。

## 1. 官方 omp 门控用例的 worker 上限（#2002）

组 1 约定：
- 可改：`server/vitest.config.ts`（现为一行 `export { default } from "../vitest.shared.mjs";`，改为 `mergeConfig` 形式；`mergeConfig` 从 `vitest/config` 导入——不要照抄 web 的 `from "vite"`：server 与根 package.json 都没有声明 `vite`，knip 会报未声明依赖，也违反「依赖/lockfile 不变」）。
- `maxWorkers` 只在 `process.env.WORKBUDDY_OMP_TEST === "1"` 时出现（条件展开，不写 `maxWorkers: undefined`），值为
  `Math.max(1, Math.min(3, availableParallelism() - 1))`（`node:os`）；注释写明 3 的来历（CI uid-isolation 4 vCPU 缺省 3 个 worker 一直绿；#2002）与缺省公式出处。
- verification-harness「共享 Vitest 配置的 native ESM 边界」仍成立：specifier 逐字是 `../vitest.shared.mjs`；共享文件不改。
  native loader 场景（`npm exec --workspace @workbuddy/server -- vitest run --coverage --configLoader native`）要实际跑一次。

- [x] 1.1 改前：本机 `WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/var/omp/omp" npm run test:focus --workspace server -- omp-official-`（在仓库根执行；`var/omp/omp` 缺失先 `make omp-fetch`），记录失败文件数、用例数与 `handshake timeout` 计数（红）。
- [x] 1.2 实现 `server/vitest.config.ts`。
- [x] 1.3 改后：同一命令全绿（记录耗时与 `availableParallelism()`）；解析两次配置并记录结果：未设变量时没有 `maxWorkers`；`WORKBUDDY_OMP_TEST=1` 时 `maxWorkers` 等于 `min(3, n-1)`。
  CI 侧的证据只能是「uid-isolation 绿 + n=4 时公式等于 3」：vitest 不打印 worker 数，`.github/**` 只读，不为取证改 CI。
- [x] 1.4 `npm test --workspace server`、native loader 命令、`make check` 通过。

## 2. host tool 真实 omp 补测（#2004）

组 2 约定：
- 可改：`server/test/omp-official-host-tools.test.ts`（现 237 行；新增场景放进同文件或兄弟文件 `server/test/omp-official-host-tools-branching.test.ts`，各 ≤800 行）、
  `server/test/support/omp-official-proxied.ts`（现 450 行，只在缺少 regenerate / fork / 审批 / 删库的驱动函数时加）、
  `server/test/support/omp-official-bodies.ts`、`server/test/support/fake-omp-host-tool.mjs`（只在 Deny 实测与自选帧序不符时）、
  `docs/reviews/2026-11-10-omp-host-tools.md`、`docs/architecture/knowledge-base.md`（审批放行段那一句）。
- 复用 #1975 的 `openProxiedApp({ kb, recordBodies, registry })` 与 `promptAppTurn`；走应用的 REST（regenerate、fork、`DELETE /api/kb/bases/:id`），不直接给 omp 发命令。
- 拒绝：`openProxiedApp` 对每个 `approval.request` 经 `setImmediate` 调 `supervisor.decide(..., "deny")` 自动拒绝（`omp-official-proxied.ts:311-321`），走的是审批端点背后同一个 `decide`。Deny 场景就用这个自动拒绝，不另走审批 REST（会与它抢先）。
- 与 issue #2004 原文的偏离：原文第 3 条写「`write` 档下回 Deny」，但 `write` 档对 `kb_search` 由传输层自动放行（`process.ts:603`），永远到不了所有者，所以场景用 `always-ask`。
- 新用例都在 `describe.skipIf(OMP_TEST_OFF)` 门下，不进 CI uid-isolation 清单（omp-runtime「host tool 的真实 omp 回归」写明 CI 跳过）。
- 注册次数取证：`openProxiedApp` 只 tee 了 stdout（`omp-official-proxied.ts:256-272`），沿用现有用例的做法（`omp-official-host-tools.test.ts:228-233`）数 stdout 上 `type:"response", command:"set_host_tools"` 的帧：regenerate 场景整个会话进程恰一次；fork 场景数 fork 提交之后、fork 出的会话那一代进程的帧，恰一次。不接 stdin tee。
- 项目层同名工具：先在 `resource/oh-my-pi`（v18.0.10 参考克隆）与官方二进制上确认 v18.12.3 能加载的最小 `.omp/tools/kb_search` 形式，写进实测记录；工作空间里放该文件只在用例的临时沙箱内。
  若 v18.12.3 根本不加载项目层工具，或需要的东西超出本组可改范围，就把实测到的事实写进记录与断言（例如「上游 `tools` 恰一个 `kb_search`，调用落到宿主」），不扩大范围。
- 实测与宿主的生产处理冲突时，按全 change 的 Boundary 停下。

- [x] 2.1 核对 Context：`server/src/sessions/host-tool-align.ts`、`branching.ts`、`branch-temp.ts`、`omp/ui-requests.ts`、`omp/process.ts`（审批放行）、记录 §2.1/§2.4/§2.8。
- [x] 2.2 写五个场景的门控用例（omp-runtime delta）；跑 `WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/var/omp/omp" npm run test:focus --workspace server -- omp-official-host-tools`，记录每个场景的实测帧与上游请求。
- [x] 2.3 依实测补记录 §2.1、§2.4、新 §2.9、§2.10，改 knowledge-base.md 那一句；Deny 帧序与假 omp 不一致时改 `fake-omp-host-tool.mjs` 并跑 `npm run test:focus --workspace server -- host-tool`。
- [x] 2.4 全部官方门控用例（组 1 合入后的默认命令）、`npm test --workspace server`、`make check` 通过。

## 3. 测试支架两处（#2009）

组 3 约定：
- 可改：`server/test/support/fake-ragflow.d.mts`（`closed` 注释）、`server/test/kb-ingest-helpers.ts`（哨兵）、一个新用例文件或现有 `kb-ingest-*` 测试里加一例。
- `closed` 注释写实际触发面：应答写完之前连接关闭即置位，原因可以是客户端放弃，也可以是 `reset` / `cut` 故障（`fake-ragflow-wire.mjs:44-47`、`fake-ragflow-script.mjs:79-85`）。
  grep 用到 `closed` 的断言：若有用例同时注入 `reset` / `cut` 又拿 `closed` 证明「客户端放弃」，在 PR 里列出并补区分断言；没有就只改注释。
- 哨兵：`console` 五个方法用 `vi.spyOn` 收集但不替换实现（spy 默认透传）；判定提成导出函数，`afterEach` 调它。
- 新用例不能放进 `useIngestWorlds` 的文件里直接写哨兵：`afterEach` 会对整段收集文本断言不含哨兵（`kb-ingest-helpers.ts:148-152`），判定按预期抛错之后收尾照样失败。做法：把收集器提成导出的工厂（`start()` 装 spy、`stop()` 恢复并返回收集到的文本），`useIngestWorlds` 用它；新用例放在不用 `useIngestWorlds` 的新文件里，自己起一个收集器，写哨兵后 `stop()`，再断言判定对这段文本抛错且信息点名哨兵。
- 红绿顺序：先提出收集器与判定，保持只 spy 两个 `write` 的旧行为，新用例在这一步红，红的原因必须是「期望抛错但没抛」（不是 import 失败）；再把 console 纳入收集，变绿。

- [x] 3.1 提出收集器工厂与判定函数（行为不变，只 spy 两个 `write`），写新用例：经 `console.log` 写哨兵后 `stop()`，断言判定抛错；记录红（原因是没抛）。
- [x] 3.2 收集器纳入 `console` 五个方法；新用例变绿；修正 `closed` 注释（现有两处 `closed` 断言注入的都是 `hold`——`kb-session-search.test.ts:381`、`kb-retrieval-abort.test.ts:62`——只改注释）。
- [x] 3.3 `npm run test:focus --workspace server -- kb-`、`npm test --workspace server`、`make check` 通过。

Suggested fixture level: compact - 三组都只动测试与记录，无产品代码。
