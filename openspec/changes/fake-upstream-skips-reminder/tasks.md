# Tasks: fake-upstream-skips-reminder

> 单 issue 单 PR（#1769）；本 fixture 随该 PR 合入。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Legacy compatibility / examples | 是 | 不带提醒的请求行为逐字不变；`fake-upstream*` 全部既有用例不改且全绿 |
| Error handling / rollback / partial outputs | 否 | 夹具应答形状不变 |
| Concurrency / shared state / ordering | 否 | 不动 `FAIL_TIMES` 的计数结构，只是键取自跳过提醒后的消息 |
| Public API / CLI / script entry | 否 | 夹具 `start()` 与 CLI 不变 |
| Schema / columns / units / field names | 否 | 无 |
| Auth / permissions / secrets | 否 | 无 |
| Config / project setup | 否 | 不设 TZ、不改 CI |
| File IO / path safety / overwrite | 否 | 无 |
| Resource limits / large input / discovery | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只改两份规格 |

Boundary：
- 可改：`server/test/support/fake-upstream.mjs`（判定与两处使用；现 741 行，size-guard 上限 800，注释控制篇幅）、夹具单测文件（`server/test/fake-upstream-failures.test.ts`；轮次规则与历史中间的提醒两例放 `fake-upstream-tool-rounds.test.ts`）、`server/test/omp-official-upstream-failure.test.ts`（`note()` 加每次请求 messages 数——作为新增的可选参数，不替换 `requests`，`d-no-connect` :322 传的是 `world.stalled.accepted()`；4.4(b) `stop-in-backoff` :462-471 直接 `console.log` 的实测行同样加上）。
- 只读：产品代码、`fake-upstream-failures.mjs`（计数以传入的 text 为键，不需改）。

Must-preserve：
- 不带提醒的既有夹具行为逐字不变（`fake-upstream*.test.ts` 全绿、断言不改）。
- 图片附件消息的跳过不变（omp-test-harness「omp 补的图片附件消息不算用户回合」）。
- 不加 TZ、不加超时、不加重试。

## 1. 假上游跳过 omp 的日期提醒

- [ ] 1.1 核对 Context：`server/test/support/fake-upstream.mjs`（`lastUserTextFrom` :475-484、`userText`、轮次规则 :548-571、`isImageAttachment` :573-580、各标记消费者）、`server/test/support/fake-upstream-failures.mjs`（:33-39、:59-73 计数键）、`server/test/omp-official-upstream-failure.test.ts`（`note()` :155、各调用点）、omp v18.12.3 提醒模板形状（issue #1769 所引 `date-cwd-reminder.ts` / `prompts/system/date-cwd-reminder.md`；若本机 `var/omp/omp` 可用，可用 `strings` 核对模板字面）。
- [ ] 1.2 测试先行（确定性构造，不跨午夜；提醒字面用 omp v18.12.3 真实模板，见两份 spec delta 的场景）：model-proxy 场景四例（STATUS + 末尾提醒 → 503；ERROR + 末尾提醒 → 500；FAIL_TIMES=2 四次 → 503、503、无标记、无标记；提醒与原文以 `\n` 拼接的首条 user 照常算，按其标记应答）与 omp-test-harness 场景两例（`toolRoundScope:"turn"` 下末尾提醒不开启新回合；默认 scope 下提醒在历史中间不遮住 `WORKBUDDY_THINK`）。真实提醒是字符串 content；数组（单 text 部分）形状作防御性覆盖一例。修复前除「换行拼接」一例外都必须为红（记录输出）。
- [ ] 1.3 实现：`isReminderOnly(message)`——`userText(message.content)` 去首尾空白后以 `<system-reminder>` 开头、以 `</system-reminder>` 结尾、且 `<system-reminder>` 只出现一次；`lastUserTextFrom` 与轮次规则在 `isImageAttachment` 旁一并跳过它。`note()` 的实测行加 `messages`：每次请求的 messages 数组长度（取自 `world.upstream.requests()` 的记录）。
- [ ] 1.4 `npx openspec validate --all --strict --no-interactive`（`make check` 不跑它）、`npm test --workspace server`、`WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" npx vitest run test/omp-official-upstream-failure.test.ts --coverage=false`（server/ 下；`var/omp/omp` 缺失时先 `make omp-fetch`）、`scripts/size-guard.sh`、`make check` 通过。

Suggested fixture level: compact - 夹具一个判定，同位于已有的图片附件跳过。
