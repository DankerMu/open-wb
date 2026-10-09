# 实施注记（s1f-files-page）

各切片的 fixture 评审补充与实施更正，一节一个切片；`tasks.md` 在对应任务下留一行指针。

## 0.1（#1049）

- 不触及 Critical Path：本刀只改规格文本；产物是上面的 D25 一格、0.1 下的核对记录、PR 描述，以及贴进 Epic #1048「对底记录」的逐条结果。
- 编排者步骤（我未运行）：`$HOME/.nvm/versions/node/v24.13.1/bin/openspec validate s1f-files-page --strict --no-interactive` 与 `$HOME/.local/bin/openspec validate s1f-files-page --strict --no-interactive`，两个都要 0 个 ERROR，结果填进核对记录。
- 表头：26 条 MODIFIED 与 1 条 REMOVED 全部逐字命中主规格；35 条 ADDED 在主规格里都不存在；没有 RENAMED。
- 重叠数：D 的 MODIFIED / REMOVED 里恰有 13 条同名出现在 C 或 S1g 的归档 delta 中，与 D25「十三条」一致；主规格里自 D 起草（`792955f`）以来变过的也恰是这 13 条。
- 与 S1g 同名的恰是 #1047 交接的五条；其中 sandbox-core 一条只有 S1g 改过，其余四条 C 与 S1g 都改过。
- 逐条结果，http-service-skeleton 三条：「统一错误信封」「Shared agent module assembly」只含表列增量；「服务启动与装配」另有上面那一句漏列。
- 逐条结果，其余九条 MODIFIED（sandbox-core、chat-web「会话页」、session-sidebar「会话条目菜单与重命名」、spa-shell、ui-foundation「组件分层」、chat-harness 两条、turn-artifacts 两条）：只含表列增量。
- 逐条结果，「产物面板」：REMOVED 表头命中，主规格现有三个场景（含 C 的「临时空间会话的面板行」），delta 带 Reason / Migration。
- 没有发现任何会覆盖前序文本的旧文本：S1g 的四个配置键与缺省值、`upload_too_large`、uploads 归属身份、`op=write` 各句与「写操作的逃逸向量」、空白发送一句都在 D 的 delta 里逐字存活。
- S1g 归档前修订的四处（上传路由细节、迁移 040 回滚场景、全部自动确认框的遮罩、粘贴时文字优先）都在 S1g 的 ADDED 条文里，D 没有同名条文，不涉及。
- 计数与代码一致：`server/src/http/errors.ts:51-67` 十五条归属身份；`server/src/core/errors/index.ts:6-21` 十六码；`server/src/core/sandbox/resolve.ts:14` 与 `index.ts:29` 的 `op` 是四成员；迁移到 `042_chat_message_attachments.sql`。
- 表外核对成立，代码佐证：`web/src/features/chat/session-sidebar.tsx:2` 从 `@/components/ui/button` 导入 `Button`；`web/test/ui-layering.test.ts:58` 与 `:385` 登记了该文件。
- 引用检查：D 全部文档里 186 处「capability「条文或场景名」」引用，在主规格与 D 的并集里都解析得到，没有悬空引用。
- 行数漂移（进 PR 描述）：`api.ts` 是 778 行而非 729，离 800 只剩 22 行，「不再加方法」变成硬约束；`ui-walk-sessions.spec.ts` 是 681 而非 776；`md-render.ts` 797、`ui-walk-layout.ts` 793、`rest.ts` 416 无漂移。
- issue 正文不必同步：没有任何计数或措辞变化（#1054、#1062、#1067、#1053、#1105、#1109、#1110、#1115 维持原文）。
- 只读脚本留在 scratchpad 的 `tools/` 下：`rediff_d.py`（表头、场景超集、句子级 diff）、`order_d.py`（次序与底本是否变过）、`overlap_d.py`（重叠数）、`xref_d.py`（引用检查）；0.2（#1124）可直接复用。
