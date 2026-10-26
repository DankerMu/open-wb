# Proposal: fake-upstream-skips-reminder

```text
Issue type: bugfix (test flake)
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: 测试夹具 fake-upstream.mjs 的「最后一条 user 消息」取法；做错时 omp 官方用例跨本地午夜仍偶发红，或误跳过真实用户消息让既有标记用例失效
Selected risk packs: Legacy compatibility / examples（不带提醒的既有夹具行为逐字不变）; Concurrency / shared state / ordering（不选——夹具无共享状态改动）
Evidence floor: 夹具单测（确定性构造提醒形状的 user 消息，覆盖 STATUS / ERROR / FAIL_TIMES / turn 轮次 / 带其它文字不跳过）；fake-upstream* 既有用例全绿；WORKBUDDY_OMP_TEST=1 下 omp-official-upstream-failure.test.ts 通过；make check
```

design.md omitted (compact)：与已有的图片附件跳过（#1527）同一处理，只多一个判定。

## Why

#1769：PR #1767 的 CI `uid-isolation` 里 `server/test/omp-official-upstream-failure.test.ts` 3.2 偶发红（`auto_retry_end.success` 为 `true`）。该用例跨过 runner 的本地午夜；omp v18.12.3 在日期变化时往上下文末尾追加一条 `<system-reminder>` 日期 / cwd 提醒，代理上游不支持 developer 角色时以 `user` 角色发出。假上游 `lastUserTextFrom`（`server/test/support/fake-upstream.mjs:475-484`）把它当成最后一条 user 消息，丢了 `WORKBUDDY_FAKE_STATUS=503`，第 13 次请求按无标记处理，会话重试成功。

## What Changes

- model-proxy「假上游夹具契约」：新增「最后一条 user 消息」的取法——跳过 omp 合成的图片附件消息与整段恰为一个 `<system-reminder>` 块的 user 消息；`FAIL_TIMES` 计数键取这样得到的消息文本；加一个场景。
- omp-test-harness「受控上游思考与写入标记」：非 user 消息的那句（原只点名图片附件）加上日期提醒，轮次规则与标记查找同此；加一个场景（turn scope 末尾提醒、历史中间提醒）。
- `fake-upstream.mjs`：一个判定（整段恰为一个提醒块），用在 `lastUserTextFrom` 与 `toolRoundScope:"turn"` 的轮次规则两处（与 `isImageAttachment` 同位）。
- `omp-official-upstream-failure.test.ts` 的实测行（`note()`）加上每次请求的 `messages` 数，以后再出现能从日志确认。

## Impact

- 规格：两条 requirement 修改——model-proxy「假上游夹具契约」、omp-test-harness「受控上游思考与写入标记」。
- 代码：仅测试——`server/test/support/fake-upstream.mjs`、夹具单测（`server/test/fake-upstream-failures.test.ts`、`fake-upstream-tool-rounds.test.ts`）、`server/test/omp-official-upstream-failure.test.ts`（实测行加 messages 数）。
- 不动：产品代码、`models.yml` 的 compat（备选方案改发给真实上游的线格式，不取）、omp 本身。
