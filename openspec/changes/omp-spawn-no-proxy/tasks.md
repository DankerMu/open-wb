# Tasks — omp-spawn-no-proxy (#1615)

Fixture level: expanded. Risk packs: selected — Auth / permissions / secrets（`.env` 注入代理外发全部对话与令牌、伪造回复；非空豁免两个大小写都钉，真实二进制 + 入库负向对照证明）、Public API / CLI / script entry（sudo `--preserve-env=` 串是部署契约，成员与次序写进规格）；not selected — Config、File IO / path safety、Schema、Concurrency、Resource limits、Error handling、Release / packaging（见 proposal Triage）。

Must preserve: 白名单其余键与取值（含 #1575 的 `OTEL_SDK_DISABLED=true`）、`PUPPETEER_EXECUTABLE_PATH` 只在配置 `BROWSER_BIN` 时出现且在 preserve 串末位；不读父进程任何代理变量；`process.ts` 的 spawn 形态与 argv 不变；overlay 不变；已有官方用例全绿（含 #1575 的 OTLP 四种配置）。

- [ ] 1.1 开工核对：`spawn-env.ts`；tag `v18.12.3` 的 `packages/ai/src/utils/transport-fetch.ts:25-47`、`proxy.ts:24-66,245-268`、`packages/utils/src/env.ts:291,300-302`；design「Sibling surfaces」列的每个测试文件里写死白名单 / preserve 串的位置；`omp-official-overlay-pins.test.ts` 现有的 `launch(world, overlay, otelPin)` 包装与 OTLP 监听器写法（复用其形态）；官方 world 的假上游地址（必须是回环、明文 http）。出入先改本 fixture 再继续。
- [ ] 1.2 测试先行（单测）：按 omp-runtime delta「环境白名单」新增的 WHEN/THEN 与 omp-uid-isolation delta 的 preserve 串，改写死的键集合 / 取值 / 前缀（从规格逐字写）；`linux/uid-isolation.test.ts` 必到键表加 `no_proxy`、`NO_PROXY`。先红。
- [ ] 1.3 实现：`ompSpawnEnv` 写 `no_proxy: "*"`、`NO_PROXY: "*"`（注释：Bun fetch 对回环也走环境代理，`.env` 能注入；钉豁免而不是代理变量，两个大小写都钉，issue 1615）；`SUDO_PRESERVE_ENV` 按 design D3 加名。
- [ ] 1.4 真实 omp：按 omp-runtime 新 Scenario 放进 `omp-official-overlay-pins.test.ts`：一个只记录请求行与到达时间、不转发的本地代理监听器（应答固定错误即可）；新的 plant 函数写五种 `.env`；五种情形各一个完整回合，断言 `agent_end`、回复来自假上游、代理零请求；负向对照用该文件局部 spawn 包装删掉两个钉，有界等待代理收到指向假上游的绝对 URI 请求（不等 `agent_end`）。记下对照中代理收到的全部请求行。CI 三处清单不动。
- [ ] 1.5 验证：`npm test --workspace server`；`WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official-`；typecheck；`bash scripts/size-guard.sh`；`make check`；diff 范围只含 change 目录、`spawn-env.ts`、`server/test/**`。
- [ ] 1.6 文档（编排方）：system.md 9.8「spawn 环境恒钉…」段补 `no_proxy` / `NO_PROXY` 与 design D5 副作用；ADR-0012 `.env` 入口一节加「（2026-10-21 补充，#1615）」。
