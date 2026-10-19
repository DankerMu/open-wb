# Design: epic-acceptance-followups

## Context

动机见 proposal「Why」。三处现状（master 5c43546c）：

- 助手正文：`web/src/features/chat/markdown-body.tsx:47` 以 `components = { a: InertLink, img: ImageText, CodeHeader }` 覆盖 `MarkdownText`（`web/src/components/assistant-ui/elements/markdown-text.tsx:51-55`，`remarkPlugins={[remarkGfm]}`，已传 `defer`，无 rehype 插件）；`react-markdown` 10.1.0 在没有 raw 插件时把源 HTML 作为文本输出，`defaultUrlTransform` 丢弃 `javascript:`/`data:`。规格 chat-web「消息线程」首段与 `正文` 段三条规则、场景「Markdown 链接惰性与图片不加载」钉死现状，ui-foundation「组件分层」:51 的举例「链接惰性、图片显示为 alt 文本」与之呼应；测试 `web/test/chat-markdown.test.tsx:66-125` 与 `web/test/chat-messages.test.tsx:56-72`（M1：源 HTML 文本化、链接惰性、`example.com` 不出现）。仓库里没有 HTML 解析与消毒的库（`node_modules` 无 `hast-util-sanitize` / `hast-util-raw`）。`rehype-sanitize@6.0.0` 依赖 `hast-util-sanitize@5`，其缺省 schema（GitHub）的事实：`strip` 只有 `script`（不在白名单的其它元素去元素留文字，`style` 的 CSS 文本会留下）；`attributes['*']` 含 `id`、`name`（经 `clobber` 加 `user-content-` 前缀保留）、`target`、`tabIndex`、`accessKey`、`title`、`lang`、`dir` 等；`tagNames` 含 `input`（`required.input = {disabled:true, type:'checkbox'}`）、`picture`、`source`（`srcSet`）；`code` 允许 `language-*` class，`li`/`ul`/`ol` 允许 GFM 任务列表 class；协议表 `href: http, https, mailto, xmpp, irc, ircs`、`src: http, https`。主应用没有 CSP 与 Referrer-Policy 头（只有预览源 `server/src/preview/headers.ts`），外站图片可直接加载。
- 模型上限：`server/src/model-proxy/models-yml.ts:40` 对每个模型写死 `maxTokens: 8192`；`CatalogModel`（`server/src/model-catalog.ts:17-26`）没有上限字段；`MODEL_CATALOG` 的键集 `CATALOG_KEYS` 为 `id,name,reasoning,vision,efforts`（`:32`）。规格 model-proxy「托管 models.yml」要求「the same two limits for every model」并要求未设白名单时输出与改前**字节相同**（场景「Single-model output is unchanged」，夹具 checked in）。`maxTokens` 是 omp 发给上游的输出上限（v18.0.10 实测与源码：本托管 provider 发 `max_completion_tokens`——`catalog/src/compat/openai.ts:378-385,519` 只对 Mistral / Moonshot / Zai / Zhipu / chutes / fireworks / 直连 DeepSeek 用 `max_tokens`；值为 `min(请求, 模型, 64000)`；review 1 integration P2）。白名单经 `server/src/sessions/rest-composer.ts:49-51` 序列化给 web（`id,name,reasoning,vision,efforts`）。`server/tsconfig.json` 的 `include` 含 `test`，所以 `CatalogModel` 加必有字段后，所有构造该类型字面量的测试都进 typecheck：`server/test/server-config.test.ts:93`、`server-config-model-id.test.ts:87`（`toStrictEqual` 单模型）、`server-startup-layout.test.ts:164`、`server-startup-order.test.ts:124`、`model-proxy-reasoning.test.ts:36`（都钉 `maxTokens: 8192` 字节）、`server-assembly.test.ts:483-487`、`session-meta-fixtures.ts:13,32-33`、`session-composer-helpers.ts:34`、`session-composer-store.test.ts:168`、`support/omp-official.ts:136`、`support/omp-official-proxied.ts:143`、`linux/uid-isolation.test.ts:249`（字面量缺 `maxTokens`）；fixture 审查补齐的遗漏：`server-config.test.ts:331-339`（两模型 `toStrictEqual`，两项加 32768）、`model-proxy-reasoning.test.ts:132`（第二个字面量）、`model-proxy-models-yml.test.ts:409,465`、`fake-upstream-requests.test.ts:142`（字节级 JSON 精确比对）；经 helper 间接钉单模型字节的断言 `model-proxy-models-yml.test.ts:401-402`、`model-proxy-reasoning.test.ts:150,157,166,172,223,239`、`server-startup-layout.test.ts:75`（改为与替换了 `maxTokens` 行的 helper 比）；`model-proxy-models-yml.test.ts:393` 比的是 m2 = 8192，继续与未改夹具比；`fake-omp.test.ts:792` 的手写 `managedYaml` 与 `omp-official-model-commands.test.ts:68,75` 的手写 yml 是输入、不动。官方二进制对照用例（`omp-official-*`）走的假上游 `server/test/support/fake-upstream.mjs` 只记录每个请求的 `{model, messages}`（`recordRequest`，不留正文；形状由 omp-test-harness「受控上游请求记录」钉死，`fake-upstream-requests.test.ts:144,179,196` 与 `fake-upstream-tool-rounds.test.ts:229` 精确比对），观察不到 `max_tokens`。omp v18.0.10 源码（`packages/ai/src/providers/openai-completions.ts:1772-1788`、`openai-shared.ts:613-628`）：上游请求的输出上限取 `min(请求的 maxTokens, 模型的 maxTokens, provider 夹取)`（没有 provider 夹取时按 `OPENAI_MAX_OUTPUT_TOKENS` = 64000 夹，`types.ts:71`——32768 与 8192 不受影响，配到 64000 以上时实际发出的仍是 64000），字段按 compat 是 `max_tokens` 或 `max_completion_tokens`，请求方未给 `maxTokens` 且未开 `alwaysSendMaxTokens` 时不发；而请求方的值来自 `packages/ai/src/stream.ts:1949`（`maxTokens: options?.maxTokens ?? model.maxTokens`），agent 以 `...config` 调 `streamSimple`（`packages/agent/src/agent-loop.ts:1747-1748`），coding-agent 的 `sdk.ts` / `session/agent-session.ts` 都不设 `maxTokens`——所以按源码 `models.yml` 的值应原样成为请求值；是否真的如此、发哪个字段，只能对着官方二进制量。
- 任务清单：`web/src/features/chat/todo-panel.tsx:17-23` 的 `STATUS_LABEL` 作为可见文字渲染在 `data-slot="todo-status"` 节点里（`:129-135`）；可见条件 `hasUnfinishedTask(todo)`（`:48-51`）由 `composer-dock.tsx:52` 消费，全部完结即不渲染。`ChatState = {status, messages, todo}`（`stream.ts:62-66`），`messages[].role` 可区分用户消息。提交路径 `turn-actions.ts:290-318`：`prompt` 202 后 `getMessages` 装入快照，**没有**乐观插入的本地用户消息；dock 收到的 `inputLocked` 是 `composerDisabled`（`conversation-view.tsx:296`），它含回合进行中（`composer-locks.ts:34-36`：`turnActive = sending || regenerating || running`），而 `todo.updated` 只在回合进行中到达——不能拿它当消失条件；本页提交本身是 `composerLocks` 的入参 `sending`（`use-chat-session.ts:706`：`ownedBusy && (creating || submitting)`，点「发送」时置位，受理装入或失败收尾时复位），目前不往下传。图标组件 `web/src/components/icon.tsx` 是 lucide 名字到组件的封闭映射（已有 `circle-check`；lucide 导出 `Circle`、`LoaderCircle`、`CircleX`、`Ban`）。e2e `web/e2e/ui-walk-todo.ts:31` 按头部按钮名、`:33` 按数量断言，`:39-40` 按 `[data-slot="todo-status"]` 的 `toHaveText(["进行中","待办"])` 与 content 断言；chat-harness「UI 走查会话元数据」第 13 步与场景「任务清单走查」写「listing / reading `进行中` `整理需求`」。单测 `web/test/chat-todo-panel.test.tsx` 的 `items()`（`:142-146`）同样按 `todo-status` 取状态文字，G6（`:662-694`，#1523 后的行号）依赖「就地完结后面板消失」。验收清单 CH-42（:109，已签通过）的期望写「全部完成或放弃后面板整个消失」。

## Goals / Non-Goals

**Goals:**

- 三条 owner 裁决各自落成规格 + 实现 + 测试，一个 change 三个 task 组，每组一个 PR。
- 消毒是 XSS 底线：任何源 HTML 都不能执行脚本、不能触发事件属性、不能注入 `javascript:`，被剥除的内容不以文本漏出，`style` 不能借 CSS 函数外连；流式中间态与终态一致。
- 不改服务端 todo 持久化、不改 composer 契约、不改文件页渲染器。

**Non-Goals:**

- 文件页 Markdown 预览（`web/src/lib/md-render.ts`）的 HTML 策略——另一条产品面，未被 owner 要求。
- 用户消息、思考折叠块、工具段输出里的 HTML——它们按文本渲染，本 change 不动。
- `data:` 图片、相对路径链接 / 图片的渲染——按「只留文字」处理（owner 要的是外站链接与图片可用；相对路径在会话页没有可解析的基准）。
- 图片代理 / 缓存、外站图片的隐私告知、Referrer-Policy 响应头——owner 选择直连（`no-referrer` 已是可做的最小缓解）。
- `style` 属性里 CSS 资源函数之外的限制（布局类声明放行，owner Q1：完整保留 style）。
- `contextWindow` 可配、`maxTokens` 进 web 契约或模型选择器、按会话改上限。
- 已完结清单跨刷新 / 跨会话切换 / 经欢迎态往返的保留（owner Q2：前端内存规则）。
- 任务清单的服务端清空时机、`chat_sessions.todo` 任何写入路径。

## Decisions

### owner 的裁定（2026-10-18，已定，不是选项）

| 编号 | 分支 | 结论 |
|---|---|---|
| A1 | CH-04 源 HTML | 要渲染：全部渲染，含链接与图片，保留 `style` |
| A2 | CH-04 `style` 范围 | 完整保留 `style`；只剥除借 CSS 函数外连的取值（`url(` / `expression(` 一类，整个属性丢弃） |
| A3 | CH-04 底线 | 消毒不商量：`script`/`iframe`/`object`/`form` 等、`on*`、`javascript:` 一律剥除；链接新标签页 + `noopener noreferrer`；图片直连、不带 referrer |
| B1 | CH-39 上限 | `MODEL_CATALOG` 按模型可配 `maxTokens`，缺省 32768；未设白名单也 32768；上限 128000（= `contextWindow`） |
| C1 | CH-40 状态 | 图标可见 + 文字仅供读屏（待办空心圆、进行中半圆、完成勾、放弃叉、受阻禁止符） |
| C2 | CH-40 保留 | 全完成清单留到用户点「发送」那一刻；刷新 / 切会话再切回不显示；不改服务端 |
| P1 | 流水线组织 | 一个 change、三个 task 组、一次流水线 |

### 起草者的技术决定

**D1 源 HTML 的管线：raw → 不安全目标转文字 → 白名单外标签转原文 → 白名单消毒（自定 schema）→ `style` 过滤。**
`react-markdown` 的渲染基于 hast，源 HTML 要先由 `rehype-raw`（parse5）解析进树，再由 `rehype-sanitize` 按白名单消毒。两个仓库自写的小步骤与 schema 放在新文件 `web/src/features/chat/markdown-html.ts`：
- `inertUnsafeTargets`（在 sanitize **之前**跑；另外删掉 `type` 不分大小写不等于 `checkbox` 的 `input` 元素，见下条 schema）：`a` 的 `href` 不是 `http://`/`https://`/`mailto:`、或 `img` 的 `src` 不是 `http://`/`https://` 时（协议后要求 `//`：`https:evil`、`https:/api/...` 被浏览器按相对地址解析成同源请求，review 1 security P2），把元素换成文本——`a` 换成其子节点，`img` 换成 `alt || src` 的文本节点。放在 sanitize 之前是为了还拿得到原始 URL（sanitize 与 `defaultUrlTransform` 都会先把 `javascript:`/`data:` 删掉，之后就无法按规格「无 alt 时渲染其 URL 文本」）。
- `literalUnknownTags`（在 sanitize **之前**跑；owner 2026-10-18 第二轮裁决：白名单外标签按原文显示，不丢 `<task>` 这类占位符）：元素的 `tagName` 既不在 schema 的 `tagNames` 也不在 `strip` 里时，在产生它的 `raw` 节点的值上取起始标签原文——`rehype-raw` 在每个 `raw` 节点起点重设位置后按该节点**值**的字符计数（remark 已剥掉列表缩进 / `> ` 等逐行前缀），所以后代元素的偏移是「raw 起点 + 在 raw 值内的下标」，拿它去切 `String(file)` 从第二行起就会错位（review 1 P1：列表项 / 引用块里的多行 HTML 块丢占位符或读错属性）。做法：在 `rehype-raw` 之前跑一个只读步骤记下每个 `raw` 节点的 `{start.offset, value}`（按起点排序，挂在 `file.data`），`literal()` 用 `start.offset` 找到所在的 raw 段，在 `value.slice(offset - rawStart)` 上取起始标签；结束标签同样在含 `end.offset - 1` 的 raw 段里取。只信起始位置——未闭合且无内容、落在段落或列表项末尾的标签，`rehype-raw` 给的结束位置是 0，所以 `slice(start, end)` 不可用。raw 值自该下标起以 `<` + `tagName` 起头（不分大小写）才算源 HTML 写出的——把元素换成「起始标签原文（线性正则截到起始标签收尾的 `>`，引号内的 `>` 不算）的文本节点、原有子节点、源文本在 `end.offset` 处以 `</tagName\s*>` 收尾且 `end.offset ≥ start.offset + 起始标签长度` 时的结束标签原文文本节点」；raw 值在该处不以该标签起头、找不到所在 raw 段或没有位置信息（Markdown 自身生成的 GFM 脚注 `section` 等）则换成其子节点，与原先 sanitize 去壳留文字相同。`strip` 表的七个元素不经此步，照旧由 sanitize 连内容删掉。ui-walk 第 10 步（chat-harness）要求 `/todo` 回复里的 `<task>` 原样可见，这一步是它的保证。
- schema（显式写出；`hast-util-sanitize` 以 `{...defaultSchema, ...options}` 浅合并，传入的键整体取代缺省，所以下列键都要写全）：`tagNames` 恰为 chat-web delta 的元素白名单——`p`、`h1`–`h6`、`b`、`strong`、`i`、`em`、`u`、`s`、`del`、`ins`、`mark`、`kbd`、`code`、`pre`、`sub`、`sup`、`span`、`br`、`hr`、`div`、`blockquote`、`q`、`ul`、`ol`、`li`、`dl`、`dt`、`dd`、`table`、`thead`、`tbody`、`tfoot`、`tr`、`th`、`td`、`details`、`summary`、`a`、`img`、`input`（缺省里的 `picture`/`source`/`samp`/`var`/`tt`/`strike`/`ruby`/`rp`/`rt`/`section` 等不在其内——源 HTML 写出的已在上一步转成原文文本，到这里只剩 Markdown 自身生成的，去元素留文字；GFM 脚注的 `section` 与锚点链接因此退化为文字，与「只有锚点的链接只留文字」一致）；`strip: ['script','style','noscript','textarea','iframe','object','embed']`（连内容去掉）；`attributes`：`'*': ['style','title','lang','dir']`，`a: ['href']`，`img: ['src','alt','width','height']`，`td`/`th: ['colSpan','rowSpan','align']`，`ol: ['start', ['className','contains-task-list']]`，`ul: [['className','contains-task-list']]`，`li: [['className','task-list-item']]`，`code: [['className', /^language-./]]`，`input: [['type','checkbox'], ['disabled', true], 'checked']`（取值元组：只放行这些取值）；`clobber: []`（`id`/`name` 不在白名单即剥除，不以前缀保留）；`protocols`、`required`、`ancestors` 沿用缺省（`required.input = {type:'checkbox', disabled:true}` 只给缺失的键补值、不限制取值）。`target`、`rel` 不在 schema 里，由 `components.a` 统一写出。`sanitize` 本身删不掉 `type` 不是 checkbox 的 `input`（取值元组只丢掉这一属性，`required` 再补成 disabled checkbox），所以这一类由下一步之前的 `inertUnsafeTargets` 整个删掉。
- `styleGuard`（在 sanitize **之后**跑）：`style` 取值含 `/*` 即删掉整个属性（review 1 security P1：渲染器 `inline-style-parser` 先按 `;` 切声明再逐值去闭合注释，整串去注释的判法会跨声明配对——`content:'/*';background:u/**/rl(…)` 两种视图都查不到、渲染后却是 `url(`；CSS 转义造不出 `/*`，所以一刀切掉注释没有误伤布局声明）；否则解码 CSS 转义（`\HH…` 十六进制与 `\x` 单字符两种形式）、小写化、去空白，查是否含 `url(`、`image(`、`image-set(`、`-webkit-image-set(`、`cross-fade(`、`src(`、`expression(` 之一；含则删掉整个 `style` 属性。只过滤资源函数，不过滤布局声明（A2）。
- `components.a`：有 `href` 才到这里（没有的已被第一步转成文字）——渲染 `<a href target="_blank" rel="noopener noreferrer" className="aui-md-a text-primary hover:text-primary/80 underline underline-offset-2">`（固定类与拷入层 `markdown-text.tsx` 自带的 `a` 组件相同；owner 2026-10-18 第二轮裁决——`theme.css:227` 基础层把 `a` 重置为 `color: inherit; text-decoration: none`，而 ui-foundation 禁止在 `styles.css`/`theme.css` 基础块增加规则，所以由组件写 Tailwind 类）；`components.img`：渲染 `<img src alt loading="lazy" referrerPolicy="no-referrer" className="max-w-full">`。`CodeHeader` 不变。
- `MarkdownText` 新增 `rehypePlugins` 透传——拷入层的第六类修改（ADR-0013 2026-10-04 放宽：只转发调用方的值、不写默认值，调用方不传时行为与原文一致；`MarkdownTextPrimitiveProps` 已含 `react-markdown` 的 `Options`）。ui-foundation「组件分层」:51 与 chat-web 首段的举例随之改写（两处 delta）。
- 顺序：`rehypePlugins = [recordRawSegments, rehypeRaw, inertUnsafeTargets, literalUnknownTags, [rehypeSanitize, schema], styleGuard]`（五步处理，外加 raw 之前一个只读记录步）。
备选：DOMPurify 对 HTML 字符串消毒——与 hast 管线不兼容，还得再解析一次；`skipHtml` + 自写 remark 插件——要自己写 HTML 解析器，否决；沿用缺省 schema 再打补丁——缺省会把 `style` 的 CSS 文本留下、把 `id` 加前缀保留，正是 Stage 3 抓到的三处不一致，所以 schema 显式写全。

**D2 依赖：`rehype-raw@7.0.0`、`rehype-sanitize@6.0.0`（web 的 dependencies），登记 `ATTRIBUTION.md`。** 现有工具做不到：解析 HTML 片段需要 parse5 的容错解析（流式期间大量未闭合标签），白名单消毒需要按 hast 节点处理属性与协议。两者都是 unified 官方包（MIT；`rehype-raw` 经 `parse5` 带入的间接依赖 `entities`@6 为 BSD-2-Clause，在 `ATTRIBUTION.md` 条目里写明）、无运行时网络、与 `react-markdown` 10 同一 hast 版本线。`ATTRIBUTION.md` 按既有条目（`remark-gfm`、`hast-util-to-jsx-runtime`）加两条，`web/test/ui-guardrails.test.ts` 的 `hasEntry` 守卫补对应断言。PR 正文按 AGENTS.md:40 写明。

**D3 `maxTokens` 是白名单模型的必有字段，缺省在解析器里补齐。** `CatalogModel.maxTokens: number`（解析后恒有，与 `vision` 同一做法），`MODEL_CATALOG` 条目可选键 `maxTokens`：`Number.isInteger` 且 1 ≤ n ≤ 128000，否则启动失败并点名 `MODEL_CATALOG`（错误信息不回显取值，沿用 `catalogError`）；缺省 32768；未设 `MODEL_CATALOG` 的单模型项也带 `maxTokens: 32768`。`models-yml.ts` 的 `modelLines` 写 `maxTokens: ${model.maxTokens}`。`rest-composer.ts` 的序列化**不加**该字段（显式只挑五个键，现状即如此；测试加「没有 `maxTokens` 键」的断言）。Context 列出的全部 server 测试随之改：钉 `8192` 字节的改为按白名单取值（单模型 32768；三模型用例把 `m2` 写成 `"maxTokens": 8192` 以同时覆盖显式值），`CatalogModel` 字面量补 `maxTokens`——优先改共享夹具（`models-yml-helpers.ts`、`session-meta-fixtures.ts`、`session-composer-helpers.ts`、`support/omp-official*.ts`）。假上游的请求记录加一个字段 `maxTokens`（数字的 `max_tokens`，否则数字的 `max_completion_tokens`，否则 `null`；omp-test-harness「受控上游请求记录」一处 delta），官方二进制对照用例加一条，放在**新 world** 里：`models.yml` 由 `writeManagedModelsYml` 生成（`support/omp-official.ts` 缺省 world 加 `maxTokens` 选项，不用 `omp-official-model-commands.test.ts:68,75` 的手写 yml——那只能证明 omp 透传 yml，证明不了 writer 的值到达上游），不种 `plantCompaction`（它会往记录里塞自带 `max_tokens` 的压缩请求；标题请求不会混入——生产 argv 带 `--no-title`，`process.ts:105`），断言范围是单个 prompt 回合（含工具轮）的全部记录 `maxTokens` 等于写出的值（32768 与 8192 两跑）——这是 CH-39「不再截断」唯一的机器可观察量。新文件进 CI 的官方二进制清单（`.github/scripts/ci-uid-isolation.sh:292` 按文件名列出，`scripts/test-ci-harness.sh` 钉住该命令形状），与既有 7 个同在 `uid-isolation` job 里跑。实测（v18.0.10，2026-10-19）：32768 与 8192 原样到达上游；写 64000 以上时 omp 夹到 64000（`OPENAI_MAX_OUTPUT_TOKENS`），规格范围 1–128000 不变、system.md 注明。**实测记录为 `null`、不等于写出的值、或被夹到更低（说明 coding-agent 在别处自带缺省）时停下回 owner**：那说明 omp 没有按 `models.yml` 发上限，CH-39 的截断根因另有所在，改 `maxTokens` 修不了它。备选：环境变量 `MODEL_MAX_TOKENS` 全局一个值——owner 选了按模型可配。

**D4 「字节不变」场景改为「只差一行」。** 规格 model-proxy 要求未设白名单时输出与改前夹具字节相同；改缺省必然破坏它。改写为：把 checked-in 的改前夹具里唯一的 `maxTokens: 8192` 行替换成 `maxTokens: 32768` 后与新输出字节相同，并断言与未改的夹具恰差这一行。夹具文件不动（它们就是「改前」的定义）。引用这条「字节不变」的另两处——thinking-fold 场景「关闭 reasoning」与 http-service-skeleton「服务启动与装配」的「单模型时写出的字节不变」——同步改为指向 model-proxy 的单模型输出（两个 delta，只改这一句）；对应的字节断言（`model-proxy-reasoning` 等）已在组 2 的 `maxTokens: 8192` 清单里随之更新，不另增测试。

**D5 状态图标进 `Icon` 映射，文字改视觉隐藏，`data-slot="todo-status"` 留在文字节点上。** `icon.tsx` 加 `circle`（待办）、`loader-circle`（进行中：lucide 的半圆弧）、`circle-x`（已放弃）、`ban`（受阻）；`circle-check` 已有。`todo-panel.tsx` 每项渲染 `<span aria-hidden="true" className={STATUS_TONE[status]}><Icon name/></span>`（`Icon` 没有 `className` / `aria-hidden` prop，`icon.tsx:103-117`——由外包 span 承担隐藏与着色，svg 以 `currentColor` 取色，不改共享组件）+ `<span data-slot="todo-status" class="sr-only">{STATUS_LABEL}</span>` + content；列表项的可访问文本因此仍以状态文字开头，ui-walk `:39` 的 `toHaveText` 读 `textContent`、照常通过（chat-harness 两处措辞改为「`todo-status` 节点文本」，一处 delta）。单测里「可见文本不含状态词」的判定方法：克隆面板、移除带 `sr-only` 类的节点后看 `textContent`（jsdom 不加载 Tailwind，不能靠计算样式）；`sr-only` 类本身由 ui-walk 的真实浏览器用包围盒断言：每个 `todo-status` 节点宽高 ≤ 1、每项的图标宽度 > 1（Playwright 把 1×1px + `clip-path` 的节点视为可见，`toBeHidden()` 与 `innerText` 判不了）。jsdom 的可访问名计算（`dom-accessibility-api`）不从内容为 `listitem` 取名，单测改以 `listitem.textContent` 以状态词开头为准。备选：`aria-label` 放在列表项上——会覆盖 `content` 的可访问文本，否决；把 `data-slot` 挪到图标上——ui-walk 立刻红，否决。

**D6 已完结清单的保留是 dock 的内存状态：记下 = 就地完结，清掉 = 本页点「发送」。** `use-chat-session.ts` 把 `composerLocks` 已有的入参 `sending` 一并返回，经 `page.tsx`、`conversation-view.tsx` 作为新 prop `sending` 传给 `ComposerDock`（不用 `inputLocked`：它含回合进行中，回合内就地完结时恒为真）。dock 新增 `kept: {sessionId, todo} | null`，在渲染期间比对上一次的值（与既有的 `layout` 比对同一做法）：同一 `sessionId` 下上一次的 `todo` 有未完结任务、这一次全部完结 → 记下 `{sessionId, todo}`（不分来源：`todo.updated` 与快照重装都算，规格同此）；`kept` 存在、同一 `sessionId` 下到来另一份已完结清单 → 用它替换 `kept.todo`（面板继续显示、计数随之变）；`sending` 为真 → 清掉（点击即消失；之后被拒、上传阶段停止、受理后读快照失败都不复现）；`todo` 变为 `null` 或含未完结任务 → 清掉（常规规则接管）；`sessionId` 变化（切会话、欢迎态）→ 清掉。可见条件 = `hasUnfinishedTask(todo) || (kept !== null && kept.sessionId === sessionId && sameTodo(kept.todo, todo))`——按内容比对（`stream-todo.ts` 现有的私有 `sameTodo` 导出复用）：重新生成成功、对账、事件流恢复都会以 `chatStateFromSnapshot` 整体替换视图，`todo` 是新解析的对象，按引用比对会把保留中的清单藏掉（Stage 4.5 第二轮查出）。刷新 → 组件重建、`kept` 为 `null` → 快照里的已完结清单不显示。重新生成走 `regenerating`、不经 `sending`，不清。头部计数照常（`3/3`）。备选：钥匙取最后一条用户消息 id——被拒复现与快照失败两条路径要另写规则，且 C2 要的是点发送那一刻，否决；用 `inputLocked`——回合内即隐藏，否决（Stage 4.5 第一轮查出）；在 reducer 里打标——要改 `ChatState` 形状与 `stream.ts`，否决。

**D7 验收清单四行重写，结论回到 `待签`，CH-39 的结论归组 2。** CH-04 的「期望」改写为新行为（可点链接、图片加载、标签生效、脚本不生效、红色 span 为红）——随组 1；CH-39 的「期望」把「每项前面有文字状态」改为「每项前面是状态图标」——随组 3 只改期望文字、**不动结论列**；CH-39 的结论置回 `待签` 随组 2（它的不通过原因是截断，根因由组 2 修）；CH-40 加一步「让清单全部完成后看面板；再发一句话」与对应期望，CH-42 的期望从「面板整个消失」改为「面板仍在、头部 N/N；点发送那一刻消失」——两行随组 3 置回 `待签`。三组可任意次序合入：组 2 与组 3 对 CH-39 改的是不同列。

### 通用纪律

- 测试先行：每组先改测试并在未改动代码上看到红；行为相关的断言改成新规格的断言，不删「没有脚本执行」「没有 `on*`」这类安全断言——它们在新规格下仍成立。
- 不碰 `server/src/sessions`、`stream.ts`、`chat_sessions` 任何列。
- 每个 PR 一个 task 组；组 1 请求一次人工白盒复核（XSS 边界），PR 正文贴 D1 的五步与 schema 清单。

## 规格影响

见 proposal「Modified Capabilities」。七个 delta 都是 MODIFIED（整条 requirement 全文），没有 ADDED / REMOVED。

## Risks / Trade-offs

- [外站图片直连泄露访问者 IP 与在线状态] → owner 已知并选择；`referrerpolicy="no-referrer"`、`loading="lazy"`（不滚到就不请求）；Non-Goals 登记代理。
- [完整 `style` 让模型把气泡内容画成假界面（`position:fixed`/`absolute` 覆盖层能盖住输入框、审批停靠区乃至整页；超大尺寸）] → owner Q1 明确接受，登记为**已接受的残余**：只剥资源函数，不加容器 containment（会改变 owner 裁定保留的 `style` 行为）；正文容器（`message-segments-view.tsx:44`，现只有 `wrap-anywhere`）不在本 change 改动范围内，正常排版的内容沿用既有折行。
- [`style` 借 CSS 转义或 `image-set()` 等绕过字面匹配外连] → D1 的 `styleGuard` 先解码转义、去注释，再匹配七个资源函数；规格场景钉了 `\75 rl(` 与 `image-set(` 两例。
- [流式期间 parse5 每个 token 重解析长正文的 CPU] → `MarkdownText` 已传 `defer`（低优先级重解析）且 `smooth={false}`；任务 1.6 在本地 ui-walk 栈量一次既有 `WORKBUDDY_*` 长回合并把结果写进 PR，阈值与进一步手段登记在 Not yet specified。
- [未闭合标签的中间态闪动（如 `<det` → `<details>` 展开）] → 终态一致是规格要求；中间态不作断言。
- [sanitize 剥除 `class` 让 GFM 任务列表 checkbox / 代码块语言 class 失效] → schema 显式放行 `code` 的 `language-*` 与任务列表 class、`input[type=checkbox][disabled]`；规格场景钉了任务列表 checkbox 的存在；既有代码块用例回归。
- [`maxTokens` 32768 超过某上游模型的最大输出，上游 400] → 由部署方按模型写 `maxTokens`（这正是按模型可配的理由）；`make smoke-live` 打 DMXAPI 的 `deepseek-v4.1-flash` 验证缺省值可用，结果写进 PR。
- [点了「发送」但 prompt 被拒或中途停止，已完结清单不再出现] → C2 定的是「点发送那一刻」消失；清单仍在快照里，刷新也不显示（与「刷新不显示」同一规则），任务结果在线程里可见；规格场景钉了被拒、上传停止、快照失败三例。
- [`sr-only` 文字让 `getByText("待办")` 类测试与 ui-walk 断言失效] → ui-walk 按 `todo-status` 节点的 `toHaveText` 断言，节点与文本都保留（D5）；单测按 `todo-status` 节点与可访问名改写，G6 的触发改为用户提交。

- 「白名单外标签按原文显示」依赖 hast 位置偏移与 `String(file)` 一致（同一份 Markdown 源）；流式半截的起始标签（如 `<tas`）被 parse5 当作文本，终态与一次性渲染一致由场景「流式期间的半截 HTML 不留痕」覆盖。副作用：`<font color="red">彩</font>` 这类过时元素也按原文显示（与旧行为相同），不再去壳。

## Migration Plan

- 组 2 合入后，未设 `MODEL_CATALOG` 的部署下一次启动即以 32768 作上限；无需迁移。要保持 8192 的部署在 `MODEL_CATALOG` 条目里写 `"maxTokens": 8192`（system.md 示例给出）。
- 组 1 / 组 3 是纯前端行为变化，刷新即生效；回滚即 revert PR。

## Not yet specified

- 长正文流式期间源 HTML 重解析的性能预算：`defer` 已开，但多长的正文、多高的 token 速率下会掉帧，以及超阈值时是节流解析还是只在段落边界重解析——要先有真实栈的量测，现在说不清阈值与手段。

## Sibling surfaces（组 1）

- `MarkdownText` 只有两个调用方：`web/src/features/chat/markdown-body.tsx:58`（本 change 透传插件）与 `web/src/components/assistant-ui/elements/reasoning.aui.tsx:49`（不传插件——透传 SHALL NOT 写缺省值，这里的 HTML 仍按文本显示）。
- 思考折叠块不走 markdown（`web/src/features/chat/thinking-fold.tsx:90` 的纯文本 `ReasoningText`）；审批卡、任务清单内容、错误详情、附件名都是纯文本，不进这条管线。
- 钉住这些地方 `<b>` 按文本显示的既有测试 SHALL 不改且保持绿：`web/test/chat-thinking.test.tsx:710`、`web/test/chat-todo-panel.test.tsx:257`、`web/test/chat-message-error.test.tsx:91`。
- 用户消息气泡（`web/src/features/chat/message-thread.tsx:124` 的纯文本 `<p>`，既有测试 `web/test/chat-messages.test.tsx:74-87` 的 M2）与步骤卡的「原始输出」折叠块（`web/test/chat-steps.test.tsx`）同样不进这条管线、按文本渲染（Non-Goals）；这两处目前没有以 HTML 为输入的既有测试钉住，本 change 不为它们新增断言。
- 对话内搜索（`web/src/features/chat/search-match.ts` 只读 `content`）与复制 / 导出按原文工作，不依赖渲染后的 DOM。

## Sibling surfaces（组 2）

- `server/src/model-catalog.ts`（解析器：`CATALOG_KEYS`、`parseCatalogEntry`、单模型分支）与 `server/src/model-proxy/models-yml.ts`（writer：`modelLines`）是同一条 requirement 的两端，必须同一 PR。
- 消费方：omp（读 `models.yml` 的 `maxTokens`，源码路径见 Context）；`server/src/sessions/rest-composer.ts` 的序列化（逐键挑五个键，不漏 `maxTokens`，测试显式断言）；`store-composer` 的 `ComposerConfig`（如含模型形状，补字段但不外露）；模型代理放行集（按 `id` 放行，不读 `maxTokens`，不改）。
- 夹具 / 测试消费方：`support/omp-official*.ts` 的 world（走 writer）、`fake-omp.test.ts:792` 的手写 `managedYaml`（输入，不动）、假上游请求记录的两个精确比对文件（`fake-upstream-requests.test.ts`、`fake-upstream-tool-rounds.test.ts`）、经 helper 间接钉字节的三处（见 Context）。
- Review focus：(1) 非法值在任何 FS / DB / listen 之前失败且不回显取值；(2) 「只差一行」比对真的只差那一行、m2 = 8192 的比对未被顺手改掉；(3) `GET /api/composer/options` 的 `toEqual` 比对仍不含 `maxTokens`；(4) 官方二进制用例的 world 不含 `plantCompaction`、断言覆盖该回合全部记录；(5) system.md 示例与 `MODEL_CATALOG` 表的缺省 / 范围与解析器一致。

## Sibling surfaces（组 3）

- `hasUnfinishedTask` 只有 `composer-dock.tsx:52` 一个调用方；可见条件只在 dock 里改。
- `layout.panel` 的防误点比对字符串以实际渲染的清单（含保留的已完结清单）为准。
- 归档会话：`view={archived ? null : historyView}`（`conversation-view.tsx:300`），`todo` 为 `null` 按规则清掉。
- `historyView` 只在换会话时变为 null（`use-chat-session.ts:337,485`）；对账、重装走 `installSnapshot`（`:287`），同一会话里不误清。
- 分叉与新建会话都换 `sessionId`，清掉。
- 非目标：别的标签页发的消息不经过本页的 `sending`，保留照旧（规格认可，不加测试）。
- Review focus：(1) `sameTodo` 只导出、`setTodo` 与归约逻辑字节不变；(2) V1 第一步（回合进行中、输入框锁定时就地完结）是区分 `sending` 与 `inputLocked` 的那一步；(3) `kept` 与上一次**渲染**的值比，不是与上一个事件比；(4) 「点击的那一刻」在请求在途时断言（`deferredResponse`）；(5) 202 / 失败路径的快照带同一份已完结清单，「仍不在」不空转。

## Sketch seams under test

- 组 1：`web/test/chat-markdown.test.tsx` 既有的 `mountReply(text)`（整页挂载 + 假 API 注入一条助手正文）——最高的既有 seam，覆盖 raw → 消毒 → 组件覆盖整条链；安全断言（无 `script`/`iframe`、无 `on*`、`__pwned` 未定义、CSS 文本不漏出）在同一 seam 上保留；`chat-messages.test.tsx` M1 是同一 seam 上被修改场景「消息呈现与流式光标」的落点。
- 组 2（续）：假上游请求记录的 `maxTokens` 字段由 `fake-upstream-requests.test.ts` 的既有 seam 钉住，官方二进制用例经同一记录观察上限。
- 组 2：`resolveModelCatalog(env)`（`server/test/model-catalog.test.ts`）与 `writeManagedModelsYml` 的输出字节（`server/test/model-proxy-models-yml.test.ts` + `models-yml-helpers.ts`，以及钉同一字节的 `server-startup-layout` / `server-startup-order` / `model-proxy-reasoning`）；`max_tokens` 到达上游由官方二进制对照用例的假上游请求记录证明。
- 组 3：`web/test/chat-todo-panel.test.tsx` 既有的整页挂载 + 注入 `todo.updated` / 假 API 的 prompt 应答——面板可见性、计数、`todo-status` 节点都在这一 seam 上可观察；ui-walk 第 13 步在真实浏览器里钉图标可见、状态词不可见。

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现在 | 合入后上限 | 组 |
|---|---|---|---|
| `web/src/features/chat/markdown-html.ts`（新） | — | ≤ 160 | 1 |
| `web/src/features/chat/markdown-body.tsx` | 61 | ≤ 110 | 1 |
| `web/src/components/assistant-ui/elements/markdown-text.tsx` | 241 | ≤ 250 | 1 |
| `web/test/chat-markdown.test.tsx` | 268 | ≤ 460（超出则拆 `chat-markdown-html.test.tsx` ≤ 320） | 1 |
| `web/test/chat-messages.test.tsx` | — | +10 | 1 |
| `web/src/features/chat/markdown-literal.ts`（新，review 1 修复：`literalUnknownTags` 与 raw 节点记录从 `markdown-html.ts` 拆出，后者已到 160 行上限） | — | ≤ 80 | 1 |
| `web/test/ui-guardrails.test.ts`、`ATTRIBUTION.md` | — | +4、+8（既有条目每条 3 行，两条至少 6 行） | 1 |
| `server/src/model-catalog.ts` | 233 | ≤ 270 | 2 |
| `server/src/model-proxy/models-yml.ts` | 72 | ≤ 75 | 2 |
| `server/test/model-catalog.test.ts` | 529 | ≤ 620 | 2 |
| `server/test/model-proxy-models-yml.test.ts` | 471 | ≤ 520 | 2 |
| `server/test/models-yml-helpers.ts` | 41 | ≤ 60 | 2 |
| `server/test/server-startup-layout.test.ts`、`server-startup-order.test.ts`、`model-proxy-reasoning.test.ts`、`server-config.test.ts`、`server-config-model-id.test.ts`、`server-assembly.test.ts`、`session-meta-fixtures.ts`、`session-composer-helpers.ts`、`session-composer-store.test.ts`、`support/omp-official.ts`、`support/omp-official-proxied.ts`、`linux/uid-isolation.test.ts` | — | 各 ≤ +6（取值 / 字面量补 `maxTokens`；`session-meta-fixtures.ts` 实际 +14：biome 100 列折行展开字面量） | 2 |
| `server/test/omp-official-max-tokens.test.ts`（新文件，新 world）、`server/test/support/omp-official.ts`（`maxTokens` 选项） | — | ≤ +40（新文件）、≤ +10 | 2 |
| `server/test/support/fake-upstream.mjs`、`fake-upstream.d.mts` | 647 / — | 各 ≤ +4 | 2 |
| `server/test/fake-upstream-requests.test.ts`、`fake-upstream-tool-rounds.test.ts` | 257 / — | 各 ≤ +12 | 2 |
| `web/src/features/chat/todo-panel.tsx` | 146（#1523 后 159） | ≤ 175 | 3 |
| `web/src/features/chat/composer-dock.tsx` | 174 | ≤ 220 | 3 |
| `web/src/features/chat/use-chat-session.ts`、`page.tsx`、`conversation-view.tsx` | — | 各 ≤ +3（`sending` 往下传） | 3 |
| `web/src/components/icon.tsx` | — | +4 行映射 | 3 |
| `web/test/chat-todo-panel.test.tsx` | 650（#1523 后 694） | ≤ 760（V1 移出、G6 改写后不增） | 3 |
| `web/test/chat-todo-retention.test.tsx`（新，#1524 的保留规则用例） | — | ≤ 260 | 3 |

## Traceability

- owner 裁决：本会话 2026-10-18 AskUserQuestion 四问 + grill 两轮（A1–A3、B1、C1–C2、P1）；账本 `.workplans/batch-33-35-owner-items.md`（本地）。
- 验收事实：PR #1519（CH-04 / CH-39 / CH-40 的 owner 说明）。
- 现状行号：Context 一节；实现前核对（tasks 各组第一项）。
