# Tasks: chat-markdown-messages（#286）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-markdown-messages --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/chat-messages.test.tsx`（M1–M5）。先红。
- [x] 2.2 `git mv` md-render；`lib/markdown-view.tsx`；`preview.tsx`、`conversation-view.tsx`、`chat.css`；两处测试 import。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入八项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR 同步父 delta `s1e-frontend-parity/specs/chat-web/spec.md` Messages 段：补"头像为装饰性（`aria-hidden`）""源 HTML 转义且不注入"两处扩展；"preserve complete text (whitespace per Markdown semantics; `复制` copies the raw text)"改为"visible text following Markdown semantics (markup consumed, link destinations dropped); `复制` copies the raw text"。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`article` 可访问名、用户首个 `p`、助手首段 `p` 是 jsdom 与 ui-walk 定位面。证据：M2、M4、既有测试全绿、3.3。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：只移动源码文件，无运行期 IO。
- Not selected Schema / columns / units / field names：无数据契约变化。
- Selected Auth / permissions / secrets（注入面）：模型输出进入 DOM 不得产生可执行元素或可跳转链接。证据：M1、M5。
- Not selected Concurrency / shared state / ordering：流式归约不改；光标只读 `message.status`。
- Not selected Resource limits / large input / discovery：深层结构迭代渲染不变，既有 preview 深度用例覆盖。
- Selected Legacy compatibility / examples：files 预览 DOM 与行为、单行助手原文断言、步骤卡与错误结构不变。证据：preview/md-render 全绿、既有 chat 测试全绿。
- Not selected Error handling / rollback / partial outputs：错误呈现不改。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无迁移。
