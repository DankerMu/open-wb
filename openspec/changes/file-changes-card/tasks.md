# Tasks: file-changes-card（#535）

## 7. web — files.changed 解码归约与文件变更卡（父 tasks 7.5a）

- [ ] 7.5a 新建 `stream-artifacts.ts`（`files.changed` 严格解码与归约：按 `stepId` 设置步骤 `changes`，后到覆盖；按消息汇总的纯函数）+ `stream-steps.ts`（`startStep`/`endStep` 与步骤视图类型自 `stream.ts` 挪出，步骤视图加 `changes`）+ `file-changes-card.tsx`（一条助手消息只汇总**已结束**步骤的 `changes`，按路径去重取靠后步骤的值、位置取首次；卡头 `文件变更（N 个）`；行 `+a`/`-d`（>0 才显）或 `写入` + 逻辑路径 `<account>/<dir>/<path>` + `查看详情 <逻辑路径>` 按钮 → `/files?ws=<workspaceId>`；空间不可解析时只显相对路径、无 `查看详情`）+ `conversation-view.tsx` 助手块插入文件变更卡位（错误之后、`已停止` 徽章之前）+ `stream.ts` 接线 + `session-contract.ts` 导出 `parseFileChanges` + `page.tsx` 传 `workspace` + `messages.css` 样式。验证：新建 `web/test/chat-page-file-changes.test.tsx`（C1–C15）；既有测试只改 proposal「偏差」1 列出的步骤视图字面量

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新消费一类 SSE 事件，须走既有游标/队列/恢复路径 → C1、C2 |
| Schema / columns / units / field names | yes | payload 严格键集与元素规则；步骤视图新增必有键 `changes` → C2、C5、既有套件的整对象断言 |
| Concurrency / shared state / ordering | yes | `files.changed` 先于 `step.end` 到达、running 步骤不出卡、同一路径多步骤的先后 → C3、C7、C8、C10 |
| Error handling / rollback / partial outputs | yes | 非法 payload → 重同步；空间列表读取中/失败/未绑定 → 降级为相对路径 → C2、C11 |
| Legacy compatibility / examples | yes | 步骤卡呈现不变、`startStep`/`endStep` 挪文件后行为不变（含引用同一性）、助手块次序、`复制` → C4 的挪文件护栏、C13、C14、既有 `chat-stream*`/`chat-steps` 套件 |
| File IO / path safety / overwrite | yes | 只显示逻辑路径，绝对 `root` 不进任何文本与属性 → C9、C11 |
| Auth / permissions / secrets | no | 只读本账号既有数据 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 每步骤至多 50 项（解码拒绝超限，C2）；一条消息的行数由服务端步骤数约束 |
| Release / packaging / dependency compatibility | no | 不加依赖；`chevron-right` 已注册 |
| Documentation / migration notes | no | spec delta 即文档；ui-walk 步骤归 8.2a |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进新文件 `web/test/chat-page-file-changes.test.tsx`（超过 800 行则拆 `web/test/chat-page-file-changes-support.tsx`）；既有测试只按 proposal「偏差」1 给步骤视图字面量加 `changes`，不改断言语义。
- [ ] RED 集合 = C1–C15 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [ ] `stream.ts` 787 → ≤800（预计约 750）；`page.tsx` 688 → 689；`chat.css` 不动。PR 记录这些数。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 178 不增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate file-changes-card --strict --no-interactive` 通过。
