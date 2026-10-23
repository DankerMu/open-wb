# Design: s1d-sanitize-followups

## Context

- `server/src/core/upstream-failure.ts:123-137` `dropSecretHead`：`ordered` 为按长度降序的规范化密钥；对每个 `secret`、`length` 从 `secret.length - 1` 降到 1：`head = replaceSecrets(secret.slice(0, length), ordered)`，`text.endsWith(head)` 即记 `end = min(end, text.length - head.length)` 并 `break`（每个密钥取最长命中的前缀，整体取最大的丢弃量）；最后再与 `SK_TAIL` 取 min。`replaceSecrets`（`:99-105`）对每个密钥 `split/join`。
- 调用点：`upstreamExcerpt(text, secrets, cut)`（`:71-76`），`cut = true` 时才调用；`model-proxy/index.ts:426`（≥500 且非 504/524）、`models/probe.ts:111`（探活），二者是仅有的消费者。`cut` 来自 `core/error-body.ts:21,40-59`。
- 密钥集：`store.ts:227-234` `secrets()` 为全部已登记上游并集；`upstream-failure.ts:192-196` `baseUrlParts` 把每个 ≥ 8 的路径段单列。#1673（连接器探活）将把请求头值并入同一密钥集、复用 `upstreamExcerpt`。
- 规格：model-proxy `spec.md:79` 规定截断时「在整串密钥替换之后再丢掉末尾恰为某个密钥开头一段——按该开头经同一轮整串替换后的形状比较」；探活摘要 `"HTTP <status>：<摘要>"`（model-registry「探活」）。
- 测试：`server/test/upstream-failure-sanitize.test.ts`（cut 用例，如 `:266` 截断 base URL 头部）。
- #1718：`web/test/center-models-support.tsx:174-179` `settled()` 用 `vi.waitFor`；`web/test/center-models-form.test.tsx:179` 在其后同步断言焦点；回焦链 `use-models.ts:133`（`setForm(null)`）→ Radix FocusScope 卸载 cleanup 的 `setTimeout(0)` → `onCloseAutoFocus` → `restoreFocus()`（`form-dialog.tsx:137-140`、`panel.tsx:29-31`）。verification-harness「Web assertions await the committed outcome they check」要求等结果本身。

## Decisions

- **D1 不重写比较语义**：「替换后取前缀」≠「取前缀再替换」（较短密钥跨在前缀边界、按长度降序的逐个 `split/join` 会因长密钥失配而连锁改变），增量推导的精确改写风险高、收益只在病态输入上。保留现循环、次序与 `break` 语义，预算内输出逐字节不变。
- **D2 精确剪枝**：`replaceSecrets(p)` 的末码元只可能是 `p` 的末码元（末尾是未替换的原文）或 `]`（末尾是一次替换插入的 `[已移除]`）——`s.split(x).join(R)` 只在 `s` 以 `x` 结尾时改变末码元且改成 `R` 的末码元，`orderedSecrets` 已滤掉空串，对替换链归纳即得。据此（`secret` 为 `ordered` 里规范化之后的串）：文本末码元 `c` 既不等于 `secret[length - 1]` 也不等于 `]` → 跳过；`c === "]"` → 全部计算（预算兜底）。不再按「是否以 `[已移除]` 结尾」细分：尾部插入的 `[已移除]` 之后，替换链里更短的密钥仍可命中它的内部而改写结尾（如有序密钥 `["zzXYZw","XYZ","[已"]`、前缀 `zzXYZ` 的形状为 `zz[已移除]移除]`），细分规则不是必要条件；`]` 结尾与 `[已移除]` 结尾的开销同量级，由同一预算下限覆盖。另：`replaceSecrets` 对长度大于被扫描串的密钥不可能命中，可跳过其 `split`（同样精确）。这些都是必要条件，不改变任何结果；`text` 为空时不计算（与现状一致）。
- **D3 预算与 fail closed**：每次 `split` 记「被扫描串的实际长度 + `CALL_COST`」单位（被扫描串是替换链的中间结果，短密钥换成 5 码元的 `[已移除]` 后会变长，按实际长度计才不低估；`CALL_COST` 把每次 `split/join` 调用的固定开销折算成码元数，由实现方实测标定，使「大量短串」与「少数长串」两个极端下单位与耗时同比例）。另每次 `split` 按命中次数记 `MATCH_COST`（密集命中时每次命中的开销远大于扫描一个码元，只按扫描量计时上限会到约 900 ms），每次与文本末尾比较记「head 长度 + `CALL_COST`」（替换链里一个密钥都放不下时仍有 Σ长度级的比较开销）——实现时补入，计费只多不少、不改变任何输出。累计将超过常量 `HEAD_SCAN_BUDGET` 时停止，`dropSecretHead` 交出「失败」，`upstreamExcerpt` 返回空串——整段节选丢弃，不返回已算到一半的结果、不留任何尾部。`HEAD_SCAN_BUDGET` 的下限：50 个上游合计 300 条密钥、正文以 `[已移除]` 结尾（剪枝无效）时不触发（修复前全量比较实测约 100 ms 量级）；上限：病态输入单次 `upstreamExcerpt` 在开发机上约 200 ms 以内。常量注释写明两端实测。被剪掉的迭代不计费，开销 O(Σ|secret|)，已在线性范围内。
- **D4 范围**：只改 `dropSecretHead` 与 `upstreamExcerpt` 对其结果的处理；`redact`、`sanitizeUpstreamText`、`replaceSecrets`、`orderedSecrets`、密钥集组成都不动。会话侧（`app.ts:382`）只走 `redact`，不受影响。#1673 并入的头值是同一密钥集，自动受同一预算约束。
- **D5 证据**：
  - 参照实现：`dropSecretHead` 及其私有链（`redact`、`replaceSecrets`、`orderedSecrets`、`normalize`、`dropControls` 等）均未导出，把修复前的整条链原样拷进测试（test-local），在 `upstreamExcerpt` 层面比对。
  - 等价性：`upstream-failure-sanitize.test.ts` 全部 cut 夹具；一个「较短密钥跨在前缀边界」的新夹具（较短密钥的一部分落在较长密钥被截断的开头之内、其余在截断点之外——与 `:266` 的完全嵌入情形不同）；小规模随机输入（随机密钥集，含带 `[`、`]`、`[已移除]` 片段的密钥；正文以随机密钥前缀、`]`、`[已移除]` 结尾），均在预算内——`upstreamExcerpt(…, true)` 与参照逐字节相同。
  - 每个夹具的分支事先确定（预算按单位计，确定性），写确切期望输出，不写「或相同或为空」。
  - 红：小规模病态实例（单上游约 600 段、正文以某段开头结尾，修复前实测约 4 s）超过 1000 ms 阈值；不让 CI 跑 103 s 的原始规模作红。
  - 绿钉（各断言 `performance.now()` 差值 < 1000 ms；同步调用 `it` 超时打不断；先例 `core-base-url.test.ts`）：16 KB / 约 1780 段 + `[已移除]` 结尾 → `""`；十上游 ≥ 1000 条 + `[已移除]` 结尾 → `""`；同一 16 KB 集合 + 正文末码元不在任何密钥里（如 `}`）→ 剪枝后零候选，节选等于按净化与节选规则写出的字面期望（参照在此规模要跑约 100 s，不作比对）。剪枝后仍有大量长候选的大集合（如正文以某段开头结尾）按预算 fail closed，属预期，不另钉确切结果。
  - 超预算的确切输出：`upstreamExcerpt` 返回 `""`；代理 `statusReply(503, "")` 的 body 即 `{"error":{"message":"模型服务返回 HTTP 503","type":"wb_upstream","param":"status.503"}}`。
  - 防泄露：对预算内分支的每个夹具断言结果末尾不是任何密钥真前缀的替换形状。
  - 常规规模不触发：50 上游 300 条密钥（每上游三个 ≥ 8 的互异段），正文分别以某密钥开头一段、`[已移除]` 结尾——与参照相同、非空。
- **D6 #1718**：`:179` 改为 `await waitFor(() => expect(document.activeElement).toBe(rowButton("m2", "编辑")))`；`settled()` 的 `vi.waitFor` 换成 RTL `waitFor`（经 `asyncWrapper` 与 #1541 屏障）。不调大超时、不加 retry、不删焦点断言。红证据用扰动 setup（全部 `setTimeout(fn, 0)` 推迟到 60 ms，大于 `vi.waitFor` 的 50 ms 轮询）；扰动 setup 只放在 scratch 配置里，不入库（vitest 配置不在本 issue 范围）。

## Risks / Trade-offs

- 超预算时用户与管理员看不到上游正文节选，只有状态码（探活为 `HTTP <status>：`，冒号后为空——这是 `probe.ts:113` 模板对空摘要本来的输出，gzip 正文今天就如此；model-registry 没有空摘要的专门条款）。只发生在密钥集远超常规（> 50 上游 / 约 300 条）、正文被截断且以 `[已移除]` 结尾或剪枝后仍有大量候选时；换来事件循环不被卡住、且不泄露密钥头部。
- 预算是常量，机器快慢不同耗时不同；常量注释写明实测依据，用例耗时上界 1000 ms 相对预算上限约 200 ms 留约 5 倍余量。
- 剪枝正确性依赖 `[已移除]` 以 `]` 结尾；常量 `REMOVED` 若改动须同步（用例钉住）。

## Sketch seams

- `upstream-failure.ts`：`dropSecretHead(text, secrets): string | null`（`null` = 超预算）；`upstreamExcerpt` 遇 `null` 返回 `""`。
