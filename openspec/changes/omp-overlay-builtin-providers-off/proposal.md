# omp-overlay-builtin-providers-off — overlay 关掉 omp 全部内置模型 provider，启动不再连第三方模型目录主机（#1621）

## Why

宿主每次 spawn omp（`--mode rpc-ui`）后，omp 都会在后台做模型发现。#1615 写官方用例时实测到 7 个第三方目录主机的 `CONNECT`：`catalog.stencil.so`、`coding-intl.dashscope.aliyuncs.com`、`hyper.charm.land`、`api.commandcode.ai`、`api.kilo.ai`、`api.venice.ai`、`zenmux.ai`。这违反了 `docs/architecture/system.md:15`「内网单机部署包（P4），无公网依赖」。

请求从哪来（tag `v18.12.3`，读代码）：
- 非交互模式下 `main.ts:2330` 会无条件调用 `refreshInBackground()`，缺省策略是 `online-if-uncached`，没有任何设置能关掉它。
- 内置 provider 满足下面任一条件就会拉目录，无凭证也一样（`model-registry.ts:2428-2433`）：已认证、声明了 `allowUnauthenticated`、或在共享目录兜底集合里。
- 唯一的关闭手段是 `disabledProviders`，按 id 精确匹配（`model-registry.ts:215-220`、`:2383-2393`、`:2474`）。

现在的 overlay 只关了本机探测的四项（`host-overlay.ts:82-86`，#1564）。

owner 2026-10-21 裁定**关闭**这些请求，不作为残余接受。

## What

- **overlay 固定块**：`disabledProviders` 扩成 omp v18.12.3 的全部内置模型 provider，共 87 项。名单的生成规则和排除项见 design D1。托管的 `workbuddy` provider 不在名单里；能力发现源的 id 也一个都不进名单，否则会把项目 skills 一起关掉。
- **官方 v18.12.3 用例**：
  - 产品 overlay 下，去掉 no_proxy 钉以便观测。在工作目录 `.env` 写 `ALL_PROXY` 指向本地监听器，断言监听器零命中（不发模型回合：`ALL_PROXY` 也会代理回环上的模型请求，所以以 `get_available_models` 应答加观测窗口为锚点，而不是 issue 写的「`agent_end` 之后」），`workbuddy/<id>` 和 `skill:x` 都还在。
  - 负对照：换回原来的四项名单，至少收到一个 `CONNECT`，其中包括 `catalog.stencil.so:443`。
- **`marketplace.autoUpdate: "off"`**（owner 2026-10-21）：关掉启动时的插件 marketplace 刷新与更新检查（design D5）。
- **单测 / 字节断言**：随名单一起更新。
- **spec**：omp-runtime「宿主 overlay」的 YAML 块、`disabledProviders` 的说明，再加一个 Scenario。
- **文档**：
  - `host-overlay.ts` 文件头注释；
  - ADR-0012 补一节「2026-10-21 补充，#1621」，写明裁定、规则、实测和残余；
  - `docs/architecture/system.md` 9.8 的 overlay 块和表格行。
- **不做**：
  - 助手经工具发起的网络访问；
  - 模型代理到上游的请求；
  - 部署侧防火墙；
  - 从二进制动态生成名单（omp 没有枚举内置 provider 的接口，见 design D2）。

## Triage

```text
Issue type: bugfix (deployment constraint: no public egress)
Fixture level: expanded
Upstream suggested level: absent (issue-scribe filed; S, p2, needs-triage → owner 2026-10-21: close)
Level rationale: expanded — AGENTS.md Critical Path (omp 子进程治理: the spawn config every session runs with) and a security-relevant egress boundary; the list interacts with a shared key that also drives capability discovery (a wrong id disables project skills).
Blast radius: every omp spawn; a wrong list either leaves egress (constraint violated, measured by the official case), hides the managed `workbuddy` models (no model → every turn fails), or disables a capability source (project skills / rules vanish)
Selected risk packs: Config (fixed overlay block is a byte-for-byte contract with the spec and docs); Security (egress boundary; no new credential surface); Public API (none — overlay is host-internal, but `get_available_models` / `get_available_commands` must be unchanged for the managed provider and project skills); not selected — Concurrency, Resource limits, Auth / secrets, File IO, Schema, Error handling, Release / packaging (binary unchanged)
Evidence floor: official v18.12.3 case red on the four-item list (CONNECT seen, incl. catalog.stencil.so:443) and green on the product overlay (zero CONNECT), plus `workbuddy/<id>` listed and `skill:x` listed; list derivation re-checked against tag v18.12.3 sources (KDL ids ∪ bundled provider ids ∪ implicit, minus cursor/local/web) with the check recorded in evidence; `WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official-` all files green; `npm test --workspace server` ×1 (+ targeted overlay tests ×3); `make check`; PR marked Critical Path (omp 子进程治理) requesting white-box review
```
