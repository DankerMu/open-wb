# Design: session-store-split（#454）

父设计：「模块拆分（size-guard）」。

- **Change surface**：`server/src/sessions/store.ts`（798 行）→ 新 `store-branch.ts`、`store-approvals.ts`。
- **Must preserve**：`createSessionStore(db, options)` 与 `SessionStore`/`SessionStoreOptions`/`SessionMessageTree` 等现有导出及其 `store.js` 导入路径；全部 SQL 文本、事务边界（`runOwnedTransaction` 的 BEGIN/COMMIT/ROLLBACK 与 `rollbackOwnedTransaction` 错误包装）、`requireChanges`/`requireAtMostOne` 的错误消息、flush 计时（`FLUSH_BYTES`/`FLUSH_MS`、`armFlushTimer`/`flushPending`/`cancelTimer` 次序）、终态结算与启动对账语义。
- **既有导入方（全部不改）**：`server/src/app.ts`（仅类型）、`server/src/sessions/{rest,supervisor,index}.ts`；测试 `server/test/core-db-chat-step-output.test.ts`、`session-supervisor-helpers.ts`、`sqlite-text.test.ts`、`session-store-helpers.ts`、`session-rest-helpers.ts` 及使用它们的 store/supervisor/rest 测试。
- **Must add/change**（搬迁清单，函数/类型体逐字搬移，唯一改动是 `export` 关键字与 import 行；行号为 origin/master）：
  - `store-branch.ts`（消息/步骤行与事务原语）← `MessageDbRow`（102-109）、`StepDbRow`（111-121）、`MESSAGE_COLUMNS`/`STEP_COLUMNS`（153-156）、`INSERT_MESSAGE`（159-160）、`decodeNullableText`（522-524）、`toMessageView`（536-544）、`toStepView`（546-557）、`countRows`/`hasChanges`/`requireAtMostOne`/`requireChanges`/`runOwnedTransaction`/`rollbackOwnedTransaction`（749-798）。
  - `store-approvals.ts`（回合终态结算）← `cancelTimer`（584-590）、`finishOwnedTurn`（653-719）、`releaseTurn`（721-735）、`reconcileStatuses`（737-747）。
  - 留在 `store.ts`：公开/内部类型（7-101、123-148）、`FLUSH_BYTES`/`FLUSH_MS`、`SESSION_COLUMNS`/`INSERT_SESSION`、`createSessionStore`、`assertOpen`、`toSessionView`、`titlePrefix`、`currentTurn`、`armFlushTimer`、`flushPending`。
  - 依赖方向（有向无环）：值导入只允许 `store.ts → store-approvals.ts`、`store.ts → store-branch.ts`、`store-approvals.ts → store-branch.ts`；反方向只允许 `import type`。新文件需要的类型以 `import type … from "./store.js"` 取得（编译期擦除，无运行时环）。为此 `store.ts` 中 7 个类型声明加 type-only `export`：`MessageRole`/`MessageStatus`/`StepStatus`/`FinishStatus`（7-11）、`StepView`/`MessageView`（21-39）、`Turn`（131-147）。这是除搬迁块与 import 行外唯一允许的改动；`sessions/index.ts` 只再导出 `createSessionStore`/`SessionStore`，故不形成新的对外公共面。`rollbackOwnedTransaction` 仅在 `store-branch.ts` 内部使用，不加 `export`。若实施中发现某符号依赖迫使清单微调（例如 `cancelTimer` 被 `flushPending` 以值引用而须经 `store-approvals.ts` 导出），允许在保持上述依赖方向与逐字搬移的前提下调整，并在报告中逐项列出。
  - 行数（一次性证据）：搬出约 210 行、新增 import 约 20 行 → `store.ts` ≈ 610；上限 ≤ 640，为 3.1/4.x 在 `store.ts` 的接线增量留出 ≥160 行。
- **Governing invariant**：拆分前后，对同一调用序列，`createSessionStore` 返回对象的全部读写、事务、计时与错误行为完全一致。
- **Sibling surfaces**：`server/src/core/db`（openDb/迁移，不动）；`sqlite-text` 解码（`decodeNullableText` 的调用方 `toSessionView` 留在 store.ts，改为从 `store-branch.ts` 导入）。
- **Seams under test**：既有测试原样；无新增测试。
- **Required evidence**：`git diff --stat -- server/test` 为空；`npm test --workspace server` 全绿且测试总数与 origin/master 相同；`wc -l server/src/sessions/store.ts` ≤ 640；knip 零新增、jscpd 不升高；`git diff --color-moved` 只见搬迁块、import 行与上述 7 处类型声明的 `export` 关键字；orchestrator 以 master 行段对新文件（去 `export`/import）逐字比对。
- **Non-goals**：任何新行为、新测试、`supervisor.ts` 拆分。
- **Review focus**：逐字搬迁；无值导入环；事务/计时次序未变；导出面未变。
