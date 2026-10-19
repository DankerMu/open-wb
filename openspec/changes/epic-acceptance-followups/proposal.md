# Proposal: epic-acceptance-followups

## Why

2026-10-18 owner 对编译版服务走完七个 Epic 的功能验收（PR #1519 回写 `docs/acceptance/functional-checklist.md`），三行不通过且都不是实现偏离规格，而是规格本身不合 owner 的期望：

- CH-04：助手正文里的源 HTML 按规格「作为文本出现、不生成元素」，owner 判为渲染失败——要渲染。
- CH-39：模型输出被截断——托管 `models.yml` 把每个模型的 `maxTokens` 固定为 8192（model-proxy「托管 models.yml」），owner 预期 32k。
- CH-40：任务清单面板的状态是文字（「待办」「进行中」…），owner 要图标；全部完成即隐藏，owner 要保留到下一条用户消息。

owner 裁决（2026-10-18 grill，逐分支见 design「owner 的裁定」）：三项各改规格并实现，**一个 change、三个 task 组、一次流水线**。

## What Changes

- **助手正文渲染源 HTML**（chat-web）：正文里的 HTML 解析成元素、经白名单消毒后渲染：排版类元素、`a`、`img` 与 `style` 属性保留；`script`/`iframe`/表单类元素、`on*` 事件属性、非白名单属性、取值含 `url(`/`expression(` 的 `style` 一律剥除且不以文本出现。链接（Markdown 与 HTML）目标为 `http:`/`https:`/`mailto:` 时成为可点的 `a`（新标签页、`noopener noreferrer`），其它目标只留文字；图片 `src` 为 `http:`/`https:` 时加载（`loading="lazy"`、`referrerpolicy="no-referrer"`），其它只留 alt / URL 文本。**取代**现行「源 HTML 作为文本、链接惰性、图片不加载」三条。
- **模型输出上限可配**（model-selection + model-proxy）：白名单模型新增 `maxTokens`（`MODEL_CATALOG` 条目可选键，1–128000 的整数，缺省 32768；未设 `MODEL_CATALOG` 时也是 32768）；托管 `models.yml` 的 `maxTokens` 行按模型写出。`contextWindow` 仍固定 128000；`maxTokens` 不进 `GET /api/composer/options`。
- **任务清单面板**（session-todo）：状态改为可见图标（待办空心圆、进行中半圆弧、已完成勾、已放弃叉、受阻禁止符）+ 只对读屏可见的状态文字；全部完成 / 放弃的清单若是在面板可见期间就地变成的，继续显示（`任务清单 3/3`）直到用户提交下一条消息、或到达 `null` / 新清单；刷新、切会话再切回、从快照首次装入的已完结清单不显示。
- **验收清单**：CH-04、CH-39、CH-40 三行按新规格重写「操作 / 期望」并把结论回到 `待签`（CH-39 的结论随组 2、期望文字随组 3）；CH-42（已签通过，期望「全部完成后面板消失」）随新保留规则改写期望、回到 `待签`。
- **依赖**：web 新增 `rehype-raw` 与 `rehype-sanitize`（源 HTML 解析与 hast 白名单消毒，现有 `react-markdown` 管线没有这两步；按 AGENTS.md 依赖政策在 PR 说明，`ATTRIBUTION.md` 登记）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `chat-web`：MODIFIED「消息线程」——「正文」段的三条规则改写（源 HTML 渲染与消毒、链接、图片），场景「消息呈现与流式光标」一句改写，场景「Markdown 链接惰性与图片不加载」收窄到不安全 / 无法解析的目标（名字保留——strict 校验不接受 MODIFIED 块丢场景），新增场景「链接、图片与源 HTML 的渲染与消毒」与「流式期间的半截 HTML 不留痕」；首段「行为定制在应用层实现」一句的举例换成源 HTML 消毒与链接 / 图片规则，并点名 `rehypePlugins` 透传属 ui-foundation 第六类修改。其余段落原样。
- `model-selection`：MODIFIED「模型白名单配置」——模型形状加 `maxTokens`，两种配置形态的缺省与校验，三个场景补 `maxTokens` 取值与六个非法值。
- `model-proxy`：MODIFIED「托管 models.yml」——`maxTokens` 行取自模型的 `maxTokens`；「未设白名单时输出字节不变」改为「只差 `maxTokens` 一行」；三个场景随之改写（「Single-model output is unchanged」保留名字，改为与替换了 `maxTokens` 行的改前夹具比对）。
- `thinking-fold`：MODIFIED「reasoning 前提与真运行时取证」——场景「关闭 reasoning」的「文件与本 change 之前的托管输出逐字节相同」改为与 model-proxy「托管 models.yml」规定的单模型输出逐字节相同（改前夹具替换 `maxTokens` 行之后），其余原样。
- `http-service-skeleton`：MODIFIED「服务启动与装配」——「单模型时写出的字节不变」改为「单模型时写出的内容见 model-proxy「托管 models.yml」（与改前只差 `maxTokens` 一行）」，其余原样。
- `ui-foundation`：MODIFIED「组件分层」——只改一处举例：「链接惰性、图片显示为 alt 文本」→「源 HTML 的消毒与链接 / 图片的目标规则」，应用层的手段举例加「`rehypePlugins` 透传」（它属第六类修改的点名在 chat-web 首段）。
- `omp-test-harness`：MODIFIED「受控上游请求记录」——每条记录加 `maxTokens`（数字的 `max_tokens`，否则数字的 `max_completion_tokens`，否则 `null`），场景随之补三种取值；用途句加 model-proxy「托管 models.yml」。
- `chat-harness`：MODIFIED「UI 走查会话元数据」——第 13 步与场景「任务清单走查」里「listing / reading `进行中` `整理需求`」改为「`todo-status` 节点文本」（状态词视觉隐藏、图标可见），其余原样。
- `session-todo`：MODIFIED「任务清单面板」——可见条件加「已完结清单保留到下一条用户消息」的页面内存规则；状态标记改为图标 + 读屏文字；场景「全部完成或放弃时隐藏」收窄到首次装入 / 切会话再切回 / 刷新三例（名字保留），新增场景「已完结清单保留到下一条用户消息」，首个场景补图标与视觉隐藏的断言。

## Impact

- web：`web/src/features/chat/markdown-body.tsx`（组件覆盖）、新文件 `web/src/features/chat/markdown-html.ts`（显式 sanitize schema + 两个小 rehype 步骤：不安全链接 / 图片转文字、消毒后的 `style` 过滤）、`web/src/components/assistant-ui/elements/markdown-text.tsx`（透传 `rehypePlugins`，第六类修改）、`web/src/features/chat/todo-panel.tsx`、`web/src/features/chat/composer-dock.tsx`（`kept` 规则）、`use-chat-session.ts` / `page.tsx` / `conversation-view.tsx`（把本页提交的 `sending` 传给停靠区）、`web/src/components/icon.tsx`（四个新图标名）、`web/package.json` + lockfile（两个依赖）、`ATTRIBUTION.md`（两条）。测试：`web/test/chat-markdown.test.tsx`、`web/test/chat-messages.test.tsx`（M1）、`web/test/ui-guardrails.test.ts`（归属守卫）、`web/test/chat-todo-panel.test.tsx`（T1–T3、V1、G6）；e2e `web/e2e/ui-walk-todo.ts` 的 `todo-status` 断言保持可过，新增一条可见性断言。
- server：`server/src/model-catalog.ts`（`maxTokens` 解析与缺省）、`server/src/model-proxy/models-yml.ts`（按模型写出）。测试：`server/test/model-catalog.test.ts`、`server/test/model-proxy-models-yml.test.ts`、`server/test/models-yml-helpers.ts`，以及钉 `maxTokens: 8192` 字节或构造 `CatalogModel` 字面量的 `server-startup-layout`、`server-startup-order`、`model-proxy-reasoning`、`server-config*`、`server-assembly`、`session-meta-fixtures`、`session-composer-helpers`、`session-composer-store`、`support/omp-official*`、`linux/uid-isolation`（清单见 design「Context」）；假上游请求记录加 `maxTokens`（`server/test/support/fake-upstream.mjs`、`fake-upstream.d.mts`、`fake-upstream-requests.test.ts`、`fake-upstream-tool-rounds.test.ts`），官方二进制对照用例据此断言上限。
- 文档：`docs/architecture/system.md` 的 `MODEL_CATALOG` 表与示例；`docs/acceptance/functional-checklist.md` CH-04 / CH-39 / CH-40 / CH-42。
- 不碰：服务端 todo 持久化、`chat_sessions.todo` 的写入路径、`GET /api/composer/options` 的形状、文件页的 `md-render.ts`、用户消息与思考折叠块的渲染、`contextWindow`。
