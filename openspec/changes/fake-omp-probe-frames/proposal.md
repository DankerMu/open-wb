## Why
这是父 change `s1c-turn-control-governance` 的 tasks 6.4（epic #448，issue #459）。

后续宿主测试要用真实 fake-omp 子进程，证明宿主写入 stdin 的帧次序：
- 2.1a #460：`extension_ui_response` 恰好写一次；
- 4.2a #473：所有 `extension_ui_response` 都在唯一一帧 `abort` 之前；
- 2.2b #488 与 4.2b #490：`prompt` 之后恰有一帧 `abort`。

现在的 probe 回报以 `wrote=<ok|errno>` 结尾，fake 也不记录入站帧，宿主没有可观察的证据。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: probe 回报是一行带标签的文本格式，`parseLabeledReport` 是它的解析器。本 issue 改变这个格式的精确字符串，并必然改动两个既有测试文件的期望值，expanded 的「schema/file format + parser」触发条件成立。允许改动清单要写在 design.md 的 Sibling surfaces，compact 没有 design.md。先例 #458 也把 compact 覆写成了 expanded)
Blast radius: #460/#473/#488/#490 的入站次序断言。如果记录点或过滤规则写错，这些用例会证明假命题，例如把 probe 之后才到的帧算进 `frames=`，或者漏记被静默忽略的 `abort`。如果 probe 字符串与两处消费者不同步，本地 fake-omp 契约测试或 CI `uid-isolation` job 会变红。
Selected risk packs: Schema / columns / units / field names；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs；Auth / permissions / secrets
Evidence floor: 新建 `server/test/fake-omp-frames.test.ts`（真实子进程）覆盖 tasks.md 证据 1–5。两处既有测试只按 design.md 的允许改动清单改期望值。`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0，`fake-omp.mjs` ≤800 行。PR body 附 CI `uid-isolation` job 在 PR head 上的绿色运行链接。

## What Changes
- `server/test/support/fake-omp.mjs`：
  - 模块级增加一个入站类型数组。
  - `onLine` 在 `JSON.parse` 成功之后、`dispatch` 之前，若 `typeof frame?.type === "string"` 就追加这个 type。
  - `probeReport` 的模板末尾追加 ` frames=${<数组>.join(",")}`。
  - 其它出站帧一律不变。
- `server/test/fake-omp.test.ts:754`：`expectedProbeReport` 的模板末尾追加 ` frames=negotiate_protocol,get_state,prompt`。
- `server/test/linux/uid-isolation.test.ts`：
  - `:41` 的 `REPORT_LABELS` 末尾加 `"frames"`；
  - `:301` 之后在返回对象里加 `frames: requiredValue(values, 7),`。
- 新建 `server/test/fake-omp-frames.test.ts`。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp probe 回报」：取父 delta 整段逐字，本 issue 全部交付。主 spec 的 4 个 Scenario 原样保留，新增「probe 报告带 frames 字段」「入站帧次序回报」。
- ADDED `omp-test-harness`「假 omp 入站帧记录」：段落逐字取父 delta，只带 Scenario「记录只含类型且按到达顺序」。Scenario「延迟握手期间停止 → 帧序 prompt,abort」需要 `slow-ready`，留给 6.5 #461。
- 「假 omp 进程契约」不改动。

## Impact
- 只涉及测试支撑脚本、两个既有测试文件的期望值与标签表，以及一个新测试文件。不触碰 `server/src/**`、`fake-omp-helpers.ts` 与其它 fake-omp 消费者。
- 行数：`fake-omp.mjs` 现为 788 行，预计净增 5 行（到 793），上限 +12 / 800。#461 与 #470 只剩约 7 行余量，必须先做纯拆分。

## 偏离与决定
- 消费者编号更正：派单写的「4.2b #467?」有误。经 `gh issue view` 核对，4.2b 是 #490，#467 是 5.1b regenerate 路由，不消费 `frames=`。消费者是 #460、#473、#488、#490。#474 明确不 probe `frames=`（`gh issue view 474` 正文）。
- carry-forward 的「#459 必须先纯拆分 fake-omp.mjs」不适用：本改动净增约 5 行，不超过 800，拆分义务转给 #461/#470。
- 空行与非法 JSON 行无法经 `Session.write`（它会 `JSON.stringify`，`fake-omp-helpers.ts:118-122`）写入。新测试文件按 `fake-omp-abort.test.ts` SIGTERM 用例的先例，直接 `spawn` fake 并写原始字节；`fake-omp-helpers.ts` 不改。
- `uid-isolation.test.ts` 不新增 `expect(parsed.frames)`。那是新断言，不属于改期望值；宿主侧 `frames=` 断言按 issue Out of Scope 归 2.2b/4.2a/4.2b。`frames` 标签的存在由 `parseLabeledReport` 保证：缺 ` frames=` 时它抛 `probe report missing frames=`。`wrote` 不带后缀，由既有 `expect(parsed.wrote).toBe("ok")`（`:238`）证明。

## Non-goals
- 任何 scenario 的出站帧变化；新增 scenario（6.5 #461 `slow-ready`、6.6 #470 `approval-chain-abort-ignored`）。
- 宿主侧使用 `frames=` 的断言（#460/#473/#488/#490）。
- `dispatch` 把非字符串 `type` 按属性键强转的既有行为（例如 `{"type":["prompt"]}` 会命中 `handlePrompt`）。它不在记录范围内，也不在本 issue 修改范围内。
- 给记录设上限或按 probe 清空：记录按进程累积，fake 进程都是短命的测试进程。
