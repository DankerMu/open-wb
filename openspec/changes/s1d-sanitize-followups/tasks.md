# Tasks: s1d-sanitize-followups

> 两个 issue 各一个 PR，按 1 → 2 串行；本 fixture 随第一个 PR 合入。owner 2026-10-23「只解决立 issue 的问题，然后准备本 epic 验收」。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 事件循环阻塞（同步 CPU） | 是 | 组 1 病态规模耗时钉住 |
| 凭证泄露（截断密钥头部漏网） | 是 | 组 1 等价性参照 + 超预算不留尾部 |
| 测试稳定性 | 是 | 组 2 扰动 setup 红绿 |

## 1. 截断尾部比较的预算（#1716）

- [x] 1.1 核对 Context：`upstream-failure.ts:71-76,99-137,192-196`、`error-body.ts:21,40-59`、`model-proxy/index.ts:426`、`probe.ts:111`、`upstream-failure-sanitize.test.ts` 的 cut 用例。
- [x] 1.2 测试先行（design D5）：参照整条私有链拷入测试；等价性（既有 cut 夹具 + 跨边界夹具 + 含 `[`/`]`/`[已移除]` 片段与 `]` 结尾的小规模随机）；红（约 600 段病态实例在修复前超 1000 ms，记录耗时）；绿钉三例：16 KB / 约 1780 段 + `[已移除]` 结尾 → `""`、十上游 ≥ 1000 条 + `[已移除]` 结尾 → `""`、同一 16 KB 集合 + `}` 结尾 → 字面期望（`performance.now()` 差值 < 1000 ms）；超预算确切输出（`""`、`statusReply(503, "")` body）；预算内夹具尾部不是任何密钥真前缀的替换形状；常规规模（50 上游 300 条，段长 ≥ 8，含 `[已移除]` 结尾）与参照相同、不触发。
- [x] 1.3 实现 design D2–D3：剪枝 + 按实际扫描长度计费的 `HEAD_SCAN_BUDGET` / `CALL_COST`（常量注释写明两端实测）+ `null` → `""`；`dropSecretHead` 注释同步。server 现有测试全绿，`make check` 通过。

Suggested fixture level: expanded - 事件循环阻塞 + 凭证泄露。

## 2. center-models 焦点等待（#1718）

- [ ] 2.1 测试先行：用扰动 setup（全部 `setTimeout(fn, 0)` 推迟到 60 ms）跑 `center-models-form.test.tsx` 与 `center-models-list.test.tsx`，修复前恰红 `:179`（记录命令与输出）。
- [ ] 2.2 `:179` 改为 `await waitFor(...)` 等焦点；`settled()` 改用 RTL `waitFor`；不调大超时、不加 retry、不删断言。扰动下全部 center-models 用例文件全绿；CPU 满载下连跑 N 次全绿（N 写进 PR）；不加扰动的 `npm test --workspace web`（含 coverage）通过；`make check` 通过。扰动 setup 只在 scratch，不入库。

Suggested fixture level: compact - 只改测试。
