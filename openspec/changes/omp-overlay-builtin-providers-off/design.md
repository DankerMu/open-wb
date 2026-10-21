# Design — omp-overlay-builtin-providers-off (#1621)

## Context

- **键怎么被消费**（tag `v18.12.3`）：`disabledProviders` 由 `packages/coding-agent/src/config/model-registry.ts:217-221` 读成 `Set`，按 id 精确比较，区分大小写，没有通配。
- **三条外联路径，各自按 id 判断**：
  - 内置 descriptor 的发现（`:2383-2388`）；
  - 三个特殊 provider（`:2389-2393`）；
  - 只在目录里的 provider 挂共享 models.dev 兜底（`:2471-2486`）。共享兜底会请求 `https://catalog.stencil.so/models.json.zstd`（`packages/catalog/src/provider-models/openai-compat.ts:94`）。
- **同一个键还管能力发现源**（`packages/coding-agent/src/capability/index.ts:47-48`）。能力发现源的 id 有 `claude`、`codex`、`cline`、`cursor`、`native`、`gemini`、`github`、`opencode`、`windsurf` 等，定义在各 `discovery/*.ts` 的 `PROVIDER_ID`。
- **数组按整体替换项目层**（#1564 实测，ADR-0012）。

## Goals / Non-Goals

**Goals**
- 宿主 spawn 的 omp 在启动和后台发现时，不再向任何第三方模型目录主机发请求。
- 托管的 `workbuddy` provider 照常可用。
- 能力发现源（项目 skills 等）不受影响。

**Non-Goals**
- **marketplace 自动更新**（不再是 Non-goal，移入 D5；保留此条说明来由）：`main.ts:2262-2266` 每次 spawn 都会安排，`marketplace.autoUpdate` 缺省 `notify`（`modes/settings.ts:1139-1143`）；托管 agent 目录跨 spawn 持久，注册过 marketplace 后每次 spawn 都会刷新（`marketplace/manager.ts:751-762`）。没有已注册 marketplace 时不发请求，而注册只能经工具层。owner 2026-10-21 裁定一并钉成 `off`，见 D5。
- **助手经 bash / eval / 浏览器发起的访问**：属于工具层，另有审批。
- **模型代理到上游的请求**：见 ADR-0008。
- **部署侧防火墙**。
- **通用的出网检测器**。

## Decisions

### D1 名单 = 全部内置模型 provider，减去三个 id

名单取下面三部分的并集（全部按 tag `v18.12.3`）：
- `packages/catalog/src/compat/rules/providers/*.kdl` 的条目 id；
- bundled 模型目录（`models.json`）的 provider id；
- 隐式本机探测的 `llama.cpp`、`apple`（`model-registry.ts:1636-1700`）。

再减去三个 id：
- `cursor`：它同时是能力发现源的 id，列进来会关掉 `.cursor` 下的规则、设置发现（MCP 已由 `mcp.enableProjectConfig: false` 关掉）。代价：`cursor` 不是无凭证发现的 provider，但 omp 拿到 Cursor 凭证时会请求 Cursor 的模型发现端点（`packages/catalog/src/provider-models/special.ts:131-145`，经 `model-registry.ts:2428-2433` 的 `isAuthenticated` 分支），这条登记为残余（ADR-0012）。
- `local`、`web`：静态合成的 provider，不发请求（`packages/catalog/src/provider-models/special.ts:393-407`），关掉反而可能影响依赖它们的角色。

结果是 87 项，原有四项（`ollama`、`llama.cpp`、`lm-studio`、`apple`）保持在最前，其余按字母序排。

为什么不用最小集：读代码推出的最小集是 38 项，只覆盖「无凭证、无缓存」时会外联的 provider。可是只要某个 provider 拿到了凭证，`isAuthenticated` 就会让它进入发现，最小集挡不住。全集与是否有凭证无关，代价只是名单更长。

与能力发现源的撞名只有 `cursor` 一个，已经排除。这个结论要在实现时按源码复核（task 1.1）。

### D2 名单写死在宿主，靠官方用例兜底

omp 没有任何接口能枚举内置 provider：
- `omp models` 和 rpc `get_available_models` 只返回已可用的模型，而且已经应用了 `disabledProviders`；
- 没有 `--list-providers` 这类参数。

所以名单只能写死在宿主，没法做「二进制清单 vs overlay」的静态比对。兜底靠行为用例（D3）：钉住的版本上出网为零。升级 omp 时，用例在新版本上跑一遍，就能抓到新增的、无凭证也会外联的 provider；带凭证才会出现的路径，靠按 D1 规则重新生成名单来覆盖（spec 写成 SHALL）。

### D3 官方用例怎么观测

复用 `server/test/omp-official-overlay-pins.test.ts` 已有的 `proxyListener`（只记录 `CONNECT host:port`、一律回 502）和 `launch(world, overlay?, otelPin, proxyPins)`：

- `proxyPins=false`：去掉 `no_proxy` / `NO_PROXY` 两个钉。不去掉的话，omp 的请求会绕过代理直连，监听器什么也看不到。
- 工作目录 `.env` 写 `ALL_PROXY=http://127.0.0.1:<port>`。#1615 的红跑就是在这个形态下看到 7 个 `CONNECT` 的。
- **不发模型回合**：`ALL_PROXY` 也会代理回环上的 http 模型请求，监听器回 502 会让回合失败。
- 等 `get_available_models` 应答之后（rpc 内部会 `awaitBackgroundRefresh`，`packages/coding-agent/src/modes/rpc/rpc-mode.ts:2288`），再等一个固定的观测窗口：常量 5 s，沿用同文件 OTLP 用例的 `OTLP_WINDOW_MS` 量级，覆盖 refresh 之后迟到的单个 manager 请求。
- 产品 overlay 下断言监听器零命中（不只是零 `CONNECT`）：不发回合、托管 `models.yml` 也没有 `discovery`，任何命中（含明文 http）都是外联。
- world 必须是全新的：不能有 `models.db` 缓存，否则 `online-if-uncached` 在缓存新鲜时不发请求，负对照就红不起来。
- 负对照用同一 world 形态，只把 overlay 的 `disabledProviders` 换回四项。断言至少一个 `CONNECT`，并且含 `catalog.stencil.so:443`。
- 同一个产品 overlay 启动下，还要断言：
  - `get_available_models` 含 `workbuddy/<MODEL_ID>`；
  - 工作目录放 `.claude/skills/x/SKILL.md`，`get_available_commands` 含 `skill:x`（`claude` 能力发现源没被关）。
- 测试文件现在 641 行。新用例加进去后要保持 ≤800 行（size-guard）。放不下就另开 `server/test/omp-official-provider-egress.test.ts`，把要共用的辅助移到已有的 support 模块，不复制代码（jscpd）。实现时加进去会到 813 行，所以另开了文件，辅助移到 `server/test/support/omp-official.ts`。

### D4 overlay 源码形态

- `host-overlay.ts` 用一个模块内常量数组持有名单（不导出：没有消费者，knip 会报；测试从写出的文件读名单，不拿源码验证源码），固定块里按 `  - <id>` 逐行渲染。overlay 的字节由 spec 的 YAML 块决定，渲染结果必须逐字节等于 spec。
- 文件头注释改写 `disabledProviders` 一句：说明规则、三个排除项和 #1621。
- `omp-host-overlay.test.ts` 等字节断言随之更新。

### D5 `marketplace.autoUpdate: "off"`（owner 2026-10-21）

- 键是枚举 `off | notify | auto`，缺省 `notify`（tag `v18.12.3` `packages/coding-agent/src/modes/settings.ts:1139-1143`）；`main.ts:2262-2266` 每次启动以它调 `scheduleMarketplaceAutoUpdate`，`off` 时直接返回（`extensibility/plugins/marketplace-auto-update.ts`）。
- 固定块里放在 `disabledProviders` 之后、`ask:` 之前（同属出网），写成 `autoUpdate: "off"`：加引号，与已有的 `direnv: "off"` 一致，避免 YAML 把 `off` 读成布尔。
- 验证：优先做行为用例——托管 agent 目录预置一个过期的已注册 marketplace（来源是 https URL），`ALL_PROXY` 指向监听器；负对照（overlay 去掉 `marketplace` 块）看到对该来源主机的 `CONNECT`，产品 overlay 零命中。若 marketplace 注册表的格式让预置不现实，退回为：启动日志无 `Settings:` 警告 + 代码引用，在 evidence 里写明为什么退回。

## Risks / Trade-offs

- **升级 omp 后新增的内置 provider 会重新外联**：D2 用例能抓到无凭证的外联；带凭证的外联靠 spec 规定的重新生成。
- **名单有可能不全**：pi-ai 的 auth / oauth provider 表、扩展注册的 provider 都没有逐个枚举。前者全部需要凭证；后者由扩展引入，项目层扩展已经另有治理。
- **`cursor` 带凭证的发现请求**：见 D1，登记为残余。
- **将来如果有人把托管 provider 改名，与内置 id 撞上**：`disabledProviders` 会把它一起关掉。托管名固定是 `workbuddy`，不在名单里。

## Sketch seams under test

- 官方 v18.12.3 子进程：观测 `CONNECT`，以及 `get_available_models` / `get_available_commands` 的应答。
- overlay 文本字节：与 spec 的 YAML 块逐字节比对。

## Not yet specified

无。
