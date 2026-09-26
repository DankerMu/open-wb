# Design: model-reasoning-config（#511）

权威决定见父 design D5「models.yml」段、Context「omp 事实」、Open Questions 1、Migration Plan「配置」；本文件只写本切片的审查面。

- **Change surface**：`server/src/agent-config.ts`（`resolveAgentSettings` → `AgentSettings.modelReasoning`）→ `server/src/server.ts`（`resolveServerConfig` 经展开暴露；`start()` 在 listen 之后调用 `writeManagedModelsYml(..., {proxyBaseUrl, modelId, reasoning: config.modelReasoning})`）→ `server/src/model-proxy/models-yml.ts`。
- **Must preserve**：
  - `writeManagedModelsYml` 省略 `reasoning` 或传 `false` 时输出与变更前逐字节相同（`server/test/model-proxy-models-yml.test.ts` 零 diff 全绿，其 `OPTIONS` 不含 `reasoning`）。
  - 十三项既有配置键的解析、缺省、错误消息与副作用前失败纪律不变；exact `server_started` 记录字段集不变；非法配置时 stderr 恰一行 `{"event":"server_start_failed"}`（`server.ts` 既有 catch）。
  - models.yml 仍只写 env 名 `WORKBUDDY_MODEL_TOKEN`，不写 authHeader，不读父进程凭证；字符串值仍经 `JSON.stringify` 引号化。
  - `fake-omp-proxy.mjs` 的 models.yml 行解析器（按缩进取 `providers.workbuddy` 四格键与 `- id:`）对追加的 8/10 格行不敏感——由 `server-startup-order.test.ts` #166 完整代理回合（读真实 server 写出的缺省 `on` 文件）回归证明。
- **Must add/change**：
  - `agent-config.ts`：`AgentSettings` 增 `modelReasoning: boolean`（字段文档一行）；`resolveOnOff(raw, fallback, key)` 形状的私有 resolver：`undefined` → 缺省 `true`；`raw === "on"` → `true`；`raw === "off"` → `false`；其它（含 `""`、`"ON"`、`"Off"`、`"true"`、`"yes"`、`" on"`）→ `throw new Error("MODEL_REASONING must be exactly on or off")`（消息命名键、不含输入值）。不 trim、不 lower-case。
  - `models-yml.ts`：签名 `options: { proxyBaseUrl: string; modelId: string; reasoning?: boolean }`；`reasoning === true` 时在 `"        maxTokens: 8192"` 之后、结尾空串之前插入恰三行：`"        reasoning: true"`、`"        compat:"`、`"          reasoningContentField: reasoning_content"`（模型条目键 8 格，`compat` 子键 10 格）。
  - `server.ts`：`writeManagedModelsYml` 调用增 `reasoning: config.modelReasoning`；`resolveServerConfig` 注释「十三项自有 key，agent 九项」→「十四项自有 key，agent 十项」。
- **Governing invariant**：进程环境中 `MODEL_REASONING` 的唯一解析值（缺省 `on`）决定每次启动写出的 models.yml 是否含 reasoning 声明；任何非法值在任何 filesystem/database/listen 副作用之前使启动失败；`false` 路径的字节与旧输出完全一致。
- **Sibling surfaces**：
  - 生产者：`resolveAgentSettings`（唯一解析点，不得在 server.ts/model-proxy 另读 `process.env`）。
  - 消费者：`server.ts` `start()` 的唯一 `writeManagedModelsYml` 调用点；omp v18.0.10 读取 models.yml（`ModelDefinitionSchema` `reasoning?: boolean`、`compat?: ApiCompatSchema` 含 `reasoningContentField?`，vendored `resource/oh-my-pi/packages/coding-agent/src/config/models-config-schema-bundle.ts:170-200`、`custom-models.ts:85,130`）；`fake-omp-proxy.mjs` 行解析器；CI `smoke`/`ui-walk` 以真 omp + `fake-upstream.mjs`（只校验 `messages` 数组，额外 reasoning 请求参数不被拒）运行缺省 `on`。
  - 失败路径：`server.ts` 启动 catch → generic record；非法值须在 DB 父目录、`OMP_STATE_DIR`（含 `agent/models.yml`）、sandbox 创建与 listen 之前抛出（先例 `server/test/omp-max-processes-config.test.ts` 「production entry rejects invalid OMP_MAX_PROCESSES before effects」）。
  - 既有测试联动（允许的最小联动；只改期望值，不删不放宽，每处列入 PR `偏离记录`）：`server/test/server-startup-order.test.ts:126-141` 缺省启动的 models.yml 精确 `parse` 期望，模型条目追加 `reasoning: true` 与 `compat: { reasoningContentField: "reasoning_content" }`。`listener-shutdown.test.ts:569`、`server-startup-order.test.ts:206/247` 为 `toMatchObject`/`toContain`，不受影响。`server-config.test.ts` 零 diff。其它因缺省 `on` 失败的既有断言同原则处理并逐条报告；无法仅以期望值修复则停止报告。
  - 文档：`server.ts` 注释计数（本刀）；部署文档归 9.1。
- **Seams under test**：`resolveServerConfig`（纯 config seam，source 与 compiled entry URL）；`writeManagedModelsYml`（真实临时目录）；编译后生产入口 `compileServerEntry`/`startCompiledServer`（`server-startup-helpers.ts`）。
- **Required evidence**（新文件 `server/test/model-proxy-reasoning.test.ts`；期望值取自 spec/issue，不引用源码常量）：
  1. Resolver：`MODEL_REASONING` 未设置/`on`/`off` → `modelReasoning` 为 `true`/`true`/`false`（source 与 compiled entry URL 各一次缺省断言）；`""`/`ON`/`Off`/`true`/`yes`/`" on"` → 抛错，且对**全部**非法值一律断言 `message` 精确等于固定文本 `MODEL_REASONING must be exactly on or off`（命名键；「不回显输入值」由消息与输入无关证明）。不对这些值使用 `not.toContain(raw)`：固定文本本身含子串 `ON`（`REASONING`）与 ` on`（`exactly on`），先例 `omp-max-processes-config.test.ts:125-131` 的写法在此不适用。
  2. Writer 精确字节：`reasoning: true` 输出等于逐行写出的期望文本（13 行 + 结尾换行）；`reasoning: false` 与省略 `reasoning` 输出彼此逐字节相同且等于变更前的 10 行期望文本；`yaml.parse` 后 true 变体模型条目恰多 `reasoning: true` 与 `compat: {reasoningContentField: "reasoning_content"}`、无其它新增键，false 变体两键皆无；两变体各写两次逐字节相同。
  3. 覆盖写：同一 `agentDir` 先写 `true` 再写 `false` → 第二次文件不含 `reasoning`/`compat`/`reasoningContentField` 任何子串。
  4. 生产入口非法值：编译入口以 `MODEL_REASONING` ∈ {`""`, `ON`, `true`, `yes`} 启动 → 退出码 1、stdout 空、stderr（去 node:sqlite 实验警告）恰为一行 `{"event":"server_start_failed"}\n`；db/state（含 `agent/models.yml`）/sandbox/bin 均不存在、端口未监听。
  5. 生产入口正向：编译入口缺省（未设置）启动 → `<state>/agent/models.yml` 解析后模型条目含 `reasoning: true` 与 `compat`；以 `MODEL_REASONING=off` 启动 → 两键皆无且文件字节等于 false 变体期望文本（baseUrl 取实际端口）。
  - 另：PR head 的 CI `smoke`、`ui-walk`、`uid-isolation` 全绿（真 omp v18.0.10 加载缺省 `on` 的 models.yml 并完成回合）。
- **Non-goals**：见 proposal。
- **Review focus**：resolver 精确匹配（不 trim/不 lower-case、错误不回显值）；YAML 三行的缩进与位置（`compat` 为模型条目下的 mapping，被 omp schema 接受）；false/缺省路径逐字节不变；唯一解析点与唯一写出调用点；生产入口非法值无副作用。
