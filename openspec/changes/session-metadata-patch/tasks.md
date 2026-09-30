# Tasks: session-metadata-patch（#524）

## 4. session-metadata — PATCH 与补偿标题规则（父 tasks 4.2 原文）

- [ ] 4.2 扩展 `rest-metadata.ts` 加 `PATCH /api/sessions/:id` + 扩展 `store-metadata.ts` 加 `patchSession` + `store.ts` `rollbackPrompt` 标题规则：preParsing owner 预检（401/404 先于 body）；body 为 `{title?, scene?, pinned?}` 非空子集（`{}`、多余键含 `workspaceId`、类型不符、`scene:null` → 400，任一不合法整体 400 不写列）；`title` trim 后 1..80 码点；`pinned:true` → `COALESCE(pinned_at, now)`，`false` → NULL；单条所有者作用域 UPDATE 只写所给列、不改 `updated_at`/status/`workspace_id`，影响 0 行 → 404；running 与占用期间均允许；不审计；200 八键。PATCH 写 title 时把活跃 Turn 的 `titleTouched` 置 true，`rollbackPrompt` 仅当受理写了前缀（`previousTitle === null`）且未被标记时恢复为 NULL，否则保留当前标题。验证：`session-metadata-rest.test.ts` 追加 PATCH 用例；新建 `server/test/session-title-rollback.test.ts`（见 design「Required evidence」）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | PATCH body 合同与 200 八键 → 证据 1、3、4 |
| Auth / permissions / secrets | yes | owner 预检先于解析、404 不可区分 → 证据 6 |
| Error handling / rollback / partial outputs | yes | 整体 400 零写入、补偿不撤销重命名 → 证据 3、4、5、8 |
| Concurrency / shared state / ordering | yes | 在途受理与 PATCH 共享 `titleTouched`、运行中修改 → 证据 2、8 |
| Resource limits / large input / discovery | yes | 16 KiB `bodyLimit` → 证据 5 |
| Legacy compatibility / examples | yes | 未 PATCH 时补偿行为不变、既有测试冻结 → 证据 8b、8c、9 |
| File IO / path safety / overwrite | no | 不涉文件；`cwd` 由 2.2 决定，证据 7 仅回读 |
| Schema / columns / units / field names | no | 列由 1.1、投影由 5.1 提供 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进 `server/test/session-metadata-rest.test.ts`（4.1 新建，末尾追加）与新建的 `server/test/session-title-rollback.test.ts`（均 ≤800 行）；其余既有测试文件零改动。
- [ ] RED 集合以 design「Required evidence」的划分为准：先在实现前跑红，再实现跑绿（记录命令与结果）；其余按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-metadata-patch --strict --no-interactive` 通过。
