# Proposal: files-empty-states-layout（#294）

## Why
S1e 组 5 的 5.3，依赖 1.5（#279 `EmptyState`）、2.3（#283 外壳两档响应式）、5.2（#293 `formatSize`），均已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把文件页空态文案与布局列为实现偏差：
- 展开的空目录显示 `此文件夹为空`（`web/src/features/files/tree.tsx:163`）；demo 为 `空目录`（demo:3877）。空间根为空时同样只显示 `此文件夹为空`；demo 为 `该工作空间暂无目录` + `点击左上角 ＋ 新建文件夹…`（demo:3854,3910）。
- 不支持类型只显示 `该类型不支持预览`（`preview.tsx:264-270`），没有 demo 的 `<name> · <size>　二进制或未识别格式` 副行（demo:3919）。
- 三处空态（未选文件、无空间树区、不支持类型）是手写 `ui-empty` 段落，未消费 `EmptyState`。
- 布局只有 760 一档；树栏在 ≤900 不收窄为 210（demo 断点）。树条目名称 `overflow-wrap:anywhere` 换行，没有单行省略和 `title`。

## What Changes
- `tree.tsx`：
  - 展开后为空的非根目录显示 `空目录`（替换 `此文件夹为空`）。
  - 空间根一层为空时，根行下渲染 `EmptyState title="该工作空间暂无目录" description="点击左上角 ＋ 新建文件夹"`（不提挂载：挂载属 S1b）。
  - `EmptyPreview` 改为 `EmptyState title="未选择文件" description="在左侧目录树中选择一个文件进行预览"`，外包 `.files-preview-empty` 占满预览区并居中。
  - 目录行与文件行按钮加 `title`，值为全名（根行为其 label）。
- `page.tsx`：无空间树区改为 `EmptyState title="先选择或创建工作空间" description="使用左上角 ＋ 新建工作空间"`，文案不变。
- `preview.tsx`：
  - 不支持态改为 `EmptyState title="该类型不支持预览" description={`${name} · ${formatSize(size)}　二进制或未识别格式`}`（中间为全角空格 U+3000）。
  - `PreviewState` 的 unsupported 分支删去从未被赋值的 `message?`（`preview.tsx:20`、`types.ts:38`；唯一生产者 `tree.tsx:451` 不传 message）。
- `files.css`：
  - 新增 `@media (max-width: 900px)`，树栏 `210px`；既有 760 纵向块保留。
  - `.files-tree-name` 改为单行省略（`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`），去掉 `overflow-wrap:anywhere`。
  - 删除被 `EmptyState` 取代的 `.files-tree-empty` 与 `.files-preview-empty p` 规则；`.files-preview-empty` 只保留占满与居中。
  - 预览容器 `.files-code, .files-table`、`.files-md` 已是 `overflow:auto`，不改，由测试钉住。
- 测试：新 `web/test/files-empty-layout.test.tsx`（E1–E5）；`files-page.test.tsx` F4 的 no-`text-overflow` 断言按 #293 移交反转；`preview.test.tsx` 不支持态两例改写（见 design）。

## Non-goals
- 根行 `shield` + 空间名与逻辑路径（5.1b #292）。
- 切换器、`＋` 菜单迁 `Menu`、对话框迁 `Dialog`（#295 等）。
- ui-walk 截断/宽度断言（6.1）与夹具（6.2）。
- `.files-preview-meta` 窄屏换行、mtime 格式。

## Capabilities
- MODIFIED `files-web`：
  - Requirement「工作空间页」以已晋升文本为底：
    - 无空间句补树区 `EmptyState` 文案；
    - 左栏目录树补 `空目录` 与空根 `EmptyState`；
    - 右栏补未选文件 `EmptyState` 与不支持态 `EmptyState` 及副行；
    - 新增 Scenario「空目录与空态文案」。
  - Requirement「文件预览纯组件」不进 delta：其原文与 Scenario「预览状态」在本刀后仍成立；不支持态副行契约只在「工作空间页」一处定义。
  - Requirement「文件界面与键盘可用性」首句补树栏 280/210、760 纵向、条目省略 + `title`、预览容器 `overflow: auto`（取父 delta 原句的布局部分；"只经 ui-primitives"句属其它刀）；新增 jsdom 层 Scenario「长名截断与布局规则」。父 Scenario「三档宽度布局」的像素证据归 6.1。

## Impact
- 源码：`web/src/features/files/{tree.tsx,page.tsx,preview.tsx,types.ts,files.css}`。
- 测试：`web/test/files-empty-layout.test.tsx`（新）；`web/test/files-page.test.tsx`（F4 两行反转）；`web/test/preview.test.tsx`（不支持态两例改写）。
- 不加依赖，不动服务端、`web/src/ui/**`、`web/e2e/**`。

## 与 oracle 偏差留痕
- demo 在空根时，树区显示单行 `该工作空间暂无目录`（demo:3854），预览区显示 empty-state（demo:3910）。父 delta 与 issue 都把这组文案写成"空树"，只要求一处显示。本刀在树区用一个 `EmptyState` 同时给出标题与引导，预览区保持 `未选择文件`：只用一个组件、一个位置，不需要把"根是否为空"上提到预览区。
- demo 副行尾部为 `，可下载到沙箱后处理`、空根副行为 `，或挂载本服务器/外部服务器目录`。下载与挂载属 S1b 之后的能力，按"无后端契约控件不渲染"去掉，与父 delta 一致。

## Risk triage
- 文件按钮加 `title` 会改变可访问描述，但不改变可访问名：名称由内容计算，`title` 只在无内容时参与。E4 钉住 exact 名仍唯一命中。
- `.files-tree-name` 改 `nowrap` 后，大小列保持 `flex:none`，名称 `min-width:0` 才能收缩。缺 `min-width:0` 时 flex 子项不收缩，长名会撑宽行。E5 钉住规则。像素证据归 6.1。
- 删 `message?`：`preview.test.tsx:485-499` 以 message 字段钉转义语义。改写为以含标记的文件名钉同一语义（字面文本、无 `img` 元素），覆盖不丢。
- `此文件夹为空` 与 `ui-empty` 段落没有其它测试或 ui-walk 引用（已 grep `web/test`、`web/e2e`）。
