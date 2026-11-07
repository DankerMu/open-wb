## 1. 回归用例与假 RAGFlow

- [ ] 1.1 `server/test/support/fake-ragflow.mjs` 的解析触发：数据集绑定了画布（`parse_type:2`）且该画布存在、`title` 超过 32 个字符时，**本应计 1 的文档改计 0**（不改状态、不建任务），回 `code:0`。只看绑定画布的标题，不看数据集名；§8.1 表以外的状态照旧回 `undefined`，其余行为不变。在 fake 自身的测试（`fake-ragflow*.test.ts`，绑定的数据集经 fake 的 `POST /datasets` 建，同 `fake-ragflow-pipeline.test.ts:232`）里覆盖：
  - 短名 `parse_type:2` 数据集绑定长标题画布 → `success_count:0`；
  - 画布标题恰 32 字符 → 1，33 字符 → 0；
  - 名字超过 32 字符的 `parse_type:1` 数据集 → 1（普通库不受影响）。
- [ ] 1.2 先写端点级回归用例（放在 `server/test/kb-bases-compile.test.ts` 或入库的对应测试里）：知识库对话模型已指定，建 `raptor:true` 与 `graph:true` 的 `naive` 库各一个，各从工作空间入库一份文件，断言 201、`documents` 1、`rejected` 空，假 RAGFlow 收到的数据集名、模板组名与画布标题都等于字面计算的 `` `owb-${view.id.slice(0, 16)}-g0` ``（不经 `resourceName`）。修复前跑出红并记录。

## 2. 资源名

- [ ] 2.1 `server/src/kb/pipeline.ts` 导出 `resourceName(id: string, generation: number): string`，返回 `owb-${id.slice(0, 16)}-g${String(generation)}`，注释说明 32 字符上限的来源（RAGFlow `pipeline_operation_log.pipeline_title varchar(32)`）。单元断言两条：`resourceName("0123456789abcdef0123456789abcdef", 0) === "owb-0123456789abcdef-g0"`（钉住取前 16 位）；32 位 id、代数 `9999999999` 时长度为 32。
- [ ] 2.2 `server/src/kb/bases.ts:215` 与 `server/src/kb/rebuild.ts:136` 改为调用它（`bases.ts:215` 已有同名局部变量 `resourceName`，局部变量改名）；同步注释 `server/src/kb/bases.ts:66`、`server/src/kb/rebuild.ts:8`、`server/src/kb/pipeline.ts:70`。检查：`grep -rn 'owb-\${' server/src` 只剩函数本身，`grep -rn 'owb-<id>' server/src docs` 无结果（`docs/reviews/` 的历史实测记录除外；`openspec/specs` 在 archive 时由 delta 同步，本 PR 不改）。
- [ ] 2.3 测试里引用旧名字的断言与 helpers（`server/test/kb-*`、`fake-ragflow*`）改为调用 `resourceName` 或按新规则计算，不在多处重复编码规则；用例标题里的旧名字一并改（如 `kb-bases-compile.test.ts:127`）。

## 3. 文档

- [ ] 3.1 `docs/architecture/knowledge-base.md:128` 的命名行改为新规则并说明 32 字符上限；同文件 `:135`、`:144`、`:388` 的 `owb-<id>-g<代数>` 一并改。
- [ ] 3.2 `docs/reviews/2026-10-28-ragflow-rc2-api.md` §8.1 的 `success_count` 表补一行：建任务失败（如画布标题超过 `pipeline_operation_log.pipeline_title` 的 32 字符）→ `0`，`code:0`，RAGFlow 日志无记录（2026-11-07 S2a 验收 CK-11 实测）。
- [ ] 3.3 `docs/adr/0016-ragflow-service-backend.md` 与其它 docs 中若有具体名字示例，按新规则核对；只按前缀 `owb-` 表述的不改。

## 风险包

- Schema / columns / units / field names：选中。外部列 `pipeline_title varchar(32)` 是约束来源 → 任务 1.1、1.2、2.1。
- Legacy compatibility / examples：选中。修复前建的开编译库不迁移，见 proposal「兼容」；既有名字断言更新 → 任务 2.3。
- Documentation / migration notes：选中 → 任务 3.x。
- 其余（Public API、Config、File IO、Auth、Concurrency、Resource limits、Error handling、Release）：未选，本 change 不碰对应面。

验证：
- `npm run test:focus --workspace server -- kb- fake-ragflow`，退出码 0。
- `make check`，退出码 0。
- 合入后（编排方）：重建服务，对共用栈 `SMOKE_BASE_URL=<服务地址> make smoke-kb` 退出 0。
