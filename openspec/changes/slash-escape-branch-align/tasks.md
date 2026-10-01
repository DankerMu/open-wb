# Tasks: slash-escape-branch-align（#555）

## 10. Slash 命令 — prompt 转义与分支对位（父 tasks 10.4b 原文）

- [ ] 10.4b `server/src/sessions/rest.ts` prompt 路由 `supervisor.prompt(id, toWireText(text, listSkills(agentDir)))`（`acceptPrompt` 仍收 trim 原文）+ A 的 `server/src/sessions/turn-control.ts` regenerate/fork：分支对位（按 id 序 U × 列表序 E 首次匹配，`E.text === toWireText(U.content)` 或 `=== U.content`，不匹配跳过 U 不消耗 E）取代 A 的相等/序号规则；regenerate 要求末条 user 对位到最后条目否则 502；fork 取 `messageId` 的对位条目否则 502 并删新行；锚点 `classifyPrompt` 为 `builtin|skill` → 409 busy 检查之后、占用登记与任何帧之前 400 `bad_request` 无行变更；fork `draft` 改为所存正文。验证：新建 `server/test/session-rest-slash.test.ts`（经 `createApp` + stub supervisor：七条输入的持久化原文与 wire 文本、标题取原文；「Slash text reaches storage as typed and omp as decided」）、`server/test/turn-control-slash.test.ts`（真实 fake `branch --branch-entry`：`/todo` 锚点 regenerate 400、`/skill:weekly-report 写周报` 锚点 fork 400 皆无占用/spawn/帧/行变更；存储 `/todo`,`/help 这是什么` + 条目尾 ` /help 这是什么` → regenerate 202；存储 `/todo`,`继续` + 条目尾 `继续` → fork 201 且 `draft` 为 `继续`；B 前历史 `/legacy` 对条目 `/legacy` 按原文匹配 201 且 `draft` `/legacy`；「Command-anchored regenerate and fork」）；A 的既有 regenerate/fork 用例零 diff；`session-rest.test.ts`（769）不增长；`bash scripts/size-guard.sh` 退出 0，knip 零新增

> 上文为父 tasks 原文。与之不同处以本 change 的 proposal「偏差」1–7 与 design 为准（代码在 `branching.ts`；regenerate 只比末对；候选不经 `toWireText`；fork 用例的存储历史先含固定列表两条）。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | prompt/regenerate/fork 状态码、`draft` → 证据 1、5–12 |
| Auth / permissions / secrets | yes | 白名单外命令不得原样到 omp；持久化不带转义 → 证据 1、3、7、11 |
| Concurrency / shared state / ordering | yes | 409 先于 400；无占用残留；admission 同步段 → 证据 5、6、8 |
| Error handling / rollback / partial outputs | yes | 400/502 无行变更、无新会话行、无 `branch` 帧 → 证据 5、8、12、14 |
| Legacy compatibility / examples | yes | A 用例零 diff；B 前历史原文对位；skill 集合漂移 → 证据 10、13、既有测试 |
| File IO / path safety / overwrite | no | 只调用 #551 的 `listSkills` |
| Schema / columns / units / field names | no | 不涉库结构 |
| Config / project setup | no | `agentDir` 接线已在 #551 |
| Resource limits / large input / discovery | yes | `listSkills` 进入 prompt 热路径且目录对 omp uid 可写（#706）：非 `/` 文本不求值 → 证据 3、9 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；A 的既有 regenerate/fork 测试文件与 `session-rest.test.ts` 零 diff。
- [ ] RED 集合以 design「Required evidence」括注为准（1、4、5、7、8、9、11、14 先红；其余为 characterization）：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate slash-escape-branch-align --strict --no-interactive` 通过。
