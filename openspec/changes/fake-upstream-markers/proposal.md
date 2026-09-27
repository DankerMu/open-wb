# Proposal: fake-upstream-markers（#528）

## Why
父 change `s1c-session-metadata-presentation` tasks 6.3（epic #509）。深度思考折叠（F-CHAT-10）与文件变更/产物卡（F-CHAT-9）要在真 omp 链路（`make smoke`、`make ui-walk` 与其 CI job）上取证：需要受控上游能按需返回 `reasoning_content` 思考分片，并能让工具轮发起一次 `write`（真 omp 以 `--cwd` 解析相对路径并在 `details.resolvedPath` 报告）。现行 fake-upstream 只会 bash 工具轮 + 固定回复（父 design D13「fake-upstream 标记」）。

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: compact (agree: 测试支撑脚本 + 自带契约测试，无生产代码、无共享入口；无标记路径逐字节不变，既有消费方无需改动。所选 Legacy/Concurrency/Schema 三包的 expanded 触发条件针对产品面的 schema/共享状态/旧版兼容；此处三者都限于测试夹具内部——SSE 形状只对新标记变化、gate 状态为夹具私有、兼容面由既有 fake-upstream 测试与 CI smoke/ui-walk 回归——审查面已在 tasks.md 以 expanded design 字段写全，故保持 compact、单席位评审)
Blast radius: `make smoke`/`make ui-walk` 与 CI `smoke`/`ui-walk`/`uid-isolation` 背后的受控上游——若无标记路径的帧有任何字节变化，`chat.hurl`、ui-walk 旅程与 gate 场景会回归；若 gate 下 reasoning 分片不在 hold 前缀内，8.2a 的思考折叠走查拿不到 running 态展开。
Selected risk packs: Legacy compatibility / examples（无标记请求逐字节不变）；Concurrency / shared state / ordering（armed gate 下 hold 前缀与 release 恰一次）；Schema / columns / units / field names（SSE 分片形状：`delta.reasoning_content`、`write` 工具调用参数精确值）
Evidence floor: 新建 `server/test/fake-upstream-markers.test.ts`（真实 loopback fake-upstream）覆盖 tasks 证据 1–5；`server/test/fake-upstream.test.ts`、`server/test/fake-upstream-gates.test.ts` 零 diff 全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR head CI `smoke`/`ui-walk` 绿（无标记路径回归）。

design.md 省略（compact）：审查面与证据全部写在 tasks.md。

## What Changes
- `server/test/support/fake-upstream.mjs`：
  - 新常量 `THINK_MARKER = "WORKBUDDY_THINK"`、`WRITE_MARKER = "WORKBUDDY_WRITE"`、`THINK_PARTS = ["先读需求，", "再列要点，", "最后作答。"]`、`WRITE_ARGS = JSON.stringify({ path: "workbuddy-report.html", content: "<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n" })`。
  - 标记判定走既有 `lastUserTextFrom(messages).includes(<marker>)`（与 walk 标记同一查找，可组合）；错误标记仍最先判定。
  - 工具轮（`!hasToolRole`）：带 `WRITE_MARKER` 时 `toolFrames` 发 `function: {name: "write", arguments: WRITE_ARGS}`，否则发原 bash 调用；其余分片（`role`、`index`、`id`、`type`、finish `tool_calls`）不变。
  - 作答轮：带 `THINK_MARKER` 时，`textFrames` 与 `holdFinal` 在 `role` 分片之后、首个 `content` 分片之前插入三个 `{reasoning_content: <part>}` 分片；armed gate 下它们属于 hold 前发出的前缀（`role`、三个 reasoning、`REPLY_PARTS[0]`），`remaining` 不变。
  - 无任一标记：所有路径输出逐字节不变。
- 新建 `server/test/fake-upstream-markers.test.ts`。

## Capabilities
- ADDED `omp-test-harness`「受控上游思考与写入标记」：整段取父 delta。本 issue 交付该 requirement 父 delta 的全部内容。

## Impact
- 仅测试支撑脚本与新测试文件；无生产代码改动；`chat.hurl`、ui-walk 与既有 fake-upstream 测试零改动。

## Non-goals
- fake-omp `thinking`/`edit-write` 场景（6.1 #518）与 probe `cwd=`（6.2，已交付）；`smoke/session-meta.hurl` 与 ui-walk 对标记的消费（8.1 #539、8.2a #540）；model-proxy 中继与 omp 对 `reasoning_content` 的解析（不改）；`MODEL_REASONING`（1.2，已交付）。
