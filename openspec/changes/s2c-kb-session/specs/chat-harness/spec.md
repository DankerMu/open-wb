## ADDED Requirements

### Requirement: UI 走查会话知识库引用与检索卡
`make ui-walk` SHALL 含一个会话知识库分支（`web/e2e/ui-walk-chat-kb.ts`），在 Chromium 里走查知识库引用与检索卡。CI 的 ui-walk 不配 RAGFlow，所以本分支与 `ui-walk-center-kb.ts` 同一写法：知识库相关的接口由 `page.route` 应答，应答体严格按 web 解析器的键集。会话的其余接口走真实服务。

1. **入口与标签**：
   - route 应答 `GET /api/kb/status`（开启）与 `GET /api/kb/bases`（两个库，其中一个 `rebuilding`）。
   - 在一个已选会话里打开「+」菜单、选 `引用知识库…`、选一个库，断言 `引用的知识库` 列表出现该库。
2. **发送**：
   - route 截获该会话的 prompt 请求，断言 body 的 `knowledgeBases` 为所选库的 id，并以 202 应答。
   - 断言受理后引用列表消失。
3. **刷新形态**：
   - route 应答该会话的消息快照：一条带引用的用户消息，以及一条含两个 `kb_search` 步骤（detail 带 `question`）的 `done` 助手消息。
   - 断言用户气泡的 `引用的知识库` 列表，以及一张 `知识库检索` 卡（`（2 轮）`、两行、行不可展开）。

分支 SHALL 在既有的视口矩阵下截图，并通过 browser-error oracle；结束时撤掉它的全部 route，不留会话（「冒烟与走查不留会话与临时空间」）。

#### Scenario: 走查分支全绿
- **WHEN** `make ui-walk` 对已运行的服务跑到本分支
- **THEN** 上述三步的断言全部通过，视口矩阵截图齐全，error oracle 没有新增报错，退出码 0
