# Tasks: file-change-candidates（#515）

## 3. turn-artifacts — 候选提取（父 tasks 3.2 原文）

- [ ] 3.2 新建 `server/src/sessions/file-changes.ts`（纯函数）+ `events.ts` 接线：对已知 running 调用、帧与 `result` 均非 `isError`、`details` 为普通对象的 `tool_execution_end` 提取候选——`edit`：`perFileResults[{path, diff}]` 逐项，否则 `details.path`+`details.diff` 一项，`kind:"edit"`，`added/removed` = 按 `\n` 切分后匹配 `^\+\d+\|`/`^-\d+\|` 的行数；`write`：`details.resolvedPath` → `{kind:"write", added:null, removed:null}`；其它工具（含 `ast_edit`、bash）永不；有候选时在该调用 `step.end` 之前、同一返回结果中紧邻输出 `files.changed{stepId:<toolCallId>, path:<原始路径>}`；`normalizeOutput` 仍丢弃 details。验证：新建 `server/test/file-changes.test.ts`（diff 计数边角：上下文行 ` N|`、无编号 `+`、CRLF、空 diff；perFileResults 优先；isError 不产出；原型键不读；带 `details.path`+`diff` 的 `ast_edit` 结束帧无候选）与 `session-events-files.test.ts`（次序紧邻 `step.end`、bash 与 `ast_edit` 无事件）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | 候选形状与计数规则 → 证据 1、2、3 |
| Auth / permissions / secrets | yes | 原型键不读；原始路径不上 SSE（supervisor 丢弃不变）→ 证据 2、4、6 |
| Concurrency / shared state / ordering | yes | 紧邻且先于 `step.end`、未知/重复结束无事件、不别名 → 证据 3、4、5 |
| Legacy compatibility / examples | yes | `step.end`/`normalizeOutput` 不变、既有测试零改动 → 证据 3、6 |
| Public API / CLI / script entry | no | 本刀事件不发布（3.4 前被丢弃） |
| Error handling / rollback / partial outputs | no | 纯函数，无失败路径 |
| File IO / path safety / overwrite | no | 无 IO（归属判定属 3.4） |
| Resource limits / large input / discovery | no | 上限属 3.4；diff 计数线性 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；既有测试文件零改动。
- [ ] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate file-change-candidates --strict --no-interactive` 通过。
