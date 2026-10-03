# Tasks: todo-export-import-escape（#704）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `slash-commands.ts`：`classifyPrompt` 的 `todo` 子命令规则（spec delta 原句）；JSDoc 同步。
- [ ] 1.2 `server/test/slash-commands.test.ts`：spec delta 新 Scenario 的十一个输入逐个断言 `classifyPrompt` 与 `toWireText`。
- [ ] 1.3 `server/test/session-rest-slash.test.ts`（inject + stub supervisor）：`/todo export /abs/x.md` 的持久化正文为原文、stub 收到的 wire 文本带前导空格。
- [ ] 1.4 `server/test/turn-control-slash.test.ts`：regenerate 与 fork 以 `/todo export …` 为锚点时按普通文本对位（不 400）。
- [ ] 1.5 不改其它被跟踪文件（父 design 的更正由编排方做）。

## Must preserve
- `/todo`、`/todo append …`、`/compact…`、`/skill:<已装>` 的分类与 wire 形态不变；既有 slash 相关测试全绿。
- `make smoke` 与 `make ui-walk` 的 `/todo` 步骤不变。

## Required evidence
- E1 RED→GREEN：1.2–1.4 的新用例在未改 `slash-commands.ts` 时失败，改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 真 omp 证据（本机长驻栈，官方 omp v18.0.10 + 受控假上游）：同一会话发送 `/todo append x`（omp 原文回复，无步骤），再发送 `/todo export <沙箱外的临时绝对路径>`：该路径下无文件产生，回合为普通模型回合（假上游的固定回复），用户消息正文为原文。对照：在未改的构建上同样两步，记录该路径下是否产生文件（证明通道原本存在）。临时路径放在 scratch 目录下，结束后清理。
- E4 `make smoke`（CI wrapper，全新状态）一遍全绿。
- E5 `make lint`、`make typecheck`、`make anti-drift`、`openspec validate todo-export-import-escape --strict --no-interactive` exit 0。

## Negative controls
- N1 规则里去掉小写化 → `/todo EXPORT ~/x` 用例失败。
- N2 规则只认空白分隔、不认 `:` → `/todo:export /abs/x.md` 用例失败。
- N3 规则改成「参数里出现 import/export 即判 text」→ `/todo done import`、`/todo exported` 用例失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | prompt 路由的 wire 形态变化 → 1.3、E3 |
| File IO / path safety / overwrite | yes | 关闭无步骤的文件读写通道 → E3 |
| Legacy compatibility / examples | yes | 其它 `/todo` 子命令与历史对位不变 → Must preserve、1.4 |
| Schema / columns / units / field names | no | 无 |
| 其它 | no | 无 |
