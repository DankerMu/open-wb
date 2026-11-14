# Proposal: s2c-harness-followups

```text
Issue type: test harness / real-omp evidence (S2c 收口后续；#2002、#2004、#2009)
Fixture level: compact
Upstream suggested level: (issues 未标) compact
Blast radius: 只动测试、测试配置与实测记录——server/vitest.config.ts（官方 omp 门控用例的 worker 上限）、
  server/test/omp-official-host-tools.test.ts（真实 omp 补测）、server/test/support/fake-omp-host-tool.mjs（仅当实测与假 omp 不符）、
  server/test/support/fake-ragflow.d.mts（注释）、server/test/kb-ingest-helpers.ts（泄密哨兵）、docs/reviews/2026-11-10-omp-host-tools.md、
  docs/architecture/knowledge-base.md（残余句改为实测结论）。做错时：门控用例在 CI uid-isolation 上 worker 数变化导致超时或变慢；
  真实 omp 的未测行为被假 omp 的自选行为掩盖；入库用例的泄密哨兵漏掉 console 通道
Selected risk packs: Concurrency / shared state / ordering（worker 上限；CI 上不改变 worker 数）;
  Legacy compatibility / examples（未设 WORKBUDDY_OMP_TEST 的全量与分片运行逐字不变）;
  Auth / permissions / secrets（泄密哨兵与项目层同名工具的放行残余）
Evidence floor: 本机 `WORKBUDDY_OMP_TEST=1` 全量官方门控用例在默认命令下全绿（改前记录失败数）；CI uid-isolation 绿；
  omp-official-host-tools 新增用例在官方 v18.12.3 上全绿；入库哨兵新用例先红后绿；make check
```

design.md omitted (compact)：三组互不依赖，各自一个 PR；只有组 2 写真实 omp 的实测结论。

## Why

S2c（#1961）收口后留下三件测试面的事：

- #2002：本机 14 核默认 13 个 worker 跑官方 omp 门控用例，大量 `handshake timeout`；`--maxWorkers=4` 全绿。CI uid-isolation（4 vCPU、
  vitest 缺省 `availableParallelism()-1` = 3 个 worker）一直绿。
- #2004：真实 omp v18.12.3 上 regenerate（同一进程的 `branch`）与 fork 之后 `kb_search` 是否仍可用、`set_host_tools {tools:[]}` 的应答、
  `always-ask` 下 `Deny` 的帧序（issue 原文写 `write` 档，但 `write` 档对 `kb_search` 由传输层自动放行，`process.ts:603`，Deny 只在 `always-ask` 下可达）、项目层同名 `.omp/tools/kb_search` 与 host tool 并存，都没有实测；宿主对这些情形的处理只被假 omp 钉住。
- #2009：`fake-ragflow` 的 `closed` 注释窄于实际触发面；`useIngestWorlds` 的泄密哨兵只 spy `process.stdout/stderr.write`，
  vitest 截获的 `console.*` 不经过这两个 spy。

## What Changes

- verification-harness：新增「官方 omp 门控用例的 worker 上限」与「入库世界的泄密哨兵覆盖 console」两条 requirement。
- omp-runtime「host tool 的真实 omp 回归」：加四个场景（regenerate 之后、fork 之后、撤下全部 host tool、`always-ask` 下拒绝），
  并要求项目层同名工具的并存行为有一条实测用例。
- 记录 `docs/reviews/2026-11-10-omp-host-tools.md` 补 §2.1（`[]` 应答）、§2.4（Deny）、新 §2.9（branch 之后）、§2.10（同名项目工具）。

## Impact

- 规格：verification-harness 两条 ADDED；omp-runtime 一条 MODIFIED。
- 代码：只有测试与测试配置；`server/src/**`、`web/**`、CI 文件、Makefile、AGENTS.md 不动。
- 真实 omp 的行为若让宿主的生产处理出错（例如 regenerate 之后上游 `tools` 里没有 `kb_search`、`[]` 的应答不是 `toolNames:[]`），
  组 2 停下按 diagnosing 流程报告并另开 issue，不在本 change 里改 `server/src/**`。
