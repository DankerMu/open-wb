## Why

开了 RAPTOR 或知识图谱的知识库，任何文档都入不了库，界面只显示「知识库服务拒绝了这个文件」（#1900，S2a 验收 CK-11 首次对共用栈实跑 `make smoke-kb` 时发现）。

根因：RAGFlow v1.0.0-rc2 建入库任务时把文档所绑画布的 `title` 拷进 `pipeline_operation_log.pipeline_title`，该列 `varchar(32)`，MySQL 开着 `STRICT_TRANS_TABLES`。本系统的画布与数据集、模板组同名（D2），名字是 `owb-<id>-g<代数>`，`<id>` 为 32 位十六进制，长度恒 ≥ 39。插入失败 → 任务回滚 → 解析触发回 `code:0`、`success_count:0`，RAGFlow 日志里没有记录；服务端按规格把它映射为 `rejected`（`server/src/kb/documents.ts:106-107`）。rc2 实测用的是 `owb-cv-*` 这类短名，单测的假 RAGFlow 不限制标题长度，所以一直没暴露。

## What Changes

- 资源名改为 `owb-<id 前 16 位>-g<代数>`：长度 4 + 16 + 2 + 代数位数，代数不超过 10 位时不超过 32。数据集、模板组与画布仍同名（D2 不变），由 `server/src/kb/pipeline.ts` 导出的一个函数生成，`server/src/kb/bases.ts:215` 与 `server/src/kb/rebuild.ts:136` 改为调用它。模板项名 `<名字>-t` / `<名字>-g`（`pipeline.ts` 的 `groupTemplates`）随之变短，不单独改。
- 假 RAGFlow 照真实行为：建画布仍接受长标题（真实列宽 255）；对绑定画布标题超过 32 个字符的文档触发解析时回 `code:0`、`success_count:0`，不建任务、文档状态不变。由此得到修复前为红的回归用例。
- 规格：knowledge-bases「知识库端点」写明命名规则与 32 字符上限及其原因，新增场景「开编译的库能入库」；ragflow-backend「嵌入模型更换与全量重建」的名字随之改写。
- 文档：`docs/architecture/knowledge-base.md` 的命名行；`docs/reviews/2026-10-28-ragflow-rc2-api.md` §8.1 表补一行「建任务失败（如 `pipeline_title` 超长）→ `success_count:0`，`code:0`，无日志」。
- 兼容：修复前建的开编译库保留 39 字符的画布，仍入不了库，直到下一次换嵌入模型重建、以新名字建新一代。S2a 尚未发布，只有开发栈上有这类库，不做迁移。

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 外部共享状态（RAGFlow 资源名）的格式；改错会让建库或重建发出与规格不符的名字，或开编译的库继续入库失败
Selected risk packs: Schema / columns / units / field names; Legacy compatibility / examples; Documentation / migration notes
Evidence floor: 假 RAGFlow 加限长后回归用例修复前红、修复后绿；kb 相关 test:focus 通过；make check；合入后对共用栈 make smoke-kb 退出 0（验收行 CK-11，签收归 owner）
```
