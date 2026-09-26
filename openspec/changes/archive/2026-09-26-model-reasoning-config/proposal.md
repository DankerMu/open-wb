# Proposal: model-reasoning-config（#511）

## Why
父 change `s1c-session-metadata-presentation` tasks 1.2（epic #509）。深度思考折叠需要 omp 把模型当 reasoning 模型对待（请求侧 reasoning 参数、按 `compat.reasoningContentField` 回放历史思考——DeepSeek 类上游会校验历史 `reasoning_content`）；该声明写在托管 `models.yml`，其取值须是一个部署可关的启动配置键 `MODEL_REASONING`（父 design D5「models.yml」段、Open Questions 1）。解析端与写出端是同一布尔值的两端，原子交付。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 生产配置新增一键且缺省 `on` 改变缺省部署写出的 models.yml；YAML 形状须被 omp v18.0.10 `ModelDefinitionSchema` 接受)
Blast radius: 全部生产启动与全部 omp 子进程的模型配置——非法值若不在副作用前失败会半启动；YAML 键位/缩进错会让 omp 拒绝 models.yml（所有回合失败）；缺省参数若改变旧输出字节会破坏既有调用方与测试；错误消息回显输入值违反配置纪律。
Selected risk packs: Config / project setup；Public API / CLI / script entry（环境键即运维接口）；Error handling / rollback / partial outputs（副作用前失败）；Legacy compatibility / examples（缺省 `reasoning` 参数输出逐字节不变、十三项既有配置行为不变）；Schema / columns / units / field names（models.yml 键位与嵌套）；Release / packaging / dependency compatibility（omp v18.0.10 接受该 YAML）
Evidence floor: 新建 `server/test/model-proxy-reasoning.test.ts` 覆盖 design「Required evidence」全部条目（纯 resolver、writer 精确字节、覆盖写、生产入口非法值副作用前失败、生产入口 on/off 写出），正向断言先红后绿；`model-proxy-models-yml.test.ts` 零 diff 全绿；`npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR head 的 CI `smoke`、`ui-walk` 与 `uid-isolation`（真 omp v18.0.10、缺省 `on`）全绿作为 omp schema 接受该 YAML 的实证。

## What Changes
- `server/src/agent-config.ts`：`AgentSettings` 增 `modelReasoning: boolean`；新 resolver（未设置 → `true`；精确 `on` → `true`；精确 `off` → `false`；其它任何值含空串 → 抛错，消息为与输入无关的固定文本 `MODEL_REASONING must be exactly on or off`——命名键；issue「不含输入值」对 `ON`/`" on"` 这类恰为固定文本子串的值以「消息精确等于固定文本」满足）。
- `server/src/model-proxy/models-yml.ts`：`writeManagedModelsYml(agentDir, {proxyBaseUrl, modelId, reasoning?})`，`reasoning === true` 时在 `maxTokens: 8192` 之后追加三行（见 design）；否则输出与现行逐字节相同。
- `server/src/server.ts`：重写 models.yml 处传 `reasoning: config.modelReasoning`；`resolveServerConfig` 文档注释计数 十三→十四、agent 九→十。
- 新建 `server/test/model-proxy-reasoning.test.ts`。
- 既有测试联动（见 design「Sibling surfaces」）：`server-startup-order.test.ts` 缺省启动用例对 models.yml 的精确 `parse` 期望追加 `reasoning: true` 与 `compat`（缺省 `on` 的直接后果，spec「干净启动」即此行为）。偏离 issue PR Boundary（只允许 `server-config.test.ts` 改期望值）：该精确断言在缺省 `on` 下必然失败；约束为只改期望值、不删不放宽。
- `server-config.test.ts`：实测无需改动（`sevenDefaults` 是显式字段投影；A #451 的 `ompMaxProcesses` 亦未加入），与 issue 说明「仅在需要时」一致；零 diff。

## Capabilities
- MODIFIED `http-service-skeleton`「服务启动与装配」：整段取父 delta（十四项键、`MODEL_REASONING` 解析纪律、「干净启动」「override、非法配置」两 Scenario 的 reasoning 子句）。本 issue 全量交付该块父 delta。
- MODIFIED `model-proxy`「托管 models.yml」：整段取父 delta（`reasoning?` 参数、写出规则、Scenario「Reasoning declaration toggles」、覆盖写无残留）。本 issue 全量交付该块父 delta。

## Impact
- 部署：新增可选环境键，缺省 `on`；CI/Makefile 不传（CI 即以 `on` 运行）。`models.yml` 每次启动重写，无需迁移。
- 不改 exact startup record 字段集。

## Non-goals
- 宿主 thinking 链路（3.1 #514 归约、3.3 #519 合并落库）——声明不门控 thinking；fake-upstream `WORKBUDDY_THINK`（6.3 #528）；真实端点结论与部署取值（9.3a #544）；部署文档（9.1 #542）；`fake-omp.test.ts` 的自有 `managedYaml` 夹具（它不读 server 写出的文件，不改）。
