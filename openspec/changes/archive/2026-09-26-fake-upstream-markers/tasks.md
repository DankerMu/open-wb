# Tasks: fake-upstream-markers（#528）

## 6. omp-test-harness — fake-upstream（父 tasks 6.3 原文）

- [ ] 6.3 `server/test/support/fake-upstream.mjs` 两个 prompt 文本标记（与 `WORKBUDDY_UI_WALK:<uuid>` 同一「最后 user 文本子串」查找，可组合）：`WORKBUDDY_THINK` → 作答轮在不变的正文分片前先发三个 `reasoning_content` 分片（拼接恰为 `先读需求，再列要点，最后作答。`）；`WORKBUDDY_WRITE` → 工具轮（`toolFrames` :366 旁新增分支）改发 `write {"path":"workbuddy-report.html", …}` 而非 bash；无标记请求逐字节不变。验证：新建 `server/test/fake-upstream-markers.test.ts` 断言三种组合的 SSE 分片序列与无标记请求字节不变；既有 `fake-upstream.test.ts`/`fake-upstream-gates.test.ts` 不改动全绿

## 审查面（compact，代 design.md）
- Must preserve：无任一标记时 `toolFrames`/`textFrames`/`holdFinal`/`serveChat` 输出逐字节不变（错误标记 500 优先、409 held、release 恰一次、TTL/close 销毁）；控制面（arm/release）与鉴权不变；`fake-upstream.test.ts`、`fake-upstream-gates.test.ts` 零 diff。
- Governing invariant：标记只由最后一条 user 文本子串决定；`WORKBUDDY_THINK` 只影响作答轮（在 `role` 之后、首个 `content` 之前恰三个 reasoning 分片），`WORKBUDDY_WRITE` 只影响工具轮（bash → write）；二者与 walk 标记、彼此独立可组合。
- Sibling surfaces：`serveChat`（错误标记优先与轮次分派）、`serveFinal` 的两处 `textFrames` 调用（无 walk 标记；walk 标记但 gate 缺失/未 armed）与 `holdFinal`（gate 前缀与 `remaining`；其开头 `gate.phase !== "armed"` 回落 `textFrames` 分支不可达——`serveFinal` 已判 armed 后同步调用——实现时同样传入 think 标志以保持一致，但只靠代码审查，不写测试、不计入覆盖）、`textFrames`、`toolFrames`；消费方 CI `smoke`/`ui-walk`/`uid-isolation`（经 `.github/scripts/ci-fake-upstream.sh` 起本脚本，不带标记）。
- 证据（新文件 `server/test/fake-upstream-markers.test.ts`，经真实 loopback fake-upstream 与 `fake-upstream-helpers.ts` 的 `startTrackedFakeUpstream`/`streamSnapshot`/`parseDataRecords`；每条标记断言先在脚本未改时跑红）：
  1. 作答轮（messages 含 `tool` 角色消息）+ 最后 user 文本含 `WORKBUDDY_THINK`，分两种情况各跑一次并各断言完整分片序列：(a) 不带 walk 标记（`serveFinal` 首个 `textFrames` 分支）；(b) 带 `WORKBUDDY_UI_WALK:<uuid>` 但该 gate 未 arm（`serveFinal` 末尾 `textFrames` 分支，ui-walk 平时即走此路）。数据记录依次为：`delta:{role:"assistant"}`；三个 `delta` 恰为 `{reasoning_content:"先读需求，"}`、`{reasoning_content:"再列要点，"}`、`{reasoning_content:"最后作答。"}`（拼接恰为 `先读需求，再列要点，最后作答。`）；与无标记作答轮相同的全部 `content` 分片；finish `stop`；`[DONE]`。
  2. 同 1 但带 `WORKBUDDY_UI_WALK:<uuid>` 且该 gate 已 armed → hold 前已收到 `role`、三个 reasoning、`REPLY_PARTS[0]` 的 content 分片且流未结束；release 后恰一次收到与无标记 gate 场景相同的剩余 content 分片、finish、`[DONE]`。
  3. 工具轮（无 `tool` 历史）+ `WORKBUDDY_WRITE` → 恰一个 tool_call：`function.name === "write"`、`function.arguments` 与 `{"path":"workbuddy-report.html","content":"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n"}` 的 JSON 串逐字相同，finish `tool_calls`，流中无 `bash`；同请求去掉标记 → 原 bash 调用（`name === "bash"`、参数等于既有 `TOOL_ARGS` 期望）。
  4. `WORKBUDDY_THINK WORKBUDDY_WRITE` 组合：工具轮为 `write`（且无 reasoning 分片），作答轮带三个 reasoning 分片与不变正文。
  5. 无任一标记的工具轮、作答轮（无 gate、walk 标记未 arm、armed gate 的 hold 前缀与 release 剩余）→ 与改动前逐字节相同。入库断言方法固定为：取 `parseDataRecords` 的原始 record 字符串（不解析），以正则把 `chatcmpl-<uuid>`、`call_<uuid>`、`"created":<n>` 规范化为固定占位，再与测试内字面量期望串逐项 `toEqual`（能捕获 delta 键顺序变化；禁止用解析后的 deep-equal 代替）；并断言全流不含 `reasoning_content` 子串、工具名为 `bash`。以改动前脚本（`git show origin/master:server/test/support/fake-upstream.mjs`）为对照的一次性逐字节比对放 scratchpad，结果写入 PR（不入库）。
  - 另：`WORKBUDDY_FAKE_ERROR` 与 `WORKBUDDY_THINK`/`WORKBUDDY_WRITE` 同时出现 → 仍为 500 错误（错误标记优先）。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | 无标记路径逐字节不变 → 证据 5 + 既有两份 fake-upstream 测试零 diff 全绿 + PR head CI `smoke`/`ui-walk` 绿 |
| Concurrency / shared state / ordering | yes | armed gate 下 hold 前缀与 release 恰一次 → 证据 2 |
| Schema / columns / units / field names | yes | SSE 分片形状与 write 参数精确值 → 证据 1、3、4 |
| Error handling / rollback / partial outputs | yes | 错误标记优先级不被新标记改变 → 证据「另」一条 |
| Public API / CLI / script entry | no | 脚本入口、端口/环境键与控制面不变 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | fake-upstream 只发工具调用，不写文件；真实写入由 omp 执行，归 8.x 取证 |
| Auth / permissions / secrets | no | bearer 校验不变（既有测试回归） |
| Resource limits / large input / discovery | no | 新增分片为常量 |
| Release / packaging / dependency compatibility | no | 仅测试文件 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/fake-upstream-markers.test.ts`；`fake-upstream.test.ts`、`fake-upstream-gates.test.ts`、`fake-upstream-helpers.ts` 零 diff（如需新辅助写在新测试文件内）。
- [ ] 每条标记断言先在脚本未改时跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-upstream-markers --strict --no-interactive` 通过；PR head CI `smoke`/`ui-walk` 绿。
