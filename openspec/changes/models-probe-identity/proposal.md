# Proposal: models-probe-identity

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: POST /api/models/probe 的写回与审计；做错时旧上游的探活结果写到新登记的同 id 行或换过上游的行，并记一条不实的 model.probe 审计
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Auth / permissions / secrets（只核对密钥仍不外泄）
Evidence floor: server/test/models-probe.test.ts 三条新用例（删后重建、PUT 换上游、只改名）+ 既有在途删除与串行用例；npm test --workspace server；make check
```

design.md omitted (compact)：照搬已合入的连接器写法（`server/src/connectors/store.ts` `probeTarget` / `recordProbe`，PR #1759 `ba03577b`），不新造机制。

## Why

#1760：`server/src/models/store.ts` `recordProbe` 只按 `id` 写回（`UPDATE … WHERE id = ?`），探活路由在串行链外先 `store.get` 判存在、再取注册表快照的上游（`server/src/models/rest.ts` 探活路由）。探活在途时管理员删掉 `m1` 再以同 id 重新登记，旧上游的结果会写到新行上、记一条 `model.probe` 审计、应答 200——违反 model-registry「探活」现文「在途期间该行被删除时结果 SHALL 丢弃、响应 404」。在途 `PUT` 换上游时旧结果同样落库，看起来像新上游刚探过；连接器侧已对同一情形裁定为丢弃（connectors「连接器探活」）。

## What Changes

- model-registry「探活」：上游与行身份（`created_at` + 上游两列）在串行链内同一次表读取得；删后重建 → 404、无审计；在途 PUT 改上游 → 丢弃、无审计、应答当前视图；只改其它列照常写入。加三个场景。
- `models/store.ts`：新增 `probeTarget(id)` 返回 `{upstream, identity}`；`recordProbe(id, identity, result, within)` 改为带身份的条件 UPDATE，`changes = 0` 时同事务重读判 404 或丢弃。
- `models/rest.ts`：探活路由在 `serial` 链内调 `probeTarget`（行不存在 404、不发请求；无上游即 `未配置上游`），不再读 `registry.lookup`；头注释同步。`registry.secrets()` 仍取快照（只用于净化）。

## Impact

- 规格：model-registry 一条 requirement 修改，不增删 requirement。
- 代码：`server/src/models/store.ts`、`server/src/models/rest.ts`；用例 `server/test/models-probe.test.ts`、`server/test/models-store.test.ts`（`recordProbe` 直接调用方）。
- 不动：探活判定与摘要规则、审计 detail 形状、PUT 是否复位探活状态（另一裁定，out of scope）、web、连接器侧。
