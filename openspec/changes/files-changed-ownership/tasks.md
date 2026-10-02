# Tasks: files-changed-ownership（#522）

## 3. server — files.changed 归属判定、落库后发布（父 tasks 3.4）

- [ ] 3.4 新建 `file-changes-ownership.ts`（`ownedChanges`：绝对原样/相对拼空间根 → realpath（确实不存在则父目录 realpath + 文件名，其余失败丢弃）→ 严格位于空间根 realpath + 分隔符之内 → 相对空间根 `/` 分隔路径，UTF-8 >1024 字节丢弃 → 同路径合并（计数求和、位置取首次）→ 超 50 项只留前 50）+ 新建 `store-changes.ts` 的 `setStepChanges` 并挂到 `SessionStore` + `turn-control.ts` `persistEvent` 的 `files.changed` 分支（未绑定或未登记的调用 → 丢弃；无幸存项 → `undefined`；有则 `setStepChanges` 成功后返回以数字步骤 id 发布的事件）+ `Slot.workspaceRoot` 与 `supervisor.ts` 两行接线。验证：新建 `server/test/file-changes-ownership.test.ts`（O1–O13）、`server/test/session-file-changes.test.ts`（F1–F5）、`server/test/persist-files-changed.test.ts`（P1–P6）；既有测试只改 proposal「偏差」3 的一处

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| File IO / path safety / overwrite | yes | realpath 前缀归属是 Critical Path「沙箱与文件边界」；只读元数据，不创建不写入文件 → O1–O13 全部、F3、白盒审查 |
| Auth / permissions / secrets | yes | 宿主机绝对路径（含他人空间、所有者根、系统路径）不得出现在 SSE 与 `chat_steps.changes`；未绑定会话不产生任何变更 → O7、F1（无绝对路径断言）、F3、F4、P2 |
| Concurrency / shared state / ordering | yes | 「先落库、后发布、`step.end` 在后」与重连回放 → F1、F2、P4 |
| Error handling / rollback / partial outputs | yes | 落库失败不发布、不占序号、走 owned error-sink；根不可解析、候选不可解析 → F5、P5、P6、O10、O11 |
| Public API / CLI / script entry | yes | `files.changed` 从此是真实发布的 SSE 事件；`persistEvent` 与 `SessionStore` 签名变化 → F1、P1–P6、既有 `session-persist-new-events.test.ts` |
| Schema / columns / units / field names | yes | `chat_steps.changes` 的 JSON 形状被 web 严格解析（键集、1..50 项、edit 非负整数、write 为 null）→ O1、O4、O5、F1 |
| Resource limits / large input / discovery | yes | 每个候选 1–3 次同步文件系统调用，候选数不设上限 → O5（上限在合并后）、design「已知残留」1 |
| Legacy compatibility / examples | yes | `finishStep` 与 `step.end` payload 不变；未绑定会话与既有场景不受影响 → 既有 server 测试全绿、F4 |
| Config / project setup | no | 无 |
| Release / packaging / dependency compatibility | no | 只用 `node:fs`、`node:path` |
| Documentation / migration notes | no | spec delta 即文档；`system.md`/`IMPLEMENTATION_PLAN.md` 的同步在收尾刀 9.1 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进三个新文件；既有测试只改 proposal「偏差」3 的一处（`session-persist-new-events.test.ts:55` 与文件头注释）。
- [ ] RED 集合 = O、F、P 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [ ] `supervisor.ts` 799 → 800、`store.ts` 789 → ≤800、`pool.ts`、`turn-control.ts` 的前后行数写进 PR。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 克隆数 178 不增）、`bash scripts/size-guard.sh` 退出 0；`make smoke`、`make ui-walk` 与 `uid-isolation` 由 CI 覆盖；`openspec validate files-changed-ownership --strict --no-interactive` 通过。
- [ ] PR 标注触碰 Critical Path「沙箱与文件边界」，请求白盒审查。
