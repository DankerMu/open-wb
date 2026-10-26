# Tasks: models-probe-identity

> 单 issue 单 PR（#1760，来源 Epic #1668 收尾路由）；本 fixture 随该 PR 合入。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 是 | 探活与 DELETE / POST / PUT 不同链；以行身份做条件写回，1.2 三条在途用例 |
| Error handling / rollback / partial outputs | 是 | `changes = 0` 的两种分流（404 先于 `within`、丢弃不跑 `within`），审计与写回同事务 |
| Auth / permissions / secrets | 是（只核对） | 身份含 `upstream_api_key`，只在 store 内比较，不进响应、审计、日志 |
| Public API / CLI / script entry | 否 | 路由、应答形状、状态码集合不变（404 已在规格内） |
| Schema / columns / units / field names | 否 | 不改表 |
| Config / project setup | 否 | 无 |
| File IO / path safety / overwrite | 否 | 探活不写文件 |
| Resource limits / large input / discovery | 否 | 期限与读上限不变 |
| Legacy compatibility / examples | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只改 `rest.ts` 头注释（1.3） |

Must-preserve：
- 「四种结果」「带查询串的上游地址」两场景与既有 `server/test/models-probe.test.ts` 用例全部不改且保持绿，含在途 DELETE（不重建）→ 404、无审计，与同 id 并发串行。
- 审计 detail 恰 `{modelId, status}`；探活不刷新快照、不发布、不动 `updated_at`。
- 密钥不进响应、审计、stdout/stderr。

## 1. 探活按行身份写回

- [ ] 1.1 核对 Context：`server/src/models/store.ts`（`recordProbe`、`finish`、`created_at` 单调写法）、`server/src/models/rest.ts`（探活路由与 `perIdChain`、头注释）、`server/src/models/registry.ts`（`lookup` / `secrets`）、参照 `server/src/connectors/store.ts` 的 `ProbeIdentity` / `probeTarget` / `recordProbe` 与 `server/src/connectors/rest.ts` 探活路由；`grep -rn recordProbe server/src server/test` 的调用方：`server/src/models/rest.ts:36`（store 方法的 `Pick` 联合，需加 `probeTarget`）、`:231`，`server/test/models-store.test.ts:433-502`、`:519`（`within` 的 it.each 表）、`:692`（密钥不外泄用例）（直接调用 `recordProbe`，签名改后同步改写，断言语义不弱化，并加 store 层的身份分流用例：删后重建 → `not_found`、上游变了 → 返回当前行且不跑 `within`、只改 name → 写入）。
- [ ] 1.2 测试先行（`server/test/models-probe.test.ts`，复用 `holdServer` 等既有夹具；**用非缺省 id**，如既有在途删除用例的 `hang`——`openModelsWorld` 把 `m1` 种为缺省行，删缺省行是 409 `model_in_use`；下文 `m1` 只是占位名）：(a) 探活挂起 → `DELETE m1` 204 → `POST /api/models` 换上游重建 `m1` → 放行：404 `not_found`，新行 `probe` 为 `{never,null,null}`，`model.probe` 审计 0 条；(b) 探活挂起 → `PUT m1` 换上游地址 → 放行：200，视图 `probe` 等于 PUT 之后的值，无审计；(b') 同上但只填新密钥；(c) 探活挂起 → `PUT m1` 只改 `name` → 放行：200，`probe` 为本次结果，审计恰 1 条；(d) 「轮到时才读」：探活 A 挂在 `holdServer` 上，同 id 再排一个探活 B，其间 `PUT` 把上游换成假上游（新密钥），放行 A：A 200、结果丢弃、无审计；B 探的是新上游，结果 `ok`、审计恰 1 条，假上游 `modelsRequests()` 恰 1 次且 bearer 为新密钥。(b)(b') 除视图外照 `expectProbed` 查表断言三列探活状态未变。修复前 (a)(b)(b')(d) 必须为红（记录输出），(c) 修复前后都绿。store 层（`models-store.test.ts`）：未知 id 的 `not_found` 用例改签名后手工构造 identity，断言不弱化。
- [ ] 1.3 实现：store 新增 `probeTarget(id): {upstream: {baseUrl, apiKey} | undefined, identity: {createdAt, upstreamBaseUrl, upstreamApiKey}} | undefined`（上游与身份同一次表读；上游形状与 `registry.lookup(id)?.upstream` 相同，使 `probeUpstream` 调用不变）；`recordProbe(id, identity, result, within?)` 改为 `UPDATE … WHERE id = ? AND created_at = ? AND upstream_base_url IS ? AND upstream_api_key IS ?`，`changes = 0` 时同事务重读：行不在或 `created_at` 不同 → `not_found`（不跑 `within`），否则丢弃、不跑 `within`、返回当前行。rest 探活路由：`serial(id, …)` 内先 `probeTarget`（undefined → 404，不发请求），`upstream` 为 undefined → `NO_UPSTREAM`；不再读 `registry.lookup`，删去链外的 `store.get` 预检（404 改在链内给出；「401/403/400/404 都先于任何上游请求」用例保持绿）；头注释改写探活一段，`rest.ts:58`「探活读 `lookup` 与 `secrets`」同步。`Registry.lookup` 不再被 rest 使用：从 `rest.ts:51` 的接口与 `server/src/app.ts:411` 的 `Pick` 一并删除。`name` / `updated_at` 不进身份。`probeTarget` 的上游按 `routeOf` 的规则构造（`upstream_api_key IS NULL` → undefined，否则 `upstreamOf(raw)` 的原始列值，不套 `withoutUserinfo`），身份两列取原始值、以 `IS` 比较。密钥出口：`store.ts:5` 头注释把 `probeTarget` 列为第三个允许读出密钥的方法（只供探活路由），`models-store.test.ts:683` 的用例名与范围同步，并注明 `probeTarget` 的返回值不推进它的 `outputs`。
- [ ] 1.4 `npm test --workspace server`、`scripts/size-guard.sh`、`make check` 通过（已知 flaky `server-startup-office.test.ts` #1751 除外，须注明）。

Suggested fixture level: compact - 照搬已合入的连接器写法，单路由单 store 方法。
