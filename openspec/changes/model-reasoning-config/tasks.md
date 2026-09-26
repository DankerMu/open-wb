# Tasks: model-reasoning-config（#511）

## 1. MODEL_REASONING（父 tasks 1.2 原文）

- [ ] 1.2 `server/src/agent-config.ts` + `server/src/model-proxy/models-yml.ts` + `server/src/server.ts`：`MODEL_REASONING` 第十四个启动配置键（缺省 `on`；只接受精确 `on`/`off`，空串与其它值在任何副作用前启动失败，同 `OMP_IDLE_MS`）；`writeManagedModelsYml(agentDir, {proxyBaseUrl, modelId, reasoning?})` 的 `reasoning` 可选、缺省 `false`（既有 `server/test/model-proxy-models-yml.test.ts` 的 `OPTIONS` 与精确 YAML 断言不改动全绿）；`reasoning === true` 时为唯一模型条目写 `reasoning: true` 与 `compat.reasoningContentField: reasoning_content`，`false`/缺省时两者皆省略，输出确定；`server.ts:272` 重写 models.yml 处传入 `MODEL_REASONING` 的解析值。验证：新建 `server/test/model-proxy-reasoning.test.ts` 断言 on/off 两种 YAML 精确文本、缺省参数与 `false` 输出逐字相同、非法值启动失败（不落任何文件）；`server/test/server-config.test.ts` 既有配置键计数/清单断言改期望值（含 `MODEL_REASONING`）

## 2. Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Config / project setup | yes | 新启动配置键与缺省 → design 证据 1（resolver 三态 + 非法值）、5（生产入口 on/off） |
| Public API / CLI / script entry | yes | 环境键即运维接口；`writeManagedModelsYml` 签名扩展 → 证据 1、2（可选参数、旧调用逐字节不变） |
| Error handling / rollback / partial outputs | yes | 非法值须在副作用前失败 → 证据 4（生产入口：退出码 1、generic record、无 db/state/sandbox/bin、未监听） |
| Legacy compatibility / examples | yes | 缺省参数输出逐字节不变、既有配置不变 → 证据 2 + `model-proxy-models-yml.test.ts` 零 diff 全绿 + `server-config.test.ts` 零 diff 全绿 |
| Schema / columns / units / field names | yes | models.yml 键位/缩进/嵌套 → 证据 2（精确字节 + `yaml.parse` 结构）、3（覆盖写无残留） |
| Release / packaging / dependency compatibility | yes | omp v18.0.10 须接受该 YAML → PR head CI `smoke` + `ui-walk` + `uid-isolation`（真 omp、缺省 `on`）全绿；`npm run build --workspace server` 0 |
| Auth / permissions / secrets | no | 仍只写 env 名 `WORKBUDDY_MODEL_TOKEN`；由既有「Credential-safe managed output」测试与 `server-startup-order.test.ts` #166 凭证不出现断言回归 |
| File IO / path safety / overwrite | no | 写出路径与所有权不变（`ensureSharedDir` + 同一文件名）；覆盖写内容由证据 3 覆盖 |
| Concurrency / shared state / ordering | no | 写出时机与 SIGTERM 扣住语义不变（`server-startup-order.test.ts:219` 回归） |
| Resource limits / large input / discovery | no | 布尔键，无新限额 |
| Documentation / migration notes | no | 部署文档归 9.1 #542；本刀只更新 `server.ts` 注释计数 |

## 3. 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/model-proxy-reasoning.test.ts`；`model-proxy-models-yml.test.ts` 与 `server-config.test.ts` 零 diff；既有测试只允许 design「Sibling surfaces · 既有测试联动」所列的期望值更新，不删、不放宽；每处列入 PR `偏离记录`。
- [ ] 每条新断言先在变更前源码上跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate model-reasoning-config --strict --no-interactive` 通过；PR head CI `smoke`/`ui-walk` 绿。
