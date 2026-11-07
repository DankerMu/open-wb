## Design

Change surface: `server/src/kb/pipeline.ts`（新增导出的资源名函数）、`server/src/kb/bases.ts:215`、`server/src/kb/rebuild.ts:136`；测试侧 `server/test/support/fake-ragflow.mjs`（解析触发）与引用名字的 kb 测试与 helpers。

Must preserve: 三种资源同名（D2）；前缀 `owb-`（共用栈的清理纪律按前缀识别，ragflow-backend「共用开发栈的使用纪律」）；`-g<代数>` 后缀与代数语义；本系统只按应答里的 id 引用资源，名字不参与查找；`parse_not_started → rejected` 的映射与界面文案；普通库（`parse_type:1`）的数据集名同样用新规则，不另起一套。

Must add/change: 名字 `owb-<id 前 16 位>-g<代数>`；假 RAGFlow 对画布标题超过 32 字符的文档触发解析时回 `success_count:0`。

Governing invariant: 本系统发给 RAGFlow 的画布标题（也就是三种资源的共同名字）长度不超过 32。

Sibling surfaces:
- 建库（`bases.ts`）与重建（`rebuild.ts`）是仅有的两个生成点，都改为调用同一函数。
- 模板项名 `${name}-t` / `${name}-g`：列宽 128，随基名变短，不受限。
- 数据集名列宽 128、画布 `title` 255、模板组名 128：不受限，只有 `pipeline_operation_log.pipeline_title` 是 32。
- 审计与 stderr 记录（`kb_dataset_leak` 等）只记 id，不记名字：不受影响。

Seams under test: HTTP 端点（`POST /api/kb/bases`、入库 `POST /api/kb/bases/:id/documents`）对假 RAGFlow；资源名函数的长度上界作为一条单元断言。

Required evidence:
- 开 `raptor` 与开 `graph` 的库各入库一份工作空间文件 → 201，`documents` 1、`rejected` 空；假 RAGFlow 收到的三种名字都是 `owb-<id 前 16 位>-g0`。修复前同一用例得 `rejected`。
- 名字函数：32 位 id、代数 `9999999999` → 长度 32。
- 既有建库、重建场景的名字断言改为新规则后照常通过。

Non-goals: 迁移修复前建的开编译库；改 RAGFlow；改解析失败的映射或文案；给代数加运行时上限检查（代数随每次换嵌入模型加 1，10 位不可达）。

Alternative rejected: 只缩短画布标题、数据集与模板组保留全长 id。这会让三种资源不再同名，违反 D2，运维在 RAGFlow 里按名字对应同一库的三件资源也会变难；规格与文档要写两套规则。

Review focus:
1. 两个生成点都走同一函数，没有残留的 `owb-${id}` 拼接。
2. 假 RAGFlow 的限长只作用在解析触发、只看绑定画布的标题，且不影响普通库；没有放宽或改变 §8.1 已有的状态表。
3. 规格 delta 与实现一致，测试期望通过函数或新规则计算，没有把旧名字残留在断言里。
