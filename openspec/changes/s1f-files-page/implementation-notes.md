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

## 2.1（#1076）

- 不触及 Critical Path：`preview.tsx` 是纯展示组件，不取数、不处理路径、不碰 `sandbox.resolve`；单席评审即可。本刀不加 FL 行：`docs/acceptance/functional-checklist.md:189-192`「文件（FL）」现为空表，首批行（含 Markdown / CSV / 图片 / 源码预览）归 `tasks.md:188` 的 3.6，issue 的 PR Boundary 也不含该文件；行为与文案不变、只有观感变化这一点记入偏离记录。
- 行号漂移（记入偏离记录）：`chat-steps.test.tsx:148` 实为 `:137`，用例仍在（`:132` 起），所以改成 `not.toContain(".files-md")` 是要做的事，不是「无事可做」。`ui-walk.spec.ts` 实为 622 行（非 594）：`.files-code` 在 `:266`，`.files-table` 在 `:275`，列表符号断言在 `:255-261`，注释在 `:254`。其余点名行号全部成立：`preview.test.tsx:159`、`:195-204`、`:496`、`:515`；`files-page.test.tsx:506-512`、`:537-541`；`files-empty-layout.test.tsx:71-73`、`:174-181`、`:190-194`；`chat-messages.test.tsx:185-187`；`ui-tokens.test.ts:76-87`；`ui-walk-layout.ts:304-311`。
- 任务 grep 在 `origin/master` 的完整处置，等价改写：`preview.test.tsx:159`、`:496`、`:515`、`:195-204`（标题一并改，不再含 `ui-btn`）；`files-page.test.tsx:506`、`:511`、`:512`；`files-empty-layout.test.tsx:72`；`chat-steps.test.tsx:137`；`ui-walk.spec.ts:266`、`:275` 与 `:254` 的注释。`web/e2e/**` 其余文件、`scripts/`、冒烟都没有预览选择器，也没有截图比对。
- 同一 grep 的其余命中都不由 `preview.tsx` 渲染，旧名保留、本刀不动：`files-empty-layout.test.tsx:22/39/48/82`（3.1）与 `:174-181`（读 `files.css`，3.3）；`files-overlays.test.tsx:220-236`（2.2 / 3.x）；`ui-walk-layout.ts:302-310`（3.5）；`ui-tokens.test.ts:83`（3.3）；`chat-page-search.test.tsx:569`、`chat-page.test.tsx:363`、`functional-checklist.test.ts:274/281`、`ui-dialog` / `ui-empty-state` / `ui-form` / `ui-guardrails` 各测试（冻结基元自身或无关）。
- `ui-walk-layout.ts:304-311` 的 `.ui-btn` 探针不受影响：`新建` 在 `aside` 里，DOM 上先于预览的 `section`（`tree.tsx:262-277`），`.first()` 取到的始终是它，与调用次序无关。
- `preview.tsx`（现 204 行，预计不超过 260）：导入改为 `import { Button } from "@/components/ui/button"` 加 `import { Icon } from "../../ui/index.js"`。拷入层 `Button` 不带默认 `type`（`components/ui/button.tsx:43-64`；冻结区是 `type ?? "button"`），必须显式写 `type="button"`，并用 `variant="secondary"`（高度与旧 `md` 相同）。不覆盖它自带的 `data-slot="button"`，拷入层文件零改动。
- `data-slot` 落点：`header` 用 `preview-header`，其下两个 `p` 用 `preview-path`、`preview-meta`；`CodeView` 外层 `div` 用 `preview-code`，`CsvTable` 外层 `div` 用 `preview-table`；`RenderedMarkdownDocument` 的 `div` 用 `preview-markdown` 并保留 `data-markdown-body=""`；不支持态的块用 `empty-state`，副行 `p` 用 `empty-state-desc`。三个滚动容器都带 `overflow-auto flex-1 min-h-0`。保留 `article`、`table`、`role="alert"` 的结构，以及 `PreviewBody key={path}`、`RenderedMarkdownDocument key={text}`。
- 不支持态在文件内就地渲染（不导出、不建新文件；共用小组件是 3.1 的事）。`files.css:251-257` 的两条是承重规则，要搬过来：块上 `min-w-0`，副行 `[overflow-wrap:anywhere]`。`files-empty-layout.test.tsx:176-181` 之后读的是死规则，不再是证据。
- Markdown 排版要把 `files.css:266-341` 整段搬成 `preview-markdown` 容器上的后代变体（先例 `quick-login.tsx:41` 的 `[&_b]:…`；仓库没有 typography 插件，不写 `prose`）。内容：容器的内边距、最大宽度、`[overflow-wrap:anywhere]`；`h1`–`h4` 的字号、外边距、`font-bold`；`p` / `ul` / `ol` 的下边距；`[&_ul]:list-disc [&_ol]:list-decimal` 加左内边距；`li`、`code`、`pre`、`pre code`、`table`、`th` / `td`。类串放模块级不导出常量。不写 `list-none`（`ui-layering.test.ts:639-657` 会要求 `role="list"`）。
- 其余样式对等：等宽字体用 `font-(family-name:--wb-mono)`（`font-mono` 不是 `--wb-mono`）；窄屏用既有的 `narrow:` 变体（`theme.css:17`），头部 `narrow:flex-wrap narrow:items-start`，元数据 `ml-auto narrow:ml-0`；`ui-alert` / `ui-muted` 换成 token 类（先例 `approval-card.tsx:138`，如 `text-(--wb-status-error-text) bg-(--wb-status-error-soft-bg)`、`text-muted-foreground`）。不写 hex / rgba / `--wb-palette-`（`ui-guardrails.test.ts:47-75`）。
- 共享文件的精确改动，供 2.2 排序：`ui-layering.test.ts`（718 行）在 `:88` 与 `:415` 两处的 `workspace-list.ts` 之后各插一行 `"web/src/features/files/preview.tsx",`，不加注释行。这是 2.1 与 2.2 唯一共同触碰的文件；2.2 在同两处紧挨着插 `dialogs.tsx`，rebase 各一行，3.4 把两行换成目录。`legacy.css` 只删 `:101-113`（注释加三条规则，其中 `:103` 与 `:107` 是同一选择器的两条）。`ui-walk.spec.ts` 只改 `:254`、`:266`、`:275` 三行，不增行。
- 必须留下的：`files.css` 全文不动。其中 `.files-preview`（`:178`）与 `.files-preview-body`（`:234`）不是死规则，`tree.tsx:275`、`:288` 仍命中，issue 说的「死规则」只对 `preview.tsx` 自己的类成立。`legacy.css:9` 的 `@import` 与 `:115-128` 的 `.ui-alert` / `.ui-muted` 留着（`tree.tsx`、`page.tsx`、`dialogs.tsx` 与会话页在用）。`emptyStateOf` 帮手、`tree.tsx`、`page.tsx`、`dialogs.tsx`、`markdown-view.tsx`、冻结区都不动。
- 断言写法：`files-empty-layout.test.tsx:72` 改为 `unsupported.closest('[data-slot="empty-state"]')` 先断言非空，再取其内的 `[data-slot="empty-state-desc"]`，不再经 `emptyStateOf`。`files-page.test.tsx:505-509` 保留 `waitFor`。`preview.test.tsx` 的按钮用例断言两种模式下的可访问名、`getAttribute("type") === "button"`、`className` 不匹配 `/\bui-btn/`。经页面渲染取预览正文的断言一律 `findBy` / `waitFor`。
- 本刀可证的规格范围：files-web「修改时间本地格式」全部可证；「预览状态」不含 `下载 <文件名>` 链接（组 17）；ui-primitives「迁移后行为不回归」只证 `查看源码` / `渲染视图` 一项（其余四个按钮归 2.2 与组 3）；ui-foundation「文件页整目录已迁移」本刀不可证（3.4 之前是单文件条目）。
- 变异表（进 PR 描述）：
- 变异 → 预期判红：去掉 `preview-meta` → `preview.test.tsx` 修改时间格式用例；去掉 `preview-header` / `preview-path` → `files-page.test.tsx` 预览头用例；`查看源码` 改回冻结区 `Button` → `preview.test.tsx` 按钮用例加 `ui-layering.test.ts` 的现状用例；去掉 `type="button"` → 同一按钮用例；去掉 `empty-state-desc` → `preview.test.tsx` 两条不支持态用例加 `files-empty-layout` 的不支持态用例；去掉 `data-markdown-body` → `preview.test.tsx` 的 Markdown 用例抛错；保留 `legacy.css` 三条规则 → `chat-steps.test.tsx` 的 `.files-md` 用例。
- 只有走查能看见的变异（jsdom 不可见）：去掉 `[&_ul]:list-disc` → `ui-walk.spec.ts` 的列表符号断言；去掉 `preview-code` / `preview-table` 的 `overflow-auto` → 走查的 `expectScrollableX`。预期不可观测（无断言，归 3.6 的 FL 行人工走查）：去掉 `narrow:` 类、`min-w-0`、标题字重。

## 2.2、2.3（#1077）

- 前提与边界：不触及任何 Critical Path（纯前端展示层），一个评审席即可；不在 1.1 / 1.2 / 1.3 挡住的集合里；0.1（#1049）与 2.1（#1076）在 origin/master（7e0e6d3）都未合入，按约定视为先合；`implementation-notes.md` 尚不存在。
- 行号漂移：`files-overlays.test.tsx`（263 行）的全部行号、`dialogs.tsx:37-52`、`web/src/ui/dialog.tsx:68-81,164-171`、`web/src/components/ui/dialog.tsx:61-70`、`ui-walk-layout.ts:304-311`、`tree.tsx` 644 行都仍成立；只有 `web/e2e/ui-walk.spec.ts` 漂了（594 → 622 行）：`205-219` → `:226-238`，`262-264` → `:284-286`，`createWalkOutWhileHeld` `286-301` → `:308-324`，`位置` 的 `selectOption` `288` → `:310`，`关闭` `toBeFocused` `294` → `:316`，Tab 循环 `295-298` → `:317-320`；走查文件本刀不改，只在偏离记录里改引用。
- 任务 grep 的当前完整命中（10 条，全在 `files-overlays.test.tsx`）：`:75`、`:124` `aria-modal` 原样保留；`:133`、`:208` `.ui-dialog-overlay` → `[data-slot="dialog-overlay"]`（等价改写，兄弟节点遮罩的按压已由 `chat-page-session-rename-pin.test.tsx:452` 证明可行）；`:220` 标题、`:223`、`:228` 旧名暂留到 3.1 / 3.2；`:233`、`:236` 改为 `className` 不含 `ui-btn`；`:255` 的 `primitiveImport` 帮手保留，`:256-258` 按上面的替换文本改，`:259-261` 不动。
- 放宽到 `web/test web/e2e` 无新增依赖：`files-page.test.tsx:182-205,260-292`、`files-errors.test.tsx:111-115,150-153`、`files-concurrency.test.tsx:28-44`、`files-logical-path.test.tsx:131-139,217-222`、`files-empty-layout.test.tsx:109-113` 都只按角色、标签与 `option` 取元素；`web/test/ui-dialog*.test.tsx` 的 `.ui-dialog*` 属冻结区自测，`web/e2e/ui-walk-steps.ts:164` 属会话页，都不动；`scripts`、`Makefile`、smoke 零命中。
- `dialogs.tsx`（220 → 约 210–240 行）导入：`@/components/ui/dialog` 的 `Dialog, DialogContent, DialogHeader, DialogTitle`，`@/components/ui/button`、`input`、`label`，冻结区只留 `useEscapeFallback`；不直接导入 `radix-ui`（`ui-guardrails.test.ts:99`）、不导入 `useToast`；两个对话框共用文件内一个不导出的外框组件（标题、`pending`、`returnFocus`、初始焦点 ref、`onCancel`），焦点逻辑只写一份，导出仍只有 `WorkspaceDialog`、`DirectoryDialog`，props 不变（`page.tsx`、`tree.tsx` 调用处不改）。
- 外框照 `rename-dialog.tsx:74-110` 的写法：`<Dialog open onOpenChange={cancelOnClose(onCancel)}>`；`DialogContent` 传 `aria-modal="true"`、`aria-describedby={undefined}`、`ref={fallback.ref}`、`onEscapeKeyDown` / `onKeyDown` 取自 `useEscapeFallback({ canClose: true, onOpenChange })`、`onOpenAutoFocus`（`preventDefault` 后聚焦 `工作空间名称` / `位置` 的 ref）、`onCloseAutoFocus`（`preventDefault` 后 `returnFocus.current?.focus({ preventScroll: true })`）；`DialogTitle` 必须有（对话框的可访问名靠它）；Escape、右上 `关闭`、遮罩都只经 `onOpenChange(false)` → `onCancel`，挂起期不锁关闭（等同取消等待）。
- 挂起期焦点：文件内一个 `useLayoutEffect(…, [pending])`；`pending` 为真且活动元素是 `null` / `body` / 内容内已禁用控件时，聚焦 `fallback.ref.current.querySelector('[data-slot="dialog-close"]')`，其余不动；两个对话框都不会以 `pending=true` 挂载，所以不需要 `wasBusy` ref。
- 表单：`取消` 必须显式 `type="button"`——冻结区 `Button` 默认 `button`（`web/src/ui/button.tsx:34`），拷入层 `Button` 没有默认，漏写会让 `取消` 变成表单的默认提交按钮（输入框里按 Enter 等于取消，点 `取消` 还会再触发一次提交）；`创建` 是唯一 `type="submit"` 且 `disabled={pending}`，不写任何键盘处理；不加原生 `required`（`files-page.test.tsx:261-262` 靠空名提交拿到 `请输入名称`）；表单保留 `aria-busy`，挂起说明 `role="status"` 与错误 `role="alert"` 文案逐字不变，错误只在对话框内显示、失败后对话框不关。
- 字段：`useId` + `<Label htmlFor>` + `<Input id>`（先例 `login-form.tsx:17-18,87`），不用包裹式 label（拷入层 `Label` 是横排 flex）；`位置` 仍是原生 `<select id>`，Tailwind 类写在本文件；`将在你的沙箱内创建同名目录` 仍是普通 `<p>`；`files-dialog-form`、`files-field`、`files-dialog-actions`、`files-status`、`ui-alert`、`ui-muted` 不再使用，`files.css:492-493,555-583` 成死规则留到 3.3，`files.css` 本刀不改。
- `CreationMenu` 连同 `CreationMenuProps` 搬到 `tree.tsx`（644 → 约 667 行）：`tree.tsx:3` 的导入加 `Button`、`Menu`，`:4` 去掉 `CreationMenu`；函数体一行不改，但要去掉 `export`（只有 `tree.tsx:266` 调用，留着会被 knip 判未引用导出）——记入偏离记录；`files-empty-layout.test.tsx:183-188`、`files-page.test.tsx:536-541` 读 `tree.tsx` 源码的断言不受影响。
- 与 2.1 的共享行只有 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS`（`:13-89`）与清单断言（`:341-416`）：两刀各在两处列表末尾（`"web/src/features/chat/workspace-list.ts"` 之后）追加一行，按字母序；2.2 rebase 到 2.1 之后，两处末尾都须读作 `…/chat/workspace-list.ts`、`web/src/features/files/dialogs.tsx`、`web/src/features/files/preview.tsx`，即 `dialogs.tsx` 插在 2.1 的 `preview.tsx` 之前；除此之外没有重叠（2.2 不碰 CSS、走查、`preview.tsx`）。
- `files-overlays.test.tsx` 的新增断言：O8 对话框半条在「不含 `ui-btn`」「`创建` 为 submit」之外，加 `取消` 的 `type` 为 `button`，以及「请求挂起期间禁用」（给 O8 的 `/api/workspaces` 换成 `workspaceRoute([workspace], () => held.promise)`，填名、点 `创建`、`waitFor(create.disabled)`，结束前点 `取消`）；O1–O6、O9 一行不改。
- 变异表（2.3 分摊到本刀的四条在前）：(1) 把 `位置` 的初始焦点 ref 挂到 `文件夹名称` → O3 `:126` 红；(2) 去掉 `aria-modal` → O1 `:75`、O3 `:124` 红；(3) `CreationMenu` 留在 `dialogs.tsx` → 分层守卫「web/src 现状」与 O7 新断言红；(4) 去掉挂起期移焦点，或改成聚焦首个可用控件 → O4 `:152`、O5 `:173` 红（jsdom 走已禁用控件分支），走查 `ui-walk.spec.ts:316` 红（Chromium 走 `body` 分支，jsdom 观察不到）；另加：去掉 `取消` 的 `type="button"` → O8 新断言与 O2 红；去掉 `onCloseAutoFocus` → O1 `:82`、O2 `:114`、O3 `:129` 红；去掉 `disabled={pending}` → O4 `:151`、O5 `:172` 红。
- 预计观察不到的变异与偏离记录：整段删掉 `onOpenAutoFocus` 不会红——拷入层把 `关闭` 放在 `children` 之后，Radix 默认聚焦的首个可聚焦控件本来就是 `位置` / `工作空间名称`，所以变异 (1) 必须写成「挪到别的控件」；去掉 `useEscapeFallback` 在 `files-*` 用例里也不会红（没有轻提示在场）。偏离记录写：Tab 顺序里 `关闭` 由最前变最后；宽度用拷入层默认、不再是冻结区的中号；`returnFocus.current` 为空时不再回落到打开者（两条入口都传真实触发器）；`export` 去掉；走查行号改引用。功能验收清单本刀不加行——「文件（FL）」节现为空表，首批行由 3.6 随组 3 加，那时 `新建工作空间` / `新建文件夹` 两行要覆盖四种取消类关闭、挂起说明与同名冲突提示留在对话框内。

## 4.1–4.3（#1053）

- **Critical Path：沙箱与文件边界**（`server/src/core/sandbox/resolve.ts`、`index.ts`）；PR 标注请求白盒审查，分配两个评审席；PR 描述带逐条变异表。
- 漂移核对：issue 的「Current behavior」与代码一致——`resolve.ts` 78 行，`op` 联合在 `:14`，末段判定门在 `:31`（`createsEntry(op) && !isValidMkdirTerminal(...)`），私有谓词在 `:56-59`；`index.ts` 50 行，联合在 `:29`，审计在 `:39-45`；`sandbox-resolve.test.ts` 315 行、`sandbox-facade.test.ts` 258 行。无漂移。
- 必须改的类型点恰三处：`resolve.ts:14`、`index.ts:29`、`server/test/sandbox-resolve.test.ts:90`（`expectRejected` 的 `op` 参数，不改则 tsc TS2345）。其余不动：`workspaces/rest.ts:23` 用 `ReturnType<typeof createSandbox>` 自动变宽；`sessions/prompt-attachments.ts:24` 的窄端口 `op:"read"` 仍可赋值；`workspaces/store.ts:307`、`sessions/undo.ts:270` 直接调纯 `resolve` 且恒为 `"read"`。
- 仓库里没有对 `op` 的 `switch`、穷尽表或「四种 op」计数断言；钉住 `op` 集合的只有两个沙箱测试文件和 `smoke/files.hurl:81,159`（只断言 `list`、`write`，本刀不动）。
- 产品改动只有三点：两处联合加 `"delete" | "move"`；`:58` 的析取加这两个成员；`:56` 的注释改写（「都在目标位置新建条目」对新 op 不成立）。私有谓词 `createsEntry` 改名为 `namesEntry` 之类，不导出。不要内联进 `resolve`（PR #1138 记录内联会让 Biome 认知复杂度从 15 升到 16），不要做 per-op 表，不要抽 `SandboxOp` 导出类型。
- 契约，符号链接：任一已存在分量（含末段）经 `lstat` 为符号链接即拒绝，与 `op` 无关。`delete`/`move` 对「末段是链接」是拒绝，不是「作用于链接本身」（file-operations「拒绝项」`path=link` → 403、「不能经符号链接移出」`{from:"link"}` → 403）。逐分量循环 `:36-48` 一行不改。
- 契约，目标与 `move`：`resolve` 不判定目标是否存在、是什么类型（`regular-file/child` 对新 op 返回 `ok:true`，由路由回 404）。移动的源与目标各解析一次，都用 `op=move`，目标不复用 `write`/`mkdir`。空串对两个 op 都被末段规则拒绝，这是「根不能被删除、移动或作为移动目标」的唯一防线。
- 契约，拒绝原因：`reason` 是自由字符串，不是封闭枚举，本刀不新增值。现有六个是 `cannot resolve sandbox root`(:20)、`path contains a NUL byte`(:24)、`path is absolute`(:27)、`mkdir name is invalid`(:32)、`path is not inside the sandbox root`(:38,:46)、`path escapes the sandbox root`(:51)。`mount` 是 `workspaces/snapshots.ts:60` 的快照 `SkipReason`，与沙箱无关。
- 偏离记录一：新 op 被末段规则拒绝时 `detail.reason` 仍是 `mkdir name is invalid`。沿 PR #1138 先例不改文案；全仓无人断言该字符串（测试只用 `/\S/`）。
- 契约，`resolve` 不做的事（不加规则，记偏离）：不折叠大小写，不做 Unicode 规范化（字节透传，先例 `uploads/图 (1).png`），除 NUL 外不拒控制字符，没有点开头名字的规则，不看 `dev`/挂载点，不预检名字长度。超过 255 字节的分量在 `lstat` 抛 `ENAMETOOLONG` 后落到 `:46` 被拒，即 403 加审计，既有用例 `:293-304` 已钉。
- 契约，回收目录与临时空间：`<SANDBOX_ROOT>/.trash` 在任何空间根之外，`../.trash` 被 `..` 规则拒绝，经 `resolve` 不可寻址；空间内名叫 `.trash` 的条目只是普通条目。临时空间根 `tmp-<id>` 走同一个 `rootOf`，无特殊分支，它的根同样由空串规则保护。
- 审计：`sandbox.reject` 只在 facade 写（`index.ts:39-45`，字段 `kind`、`actorId`、`workspaceId`、`title`、`detail:{relPath, op, reason}`，先 emit 后抛 `sandbox_denied`）；纯 `resolve` 不写。新 op 靠 `detail.op` 原样带出，产品代码除类型外零改动。`rootOf` 为 null 时在 `index.ts:31-33` 抛 `not_found`，先于路径检查且无审计，与 `op` 无关。
- `sandbox-resolve.test.ts` 新增四个 `it`（沿用 `createLayout`、`expectRejected`、前后 `snapshotTree` 比对，以 `for (const op of ["delete","move"] as const)` 循环）：
- (a) 七个与 op 无关的向量：`../x`、`a/../../x`、`/etc/passwd`、`a\0b`、`outside-link`、`linkdir/child`、`dangling`。
- (b) 标题含 `the workspace root cannot be deleted`，断言空串对 `delete` 与 `move` 都被拒；它是场景的第八个向量，也是 4.3 第一条变异的落点。
- (c) `a`、`a/b/c.md` 对两个 op 返回精确的 `absPath`。
- (d) `a/.`、`a/..`、`a/b\c`、`a/` 对两个 op 被拒。
- `sandbox-resolve.test.ts` 既有用例只追加，不改标题、不削弱断言：`:266` 的 `regular-file/child` 用例加 `delete`、`move` 两条 `ok:true`，以及 `regular-file/child/..` 对 `delete` 的拒绝。另建议在 (a) 加 `a/../a` 对两个 op 的拒绝（规格外的补充行，记偏离记录二）：它是新 op 下「根内的 `..`」的唯一见证，没有它变异 M5 无法归到新 op。`write` 的六个既有用例（`:165-252`）逐字不动。
- `sandbox-facade.test.ts` 只在两个既有 `it` 里追加：`:102` 的审计用例末尾加一个循环 `[["", "delete"], ["a/", "move"]] as const`，各断言恰新增一条事件（长度 5、6）且 `detail` 为 `{relPath, op, reason: /\S/}`；`:58` 的 `not_found` 循环对 `"delete"`、`"move"` 各加一次调用（仍无审计）。不单开同形 `it`（PR #1138 记录会多出 4 个 jscpd clone；`.jscpd.json` 阈值 3%、无忽略项）。
- 门槛：改后 `resolve.ts` 约 80 行、`index.ts` 50 行、两个测试约 390 与 280 行，远低于 800。knip 无影响：没有新导出，联合变宽不产生未引用导出，与 10.1 的处理相同；`delete`/`move` 在 #1060、#1062 之前没有调用方，只有这两个测试文件能观察到。
- 实现前的红：tsc TS2345（三处联合）。运行期只有与 op 相关的八条断言红，即空串、`a/.`、`a/b\c`、`a/` 各对两个 op；vitest 不做类型检查。其余向量在旧代码下已是绿的，PR 描述照 #1138 的写法如实说明。
- 变异表（4.3 两条加补充）：
- M1 谓词去掉 `delete`（空串放行）→ (b)、(d) 的 delete 行与 facade 的 `["", "delete"]` 红。
- M2 谓词去掉 `move` → (d) 的 `a/` 等 move 行、(b) 的 move 行与 facade 的 `["a/", "move"]` 红。
- M3 `inspectExisting` 恒返回 true → (a) 的三个符号链接行红；与 op 无关，既有用例同时红。
- M4 去掉 `:26` 的绝对路径判定 → (a) 的 `/etc/passwd` 红（解析为 `<root>/etc/passwd`）。
- M5 去掉 `:37` 的 `..` 判定 → 仅 `a/../a` 行与既有 `regular-file/child/..`（read）红；`../x`、`a/../../x` 仍被 `:50` 的边界匹配拒绝。
- M6 去掉 `:50` 的边界匹配 → 不可观察（有 `..` 与符号链接两条规则在前，属纵深防御）。
- M7 去掉 `:23` 的 NUL 判定 → 预期不可观察（`lstatSync` 对含 NUL 的路径抛错，落到 `:46` 仍被拒，只是原因不同；测试不钉原因）。
- M8 facade 把审计挪到抛出之后或去掉 → `:102` 用例的长度断言红。
- 不新增也不修改功能验收清单行：纯服务端，没有路由使用新 op，无用户可见变化。

## 5.1–5.3（#1054）

- 不触及 Critical Path：纯解析、无消费方、不放宽任何边界，`sandbox.resolve`、omp 子进程、审批档位都不动；一个评审席即可。服务端纯函数，无用户可见变化，no checklist rows；文档不动（十二键一览归 28.1 的 ADR-0014 运维一节，#1118）。
- 落点：新文件 `server/src/preview-config.ts`，沿 `model-catalog.ts` 的先例；导出 `interface PreviewSettings`（上表十二字段，两个可选）与 `resolvePreviewSettings(env: Record<string, string | undefined>, repoRoot: string): PreviewSettings`，无任何 fs / IO。`server/src/server.ts:57` 改为 `ServerConfig extends AgentSettings, PreviewSettings`，`resolveServerConfig` 末尾展开它，`:65` 注释改成「三十五项——四项自有，agent 十九项，预览与文件十二项」。`appAssemblyOf`、`sessionRuntimeOf`、`app.ts`、启动次序都不动。
- 复用：`server/src/agent-config.ts`（223 行）把 `resolvePositiveInteger` 与 `resolveOwnedPath` 改为导出，由 `preview-config.ts` 导入，不反向导入。knip 不报：两个函数有导入方，接口成员不计（S1g 2.1 先例）。`DEFAULT_*` 常量不导出，测试写规格字面量。
- 逐键实现：八个数值键用 `resolvePositiveInteger`；`PREVIEW_CACHE_DIR` 用 `resolveOwnedPath`；`PREVIEW_PORT` 另写一个 `0..65535` 的函数（正则 `/^[0-9]+$/u` 加前导零判定加范围）；`PREVIEW_ORIGIN` 用正则字面量 `/^https?:\/\/[^/?#\s]+$/u`（不用 `new RegExp`，不 trim，不加 `i`）；`OFFICE_BIN` 用 `isAbsolute(raw)`，不绑 repo root、不规范化。可选键缺席时对象上不出现该键（`exactOptionalPropertyTypes`，同 `ompUser`）。
- 错误文本逐字钉住（与输入无关）：数值键沿用 `<KEY> must be a canonical ASCII decimal` 与 `<KEY> must be within 1..2147483647`；`PREVIEW_PORT must be a canonical ASCII decimal` 与 `PREVIEW_PORT must be within 0..65535`；`PREVIEW_ORIGIN must be a scheme and authority only`（空串同文）；`PREVIEW_CACHE_DIR must not be empty`；`OFFICE_BIN must be an absolute path`（空串同文）。
- 漂移一：`server/test/server-config.test.ts` 已 771 行，不得加行。新建 `server/test/preview-config.test.ts`，放缺省、覆盖、非法值，以及「Pure source and compiled configuration identity」的十二键部分（`SOURCE_ENTRY` 与 `DIST_ENTRY` 两个 URL、`process.chdir(tmpdir())` 下，缺省与覆盖 `toEqual`）。
- 漂移二：5.2 点名的 `server-entry-silent.test.ts`（60 行）只有 import-without-main 一例，没有「非法配置路径」，不改它。编译入口用例照 #989 落在 `server/test/omp-max-processes-config.test.ts`（338 行）第四个 `describe`，复用其 `scratch`、`refused`、`FAILED_RECORD`、`NODE_SQLITE_WARNING`。
- 漂移三：不存在「按键数断言」的既有用例。`git grep` 二十三 / twenty-three 在代码里只中 `server/src/server.ts:65` 一条注释；`server-config.test.ts` 的 `toEqual(base)` 类断言在加键后保持绿。因此没有既有测试必须改，计数「三十五」不被任何机械检查钉住，issue 里 Width exception 的「同时变红」不成立，写进偏离记录。
- 解析层用例：(a) `{}` 下十二字段逐个 `toBe` 缺省，`Object.hasOwn` 对 `previewOrigin`、`officeBin` 为 false，显式 `undefined` 同缺省；(b) 十二键全给非缺省（`PREVIEW_ORIGIN=https://preview.example.test`、relative `PREVIEW_CACHE_DIR=cache/p` 得 `join(REPO_ROOT,"cache","p")`、`OFFICE_BIN=/opt/x/../soffice` 原样）后，与 base 不同的字段集合恰为这十二个；(c) 逐键单独覆盖时其余十一项仍为缺省；(d) 边界：`PREVIEW_PORT` 显式 `"0"`、`"1"`、`"65535"` 被接受，八个数值键的 `"1"` 与 `"2147483647"` 被接受，`PREVIEW_ORIGIN` 接受 `http://127.0.0.1:8080` 与 `https://[::1]:9443`。
- 非法值表按规格逐键逐值共 70 例（6 + 5 + 1 + 2 + 8×7），每例用 `expectKeyOnlyMessage` 式的整句相等加 `toContain(key)`；带哨兵的值另断言 message 不含它（空串跳过，先例在 `omp-max-processes-config.test.ts:127`）。规格之外补：`PREVIEW_PORT` 的 `" 1"`、`"+1"`、`"1e2"`、`"00"`；`PREVIEW_ORIGIN` 的 `https://`、`HTTPS://a.test`、`" https://a.test"`、`https://a.test?x`、`https://a.test#f`、`"https://a.test\n"`、`https://a b`；`OFFICE_BIN` 的 `./soffice`、`bin/soffice`。
- 编译入口用例：同一张 70 例表（就地 `flatMap` 生成，另一条 `toHaveLength(70)`），每例断言 `{code:1, signal:null}`、stdout 为空、stderr 去掉 sqlite 警告后整行等于 `{"event":"server_start_failed","reason":"config"}\n` 且不含键名、`db` / `state` / `sandbox` / `bin` 与 `compiled.root/var` 都不存在、端口拒连；非空取值另断言 stderr 不含该值。5.2 写「两三个样本」，但场景 THEN 写「每一例」，按场景与 #989 先例取全表，记入偏离记录。
- 规格没写的分支，取最简处理并记偏离：`PREVIEW_PORT` 等于 `PORT` 不在配置层拒绝（留给 13.1 的 `preview_listen` 失败）；`PREVIEW_ORIGIN` 只按正则，不做 `new URL` 解析；`PREVIEW_CACHE_DIR` 不查与 `SANDBOX_ROOT` / `OMP_STATE_DIR` 的包含关系；`OFFICE_BIN` 不查存在性、空白与 NUL；多键同时非法时点名哪一个不保证。
- 场景「预览与文件键的缺省与覆盖」里「预览监听器绑定端口」与 `server_started` 四键属 13.2（#1070），本刀只做「解析出的配置」半边，PR 描述写明。
- 守卫：`preview-config.ts` 约 90 行，`agent-config.ts` 只加两个 `export`，`omp-max-processes-config.test.ts` 约到 400 行，新测试文件约 250 行，都远离 800。jscpd 若把端口函数判为与 `server.ts` 的 `resolvePort` 重复，就在 `agent-config.ts` 抽一个带上下界的整数解析函数，由 `resolvePositiveInteger` 与端口共用，既有两句错误文本不变；不加 ignore。测试里不出现真实主机名、IP 或像密钥的串。
- 变异表（进 PR 描述；红在 `preview-config.test.ts` 的称「解析层」，红在 `omp-max-processes-config.test.ts` 的称「入口层」）：
- 任一缺省值改动 → 解析层 (a)。
- `PREVIEW_PORT` 拒绝 `0` → 解析层 (d) 的显式 `"0"`。5.3 写「缺省用例判红」不准：未设置时不经过范围判定。
- `PREVIEW_PORT` 上界改 65536，或接受 `01` → 解析层非法值 `65536` / `01`。
- 数值键下界改 0，或上界加 1 → 解析层 `0` / `2147483648`；上界减 1 → (d) 的 `2147483647`。
- `PREVIEW_ORIGIN` 接受带路径的值、去掉 `$`、加 `i` 或先 trim → 解析层对应非法值。
- `OFFICE_BIN` 改用 `resolveOwnedPath` → 解析层 `soffice` 用例；空串放行为未配置 → 解析层空值用例。
- `PREVIEW_CACHE_DIR` 空串放行 → 解析层空值用例。
- 任一 message 拼入输入值 → 整句相等断言。
- `resolveServerConfig` 漏掉展开 → 解析层 (a) 与入口层全表。
- 两键读串（如 TEXT 读成 IMAGE）→ 解析层 (c)。
- 入口吞掉配置错误继续启动 → 入口层 `code:1` 与端口拒连。
- 不可观察：`:65` 注释里的数字、展开次序。
- 十二个键 → 字段名与缺省（规则以规格「服务启动与装配」的十二键一段为准；前四个字段名由场景「预览与文件键的缺省与覆盖」给定，后八个由本注记定）：`PREVIEW_PORT` → `previewPort`（`0`；canonical 十进制 `0..65535`）；`PREVIEW_ORIGIN` → `previewOrigin?`（缺席；给出时整体匹配 `^https?://[^/?#\s]+$`，空串非法）；`PREVIEW_CACHE_DIR` → `previewCacheDir`（repo root 下 `var/preview-cache`；relative 相对 repo root，空串非法）；`OFFICE_BIN` → `officeBin?`（缺席即转换关闭；给出时须为绝对路径，空串非法，不查存在性）；`OFFICE_CONVERT_TIMEOUT_MS` → `officeConvertTimeoutMs`（`60000`）；`OFFICE_CONVERT_CONCURRENCY` → `officeConvertConcurrency`（`2`）；`PREVIEW_TEXT_MAX_BYTES` → `previewTextMaxBytes`（`1048576`）；`PREVIEW_IMAGE_MAX_BYTES` → `previewImageMaxBytes`（`20971520`）；`PREVIEW_DOCUMENT_MAX_BYTES` → `previewDocumentMaxBytes`（`104857600`）；`PREVIEW_NOTEBOOK_MAX_BYTES` → `previewNotebookMaxBytes`（`10485760`）；`PREVIEW_ARCHIVE_MAX_ENTRIES` → `previewArchiveMaxEntries`（`1000`）；`TRASH_RETENTION_DAYS` → `trashRetentionDays`（`30`）。后八个数值键与 `OMP_IDLE_MS` 同一解析纪律（`1..2147483647`）。
- 安全缺省由解析层用例钉住：`PREVIEW_ORIGIN`、`OFFICE_BIN` 缺省时对象上没有该键；`OFFICE_BIN` 的相对名（`soffice`、`./soffice`）被拒（这条路径之后会进 sudoers 行）；`PREVIEW_CACHE_DIR` 空串被拒（不得落成 repo root）；各上限与 `TRASH_RETENTION_DAYS` 的 `0` 被拒。

## 6.1、6.2 最小接线（#1055）

- 触及 Critical Path「沙箱与文件边界」（用户文件预览的内容类型与上限；`sandbox.resolve` 调用本身不动）：两个评审席位 + owner 白盒审查。前提只有 0.1（#1049）；不等 1.1 / 1.2 / 1.3，不等 4.1、5.1。
- 漂移一：`server/src/workspaces/preview.ts:31-35` 的第二参是 `ext` 而不是 issue 写的 `name`，`rest.ts:288` 传 `extname(absPath).slice(1)`。`workspace-preview.test.ts` 的 15 处调用（:102 :113 :129 :145 :174 :185 :189 :192 :194 :207 :225 :226 :236 :265 :326）全传裸扩展名，新语义下「无点 = 无扩展名」会全红，须逐处改成文件名（如 `"x." + ext.toUpperCase()`、`"big.log"`）并加第四参，逐条进偏离记录。
- 漂移二：该文件三处整对象 `toEqual`（:103-109、:114-120、:175-181）因返回值新增 `rangeable` 变红，各补 `rangeable: false`，不得降成 `toMatchObject`。`:11` 的 `IMAGE_LIMIT` 改 `20_971_520`，`:159` 标题改 20 MiB，`:171/:189` 的 11 MiB 改 21 MiB，并补一条「11 MiB 的 png 现在被允许」。`:97` 标题里的 exact 去掉（全表断言在新文件）。
- 行数：`preview.ts` 78、`rest.ts` 416、`workspace-preview.test.ts` 342、`workspaces-http.test.ts` 622。最后一个本刀后约 710，#1056 / #1058 的路由用例必须另开文件。
- 签名与导出：`classifyPreview(absPath: string, name: string, size: number, options: { limits: PreviewLimits; sniffedText?: boolean })`，`options` 与 `limits` 必填。导出 `DEFAULT_PREVIEW_LIMITS = { text: 1_048_576, image: 20_971_520, notebook: 10_485_760 }`、`sniffText(bytes: Uint8Array): boolean`，以及 `IMAGE_EXTENSIONS` / `AUDIO_EXTENSIONS` / `VIDEO_EXTENSIONS` / `NOTEBOOK_EXTENSIONS`（均为 `ReadonlySet<string>`，图片集合取自类型表的键）。
- 扩展名解析：`const i = name.lastIndexOf("."); ext = i <= 0 ? "" : name.slice(i + 1).toLowerCase()`，不用正则。`Dockerfile` / `Makefile` 精确且区分大小写。查表只用 `Set` / `Map`，不用对象字面量（`workspace-preview.test.ts:203` 的原型名用例保留，名字改成 `"file." + ext`）。
- 判定次序：文本表 / 两个文件名 → 图片 → 音频 → 视频 → `ipynb` → 「由别处提供」集合（`pdf docx xlsx pptx zip tar gz tgz`，模块内不导出，直接抛 `preview_unsupported`）→ `options.sniffedText === true` 才是 `text` → 否则抛。`g.tar.gz` 的扩展名是 `gz`。
- `sniffText` 最简实现：`bytes.includes(0)` 为假，且 `new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })` 不抛。`stream: true` 正好容忍末尾未完整的多字节序列；函数自身不截 8192（那是 #1056 路由的事）。GBK 用例用字节 `D6 D0 CE C4`，不要用恰好以合法前缀结尾的串。
- 路由接线（`rest.ts:288`）：`classifyPreview(absPath, basename(absPath), status.size, { limits: DEFAULT_PREVIEW_LIMITS })`。取 `basename(absPath)` 而不是查询串末段：`resolve` 会吞掉 `""` 与 `.` 分量（`page.html/.` 的 `absPath` 仍以 `page.html` 结尾），且逐分量拒绝符号链接，两者不会不一致。`:292` 的 `nosemgrep` 行保留在 `reply.send` 正上方，只改理由文字（现含音视频）。
- 规格没写的分支（进偏离记录）：本刀到 #1058 之间，`mp3 / wav / mp4 / webm` 经 `file` 路由返回 200 全量并带 `Accept-Ranges: bytes`，`Range` 被忽略。`clearPreviewHeadersOnError` 不加 `Accept-Ranges` 的清除，留给 #1058 的区间发送函数。本刀路由不传 `sniffedText`，`LICENSE` 与 `workspaces-http.test.ts:509-517` 的 `file.__proto__` / `file.constructor` 仍是 415。
- 新文件 `server/test/workspaces-preview-classify.test.ts` 只放新断言：全表（含 `A.YAML`、`x.env`、两个文件名）、`sniffedText` 三态（`dockerfile`、`notes.proto`、`LICENSE`、`.gitignore`）、图片七种与恰 20 MiB / +1 的 `gif`、`ipynb` 恰 10 MiB / +1、5 GiB `mp4`（只传数字，不建文件）、`wav`、`limits.image = 1024`、「由别处提供」九个名字带 `sniffedText: true`、`sniffText` 六个输入、`html` / `htm` / `svg` 跨截断点。另补 `.env` 不带嗅探 → `preview_unsupported`：场景里的 `.gitignore` 区分不出「点在开头视为无扩展名」，`.env` 才能。
- 「流关闭和错误」的 `openPreviewStream` 部分已由 `workspace-preview.test.ts:277-316` 五条钉死，原样保留，新文件不复制，在偏离记录里写明对应关系（`openRangeStream` 属 #1057）。边界值一律写字面量，不从 `DEFAULT_PREVIEW_LIMITS` 取，否则「用回 10 MiB」的变异测不出来。
- 门槛：jscpd 把 `server/test` 计入。`expectCanonicalError`、`expectedTextHeaders`、`collectBytes`、`spyMetadataIo` 从 `workspace-preview.test.ts` 搬进 `server/test/workspace-file-helpers.ts`（现 28 行），两个测试文件导入，搬家不改断言。knip 的 server 入口含 `test/**/*.test.ts`，新导出每个都要被新测试文件导入。`PreviewLimits` 类型照 `PreviewClassification` 的先例导出（master 上零导入方且门禁为绿）；若 knip 报，就在测试里 `import type` 一次。
- 路由层（`workspaces-http.test.ts`，在 :419 与 :470 两条里加行）：`logo.svg`、`page.htm`、`feed.xml` 为 `text/plain; charset=utf-8`，`anim.gif`、`pic.webp` 为 200 对应类型，`doc.pdf`、`deck.pptx` 为 415，目录 `out` 为 404，`huge.png` 改 21 MiB（:476）。另加一条 `file` 路由的逃逸用例，因为现有路由层只有 `tree` 的越界审计（`workspaces-http-failures.test.ts:169`）：属主请求 `../outside.html` 与指向空间外的符号链接 `link.svg` → 403 `sandbox_denied` 且各一行 `sandbox.reject`（`op` 为 `read`）；他人的 id 带 `../x.html` → 404 且审计行数不变。
- 不加验收清单行：`web/src/features/files/tree.tsx:69-98` 的 `supportsPreview` 仍只放行旧十二种，`web/src/lib/api.ts:425` 仍只认 png / jpeg。唯一可见变化是 10–20 MiB 的 png / jpg 由「文件过大」变成可预览，清单里没有钉 10 MiB 的行。不是配置切片：不碰 `docs/architecture/system.md` 第 9 节与配置计数测试。
- 变异：`svg` 的类型改成 `image/svg+xml` → 新文件「html / htm / svg 永不以文档类型返回」与路由 `logo.svg` 的 `content-type` 断言判红。
- 变异：图片上限用回 `10_485_760` → 新文件「恰 20 MiB 的 gif」与 `workspace-preview.test.ts` 改写后的恰 20 MiB png、「11 MiB 的 png 被允许」判红。路由层 21 MiB 的 `huge.png` 在此变异下仍是 413，不可观察。
- 变异：图片判定 `>` 写成 `>=` → 恰 20 MiB 用例判红。
- 变异：Notebook 超限改成截断或改用文本上限 → 「10 MiB+1 的 ipynb 抛 `preview_too_large`」与「恰 10 MiB 不截断」判红。
- 变异：去掉「由别处提供」集合的判定 → 「九个名字带 `sniffedText: true` 仍抛」判红。路由层 `doc.pdf` 不可观察（本刀路由不传 `sniffedText`）。
- 变异：`sniffedText` 缺省当成 `true` → 新文件「未提供时抛」与路由 `file.__proto__` / `file.constructor` 的 415 判红。
- 变异：去掉小写归一 → `A.YAML` 判红；`Dockerfile` 改成不区分大小写 → `dockerfile` 未嗅探用例判红。
- 变异：点在开头也算扩展名（`i < 0` 代替 `i <= 0`）→ 补的 `.env` 用例判红；场景原文的 `.gitignore` 不可观察。
- 变异：无视 `options.limits`，用模块常量 → `limits.image = 1024` 的 2 KiB png 判红。
- 变异：去掉 `mp4` 的 `rangeable` 或 `Accept-Ranges` → 5 GiB mp4 用例判红；给图片也加 `Accept-Ranges` → `workspace-preview.test.ts` 的整对象 `toEqual` 判红。
- 变异：`sniffText` 去掉 NUL 判定 → 「含一个 0x00」判红；去掉 `stream: true` → 「截在汉字第二字节」判红；恒返回 `true` → GBK 与 PNG 头判红。
- 变异：文本表漏掉 `xml` 或 `htm` → 路由 `feed.xml` / `page.htm` 判红。
- 变异：用对象字面量查表 → `workspace-preview.test.ts:203` 的原型名用例判红。
- 变异：逃逸，他人或不存在的 id：去掉 `file` 路由的 `ensureOwnedRoot` → `workspaces-http-failures.test.ts:57`（`file?path=keep.txt` 的相同 404、零审计）与新增的「他人 id 带越界路径」判红。
- 变异：逃逸，穿越：跳过 `sandbox.resolve` 或直接拼路径 → 新增的 `../outside.html` 403 + `sandbox.reject`（`op` 为 `read`）判红。
- 变异：逃逸，符号链接：把 `lstat` 换成 `stat` 且绕过 `resolve` → 新增的 `link.svg` 用例判红。只换 `lstatExisting` 而保留 `resolve` 时不可观察（`resolve` 已先拒），在表里标注。
- 变异：逃逸，`op`：把 `"read"` 换成 `"list"` → 新增用例里审计行 `op` 的断言判红。
  - 实施后更正一（规格文本）：场景「由别处提供与不支持」原把 `i.exe` 与八个「由别处提供」的名字并列为「即使带 `sniffedText: true` 也抛」，与条文表格 `text` 行（不在表内任何一行且 `sniffedText === true` 即 `text`）矛盾。以条文为准，场景改为：八个名字带 `sniffedText: true` 仍抛；`i.exe` 在 `sniffedText` 未提供或为 `false` 时抛。测试里第九个名字用 `I.PDF`（顺带钉住大小写归一）。此处改动待 owner 确认。
  - 实施后更正二（变异预测）：「去掉 `file` 路由的 `ensureOwnedRoot`」不会让「他人 id」用例判红——`core/sandbox/index.ts` 的 facade 自己先查 `rootOf`，为空即 `not_found` 且无审计，是双重保证；该变异只在 `workspaces-http-failures.test.ts` 的「owned missing root」用例判红。

## 7.1（#1057）

- 不触及 Critical Path：本刀不调 `sandbox.resolve`、不加 `op`、不加路由、没有生产调用方；`openRangeStream` 与既有 `openPreviewStream` 同约，只收已解析的 `absPath`（`server/src/workspaces/preview.ts:1-8` 文首注释写明 resolve 在模块外）。逃逸向量随 #1058（7.3）的路由接入评审，本刀一个评审席位即可。
- 前提：只有 0.1（#1049 / PR #1285）。7.1 在「组 2–7 不等 1.2」之列，不等 1.1 / 1.3，不等 5.1（边表写明 7.1 以参数收值）；6.1 只挡 7.3，不挡 7.1。
- 现状无漂移：`preview.ts` 78 行，导出只有 `PreviewClassification`、`classifyPreview`、`openPreviewStream`；全仓 `git grep 'parseRange\|openRangeStream\|range-parser'` 在 `server`、`web`、`openspec/specs` 零命中，不引入依赖。`rest.ts` 416 行，本刀不动。
- 签名：`export type RangeResult = { start: number; end: number } | "unsatisfiable" | "ignore"`；`export function parseRange(header: string | undefined, size: number): RangeResult`；`export function openRangeStream(absPath: string, start: number, end: number): Readable`，实现就是 `createReadStream(absPath, { start, end })`（两端含）。
- `parseRange` 用一条正则字面量 `/^bytes=(\d*)-(\d*)$/`，不用 `new RegExp`（semgrep）。判定次序固定：不匹配或两组皆空 → `ignore`；两组皆有且 `a > b` → `ignore`；`size === 0` → `unsatisfiable`；有 `a` 且 `a >= size` → `unsatisfiable`；后缀 `n === 0` → `unsatisfiable`；否则返回区间，`end = min(b, size-1)`。
- 规格没写、取最简并记入偏离记录的分支：`header` 为 `undefined` 或空串 → `ignore`；后缀 `n > size` → `{0, size-1}`；`Bytes=` 等非小写单位 → `ignore`（只认字面 `bytes=`）；前导零按十进制接受；既 `a > b` 又 `a >= size`（如 `bytes=1000-999`）→ `ignore`；语法不合的头在 `size = 0` 时仍是 `ignore`。
- `openRangeStream` 不加任何校验：`start > end` 时 Node 同步抛 `ERR_OUT_OF_RANGE`（已实测），调用方只传 `parseRange` 的结果；`size = 0` 不会走到这里。
- 测试放新文件 `server/test/workspace-preview-range.test.ts`（过 naming-guard），不追加进 `workspace-preview.test.ts`——那个文件 #1055 同批要改写（三参改四参、`IMAGE_LIMIT`）。
- 辅助函数：`workspace-preview.test.ts:75-94` 的 `collectBytes`、`waitForClose`、`waitForOpen` 原样搬进 `server/test/workspace-file-helpers.ts`（现 28 行）并导出，两个测试文件都从那里导入；原文件 `:4` 的 `Readable` 导入随之无引用，一并删掉。断言一条不动，记入偏离记录。若 #1055 先合且已搬过，直接复用。不复制函数（jscpd）。
- `parseRange` 用例：`it.each` 十行，`size = 1000`，逐字用规格的十个输入与期望（`bytes=0-99`→`{0,99}`、`900-`→`{900,999}`、`-100`→`{900,999}`、`990-2000`→`{990,999}`、`1000-`与`-0`→`unsatisfiable`、`5-2`、`0-1,5-6`、`items=0-1`、`bytes= 0-1`→`ignore`），用 `toEqual` 断言。上一条所列的自选分支各补一行。
- `openRangeStream` 用例四条，文件为 64 字节且每字节等于下标：(a) `(path, 10, 19)` 收到的字节恰为 `Buffer.from([10..19])`、长度 10；(b) 读完后等 `close`，`fstatSync(fd)` 抛 `EBADF`；(c) `open` 后立即 `destroy()`，等 `close`，同样 `EBADF`；(d) 不存在的路径以 `ENOENT` 拒绝且有 `close`。
- (b) 不可省：实测 `autoClose: false` 时读完后描述符仍开着，而 `destroy()` 照样关闭——任务点名的「读完前销毁」用例单独抓不住描述符泄漏。
- knip：`knip.json` 的 server 入口含 `test/**/*.test.ts`，`parseRange`、`openRangeStream` 以测试为唯一导入方即可；`RangeResult` 也要被测试文件 `import type` 引用（如给 `it.each` 的表标类型），否则报未引用导出。
- 其余门槛与文档：`preview.ts` 增约 35 行、新测试约 110 行，远离 800；不加配置键，`docs/architecture/system.md` 第 9 节与配置计数测试不动；纯服务端函数无用户可见变化，no checklist rows；文首注释补一句「范围解析与闭区间流同在本模块」。
- 与 #1055 的合并次序：两刀都改 `preview.ts`。本刀把新函数加在 `openPreviewStream` 之后、`classified` 之前，不动 13–52 行；后合的一方 rebase，不在本刀预先适配 `rangeable`。
- 变异：`bytes=-100` 当成 `0-100`（7.5 分摊条款）→ `parseRange` 的 `bytes=-100` 行判红（得到 `{0,100}`，期望 `{900,999}`）。
- 变异：去掉 `end` 的截断 → `bytes=990-2000` 行判红（`{990,2000}`）。
- 变异：`bytes=<a>-` 的 `end` 取 `size` 而非 `size-1` → `bytes=900-` 行判红。
- 变异：去掉 `a >= size` 判定 → `bytes=1000-` 行判红。
- 变异：去掉 `n === 0` 判定 → `bytes=-0` 行判红。
- 变异：去掉 `a > b` 判定，或把它改回 `unsatisfiable` → `bytes=5-2` 行判红。
- 变异：多段时取第一段（正则去掉 `$` 锚）→ `bytes=0-1,5-6` 行判红。
- 变异：不校验单位（`[a-z]+=`）→ `items=0-1` 行判红。
- 变异：解析前 `trim` 或允许 `\s*` → `bytes= 0-1` 行判红。
- 变异：判定次序写反（先判 `size === 0` 或 `a >= size`，再判语法与 `a > b`）→ 自选分支的 `bytes=1000-999` 行与 `size = 0` 的非法头行判红；规格的十行抓不住，所以这两行必须写。
- 变异：后缀 `n > size` 不夹到 0 → 自选分支的 `bytes=-1500` 行判红（`start` 为负）。
- 变异：`openRangeStream` 的 `end` 当开区间（`end - 1`）→ 用例 (a) 判红（9 字节）；`start` 写成 0 → (a) 判红（字节值不是 10..19）。
- 变异：`createReadStream` 加 `autoClose: false` → 用例 (b) 判红（`close` 不来，超时）；用例 (c) 仍绿，已实测。
- 变异：「销毁时不释放描述符」预期不可观测：薄封装下释放由 Node 的 `ReadStream._destroy` 完成，没有可以去掉的实现行；用例 (c) 只在有人把它换成自管 `fs.open` 的实现时才会红。PR 表里照此标注。
- 变异：把 open 错误吞成空流（如捕获后返回 `Readable.from([])`）→ 用例 (d) 判红。

## 8.1 的 sweep 半边，含分摊的 8.3 / 8.4 条款（#1059）

- **Critical Path：沙箱与文件边界**（回收目录、递归删除、符号链接）——双评审席位并请 owner 白盒审查；仅服务端、无调用方，**不加验收清单行**，不碰配置键与 `docs/architecture/system.md` 第 9 节的表。
- 前提与实测：唯一前提 0.1（#1049）；**不依赖 #1053**（4.1 只通向 8.2、9.1）与 #1054（`retentionDays` 以参数收值）。本刀是 8.1 不执行 `rename` 的半边，**不在 1.2 所挡集合内**；1.2 已记录为「与设计相符」（`design.md` D22「实测」），`moveToTrash` 半边（#1060）也已放行，它另等 4.1。1.3 与本刀无关。
- **任务前提与现码不符**：8.1 说以「`store` 的 owner 段校验」为证，但 `server/src/workspaces/store.ts:287-298` 的 `rejectUnsafeOwnerSegment` 只拒空串、`.`、`..`、NUL、`/`、`\`；`core/sandbox/resolve.ts:36-48` 也不拒点开头分量；`010_auth_schema_seed.sql:12` 只 CHECK `length(id) > 0`。今天 id 为 `.trash` 的账号能把 `<SANDBOX_ROOT>/.trash` 建成 `2770` 的账号根。处置：给 `rejectUnsafeOwnerSegment` 加一行 `ownerId.startsWith(".")`（主规格 workspaces 的「without accepting unsafe owner path segments」已涵盖，不改规格），**PR Boundary 需放宽到 `store.ts`（487 行）**，记入偏离记录；编排者若不放宽，则测试只钉种子账号，store 缺口另开 issue。
- 「账号 id 不以点开头」写在新文件里（`workspace-store.test.ts` 已 798 行，**不得加行**），两条：① `withOpenDb(":memory:")` 迁移后 `accounts` 恰四行且 `id LIKE '.%'` 为 0 行；② 照 `workspace-store.test.ts:613` 的 `insertUnsafeOwnerAccount` 插入 id=`.trash` 的账号，`store.create({id:".trash"},{name:"alpha"})`、`store.list(".trash")` 都以非 `HttpError` 抛出，`<sandboxRoot>/.trash` 不存在，`workspaces` 与审计各 0 行。
- 形状：`server/src/workspaces/trash.ts` 只导出 `createTrash(options: { sandboxRoot: string; retentionDays: number }): { sweep(now: number): Promise<void> }`。**不声明 `rename?`**（本半边无读者，#1060 加可选字段不破坏调用方，记偏离）；不导出返回类型接口（knip 报未用类型；#1070 用 `ReturnType<typeof createTrash>`）。构造函数不碰文件系统。knip 的 server entry 含 `test/**/*.test.ts`，测试是唯一导入方即可过。
- 「目录校验」在本半边 = `sweep` 开头对 `join(sandboxRoot, ".trash")` 的一次 `lstat`：不存在、非目录（含符号链接）、`uid !== process.geteuid?.()` 时本轮直接返回。**不调 `ensureOwnedDir`**（`core/sandbox/dirs.ts:41`，它会 `mkdir` 并 `chmod`，与「不存在时不创建」冲突；规格括注只列三项、不含 mode），留给 #1060。本刀不 import `core/sandbox`。
- 遍历用 `fs/promises`（异步，不堵事件循环）：三层 `readdir(…, { withFileTypes: true })`，owner 层、workspace 层、批次层都只认 `dirent.isDirectory()`（Dirent 不跟随符号链接）。批次名用正则**字面量** `/^(\d+)-[0-9a-f]{16}$/`（semgrep），`Number(m[1]) < now - retentionDays * 86_400_000` 才 `rm(batch, { recursive: true })`，不带 `force`；`rm` 不跟随批次内部的链接。
- 规格未写明的分支，取最简并记偏离：时间戳恰等于界限 → 保留；批次名合规但是普通文件或符号链接 → 不碰；清空后的 `<ownerId>`、`<workspaceId>` 空目录 → 不删（免与 #1060 建批次竞态）；`.trash` 的 mode 不是 `0700` → 照常清理、不校正；超长数字时间戳 → 视为未到期。
- 出错不外溢：每个批次的 `rm` 单独 `try/catch`，每层 `readdir` 也 `catch` 后继续下一个兄弟，`sweep` 永不 reject；不写审计、不打日志。
- 夹具（`server/test/workspaces-trash-sweep.test.ts`，复用 `core-db-helpers.ts` 的 `tempDir` / `removeTempDirs` / `withOpenDb`）：`sandboxRoot = realpathSync(tempDir())`，四级目录 `mkdirSync(…, 0o700)` 直接建出，批次名 `${ts}-${"0123456789abcdef"}`。8.3 的「修改时间由夹具设定」易误导——清理只看批次名，夹具用 `utimesSync` 把 mtime **设反**（到期批次设为现在，未到期设为 40 天前）以钉住这一点。
- 用例（一）：「到期的批次被清除」——31 天前被删；29 天前（含内容）、`keep-me`、指向空间外目录的符号链接都在，链接目标内容逐字节不变；另加批次名合规且已到期的符号链接、owner 层与 workspace 层的符号链接，目标内都放到期批次形状的目录，断言全部未动。「`.trash` 被占位」——符号链接指向含到期批次形状的目录树、普通文件各一例，什么都不删。
- 用例（二）：「临时空间删除后批次保留到期满」——夹具等价：不建 DB、不建 `tmp-<T>`，只有 `.trash/u1/<T>/<批次>`；`sweep(删除时刻 + 29 天)` 不动，`sweep(+31 天)` 删除。「不查 `workspaces` 表」由签名保证（无 `db` 参数）；场景里「经路由删除」「`tree`/`file` 404」归 #1060。「保留期可配置」——`retentionDays: 1` 删 2 天前的批次，同一夹具 `retentionDays: 30` 不删；`TRASH_RETENTION_DAYS` 与启动首扫归 #1054 / #1070。
- 用例（三）：「清理出错不外溢」——到期批次 A 内有 `chmodSync(…, 0o500)` 的子目录含一文件，另有可删的到期批次 B：`await expect(sweep(now)).resolves.toBeUndefined()`，B 被删、A 仍在；`it.skipIf(process.geteuid?.() === 0)`（范式见 `sandbox-dirs.test.ts:336`），`afterEach` 先 `chmod 0o700` 再 `removeTempDirs()`。`.trash` 不存在一例不跳过：不抛，事后 `existsSync(".trash") === false`。
- 守卫与存量：两个新文件远低于 800 行；`workspaces/` 下无模块清单类断言。放宽 `store.ts` 后既有测试无一变红（全库没有点开头的 owner id 用例，`workspace-store.test.ts:554` 用 `bad/id`）；`<state>/trash` 相关断言（`omp-state-layout.test.ts:125,147,185`、`server-startup-layout.test.ts:134`）不动——那是另一套「移入即删」的目录（`state-layout.ts:46`、`temp-dir-remove.ts:77-105`），不要复用 `removeDirThroughTrash`。覆盖率门槛是全局 80%，上述用例已覆盖各 `catch` 分支。
- 变异：清理跟随符号链接（`isDirectory()` 换成 `stat` 后判断，或对批次层链接也 `rm`）→「到期的批次被清除」里「链接目标内容不变」判红（8.4 点名的那条）。
- 变异：去掉 `.trash` 的 `lstat` 校验 →「`.trash` 被占位」符号链接一例里目标目录下的到期批次被删而判红。
- 变异：owner 层或 workspace 层不过滤符号链接 → 对应两条「链接目标内未动」断言判红。
- 变异：正则放宽（去掉 `^…$` 或 `{16}`）→ 需在夹具加一个 `<31 天前毫秒>-zz` 之类近似名才判红；只有 `keep-me` 时**不可观察**，所以夹具必须带近似名。
- 变异：比较写反或用 `<=` → 29 天前批次被删判红；`<=` 另需一条「恰等于界限保留」用例，否则不可观察。
- 变异：用 mtime 代替批次名里的时间戳 → mtime 设反的夹具下 31 天前批次未删、29 天前被删，判红。
- 变异：保留期写死 30 →「保留期可配置」`retentionDays: 1` 一例判红。
- 变异：去掉单批次的 `try/catch` →「清理出错不外溢」里 `resolves` 判红，或批次 B 未删判红（root 下跳过，不可观察）。
- 变异：`.trash` 不存在时 `mkdir`（或改调 `ensureOwnedDir`）→「没有被创建」判红。
- 变异：去掉 `rejectUnsafeOwnerSegment` 的点开头分支 →「账号 id 不以点开头」第 ② 条判红（`<sandboxRoot>/.trash` 被建出）。
- 变异：种子里加一个点开头 id → 第 ① 条判红。
- 变异：「清理去查 `workspaces` 表」→ **不可观察**（结构上排除：`createTrash` 不收 `db`）；评审以签名为证。

## 9.3、9.4（#1061）

- **Critical Path：沙箱与文件边界**（无上限读出用户文件、审计次序）——两个评审席位 + owner 白盒；前置只有 0.1，不等任何实测与兄弟刀。
- 漂移：`server/src/workspaces/rest-entries.ts` 在 origin/master 不存在，由本刀新建；`index.ts`（9 行）只调 `registerWorkspaceRest`，本刀加一行 `registerWorkspaceEntries(app, dependencies)`，签名 `(app: FastifyInstance, dependencies: WorkspaceRestDependencies): void`。
- 复用而不复制（jscpd）：给 `rest.ts`（416 行）的 `currentPrincipal`、`ensureOwnedRoot`、`parsePathQuery`、`lstatExisting`、`noStoreWorkspaceResponse` 加 `export`，`rest-entries.ts` 单向导入；knip 由该导入满足；不改 `core/sandbox`、`http/errors.ts`（GET 无 body，不进归属集）、`preview.ts`。
- 处理次序：`onRequest: noStoreWorkspaceResponse` → `currentPrincipal` → `ensureOwnedRoot` → `parsePathQuery(query, true)` → `sandbox.resolve(principal, id, path, "read")` → `lstatExisting` 非 `isFile()` 则 404 → `audit.emit({kind:"file.download", actorId, workspaceId, title:` `下载 ${path}` `, detail:{path, size}})` → 之后才设头 → `reply.send(openPreviewStream(absPath, status.size))`。
- 头：`Content-Type: application/octet-stream`、`Content-Disposition`、`Content-Length: String(status.size)`（必须显式设）、`X-Content-Type-Options: nosniff`；流按 `size` 截界，文件在 lstat 后增长也不会多发字节，0 字节文件由 `openPreviewStream` 的空流分支处理。
- 纯函数 `export function attachmentDisposition(name: string): string`（放 `rest-entries.ts`，测试是 knip 入口）：入参 `basename(absPath)`，不取请求串末段（`a/b.md/` 的末段是空串）。
- ASCII 回退名按码点替换：`0x20–0x7E` 之外及 `"`、`\` 各换一个 `_`，一个代理对只换一个 `_`；`季度 报告"v2".pdf` → `__ ___v2_.pdf`。
- `filename*` 按 `Buffer.from(name, "utf8")` 逐字节编码：RFC 5987 attr-char（字母数字与 ``!#$&+-.^_`|~``）原样，其余 `%XX` 大写。不用 `encodeURIComponent`：它放过 `'()*`，遇孤立代理项抛 `URIError`。不写动态 `new RegExp`（semgrep）。
- 规格未写的分支（记入偏离记录）：(a) 路由设 `exposeHeadRoute: false`，否则 Fastify 自动的 HEAD 会跑同一 handler、写一条没发字节的 `file.download`；HEAD 落到 `/api/*` 兜底 → 404、无审计。(b) 审计后、发头前打开失败（文件消失，或 omp 用户建的不可读文件）→ 500 信封，审计行保留。(c) 符号链接 → 403 + `sandbox.reject`。(d) `path=` 空串 → 解析到根 → 404。
- 分支 (b) 需要路由级 `onError` 钩子移除 `Content-Type`、`Content-Disposition`、`Content-Length`，否则 500 的 JSON 会带着 `octet-stream` 与 attachment 头发出；`rest.ts:51` 的 `clearPreviewHeadersOnError` 是同一理由。
- 新文件 `server/test/workspaces-download.test.ts`（用 `withWorkspacesApp`、`insertWorkspace`、`loginSessionId`、`bearerCookie`）：「任意文件作为附件」五个文件加一个 0 字节文件，`rawPayload.equals`，审计五行的 `detail.path` / `detail.size`；`big.bin` 30 MiB 运行时在临时目录生成，不入库。
- 「拒绝项」六例各断言没有 `file.download` 行，另加：重复 `path` → 400；`lisi` 带 `../x` 请求 zhangsan 的 id 与不存在的 id → 相同 404 且审计零行；符号链接指向空间外文件 → 403，`detail.op="read"`；HEAD → 404 无审计。
- 「审计失败不发文件」沿用 `workspaces-http-failures.test.ts:267` 的 `db.setAuthorizer` 拒绝 `audit_events` INSERT：断言 500 `INTERNAL_ERROR_ENVELOPE`、`no-store`、无 `content-disposition`、`content-type` 为 JSON、正文不含文件内容，且 `spyBodyIo()` 的 `createReadStream` 对该文件零调用。最后一条让「审计挪到发送之后」确定判红，不依赖 Fastify 的发头时机（未读 Fastify 源码核实）。
- 其余用例：「不支持范围」（100 字节，200，无 `content-range`、无 `accept-ranges`）；html / svg / pdf / xml 四例都是 `application/octet-stream` + attachment；纯函数表驱动（中文、空格、`"`、`\`、`\n` 与 `\x7f`、emoji、`'()*`）；打开失败用 `workspaces-http.test.ts:577` 的 `onSend` 里 `unlinkSync` 手法；文件名含 `\n` 的真实文件下载 → 200。
- 既有测试无须改：`workspaces-http-failures.test.ts:231` 的 "all five routes" 是显式 URL 列表，`server-assembly.test.ts:560` 只包 `registerWorkspaces`。不要往 `workspaces-http.test.ts`「完整真实装配与隔离」加 `download` 行（那是 11.4）。无 checklist 行（纯服务端；CH-33 归 25.6）；不动 `docs/architecture/system.md` §9；`smoke/files.hurl` 归 26.2。`reply.send(stream)` 若被 semgrep 标记，仿 `rest.ts:298` 加 `nosemgrep`。
- 变异：`audit.emit` 挪到 `reply.send(stream)` 之后 → 「审计失败不发文件」判红。状态码与正文断言是否判红取决于发头时机；`createReadStream` 零调用断言保证判红。
- 变异：`Content-Type` 改用真实类型（按扩展名）→ 「主站不把工作空间文件当文档返回·download 半边」的 html / svg / pdf / xml 断言判红，「任意文件作为附件」的 `page.html` 也红。
- 变异：去掉 `ensureOwnedRoot`，或挪到 `resolve` 之后 → 「lisi + `../x` → 404 且审计零行」判红（变成 403 加一条 `sandbox.reject`）。
- 变异：`resolve` 的 `op` 换成跳过沙箱的直接 `join(root, path)` → 「`../x` → 403 + `sandbox.reject`」与符号链接用例判红。
- 变异：去掉 `isFile()` 判断 → 「拒绝项」的 `out` 目录用例判红（变成 500 或 `EISDIR`）。
- 变异：`parsePathQuery(query, false)` → 缺 `path` 的 400 判红（变成 404）。
- 变异：下载改走 `classifyPreview` 的上限 → 30 MiB `big.bin` 与 `archive.zip` 判红（413 / 415）。
- 变异：去掉 `Content-Length`，或取截断值 → 「精确的 `Content-Length`」判红。
- 变异：ASCII 回退名不替换 `"` 或 `\` → 纯函数用例判红；不替换控制字符 → `\n` 文件名的真实下载判红（`setHeader` 抛 `ERR_INVALID_CHAR` → 500）。
- 变异：`filename*` 改用 `encodeURIComponent` → `'()*` 用例判红。
- 变异：支持 `Range`（返回 206）→ 「不支持范围」判红。
- 变异：去掉 `exposeHeadRoute: false` → HEAD 用例判红（多出一条 `file.download`）。
- 变异：去掉 `onError` 清头 → 「打开失败」用例的 `content-type` 为 JSON、无 `content-disposition` 断言判红。
- 变异：预期不可观察：把流的 `end` 截界去掉（改成无界 `createReadStream`）。测试里文件不会在 lstat 后增长，属防御性实现，PR 表中标注「不可观察」。
  - 实施后更正：上面「流不按 `size` 截界 → 预期不可观察」已不成立——交付的测试加了「审计后文件增长」用例，该变异判红。规格点名的外账号 `lisi` 是种子里唯一的管理员（`u3`），评审后测试的两处外账号改为 `lisi`（另保留普通成员一行）；「去掉 `ensureOwnedRoot`」由「属于自己但根目录缺失的 id」夹具判红（他人 id 的 404 是 facade 的双重保证）。`rest.ts` 在本刀之前是 418 行。lstat → 打开窗口的完整陈述（中间目录分量、FIFO）见 #1286。

## 11.1（#1066）

- Critical Path：代码本身不碰 `sandbox.resolve`、`op`、路径或文件系统（规格明文禁止），不落在 `AGENTS.md` 两条白盒路径内；但它是预览监听器读用户文件的唯一凭据，issue 已要求 PR 标注白盒审查，建议按两个评审席位处理。
- 依赖：边表 11.1 只 ← 0.1（#1049 / PR #1285，按已合计）；不在 1.2 挡住的集合里，不等 1.1、1.3，与 #1052 的裁决无关；代码上只导入 `node:crypto`，同批兄弟切片都不是前提。
- 下游：等本刀的是 #1067（11.2–11.3）、#1069（12.1 收 `tokens`）及经它们的 13.1；#1068（12.2）不等它，它若也在 `server/src/preview/` 下建文件，谁先合都不冲突。
- 命名与唯一实现：`server/src/sessions/tokens.ts:9` 已有 `TokenRegistry`（39 行；单键、轮换、`revoke`、无到期）；新文件导出 `createPreviewTokens()`（或类 `PreviewTokenRegistry`），不得再叫 `TokenRegistry`，不拷贝其函数体（jscpd 含测试文件）。
- 偏离记录写明不扩展旧表的理由：复合键、到期与续期、无吊销；D13 写的是「同一做法」，文件位置由规格钉在 `server/src/preview/`。
- 签名照规格逐字：`issue({ownerId, workspaceId, embedOrigin}, now) → {token, expiresAt}`、`lookup(token, now) → {ownerId, workspaceId, embedOrigin} | null`；`now` 是两个调用上必填的毫秒 `number`，不设 `Date.now` 缺省、不在构造时收时钟；`embedOrigin: string | null`；`lookup` 恰返回三键，不带 `expiresAt` 与 `token`。
- 复合键不得用分隔符拼接（`ownerId`、`workspaceId` 都是 `string`，`server/src/auth/index.ts:32`）：用嵌套 `Map<ownerId, Map<workspaceId, token>>` 加 `Map<token, 记录>`，不用普通对象当表；清除一条记录时两张表同时删。
- 到期判定在 `issue` 与 `lookup` 用同一个谓词 `now >= expiresAt`（规格只在 `lookup` 一句写了边界，`issue` 恰在 `t + 900000` 时按已过期生成新令牌并删掉旧令牌的记录）；续期一律赋值为 `now + 900000`，时钟回拨时到期时间随之前移，不做单调保护。
- 规格未写的随机数撞车：沿用 `sessions/tokens.ts:15-17` 的失败关闭——新令牌已在表里则抛不含令牌的 `Error`，既有记录不动；否则静默覆盖会把别人的令牌改指到本次的账号与空间。
- 规格未写的残留：不做全表清扫；工作空间删除后既不再签发也不再查找的过期记录留到进程重启（每条常数字节），记入偏离记录。
- 测试 `server/test/preview-tokens.test.ts`（新）：三个场景各一个 `describe`，真实 `randomBytes`；到期一律写字面量 `900000` / `899999`，不从源文件导入 TTL 常量（常量不导出）；正则用字面量 `/^[0-9a-f]{64}$/u`。
- 场景之外必须补的断言：再次签发后 `lookup` 的 `embedOrigin` 是本次的值（含改成 `null`）；不经任何 `lookup` 直接在 `t + 900000` 再签发得到新令牌（规格场景二先 `lookup` 清除了记录，会掩盖 `issue` 自己的到期判断）；`("a:b","c")` 与 `("a","b:c")` 得到不同令牌；`lookup("constructor")`、`lookup("__proto__")` 为 `null`；两个实例互不可见。
- 撞车用例按 `server/test/session-tokens.test.ts:80-88` 的写法（`vi.spyOn(nodeCrypto, "randomBytes")` 加 `syncBuiltinESMExports`，`afterEach` 还原），所以源文件必须用具名导入 `import { randomBytes } from "node:crypto"`；测试里不出现 64 位十六进制字面量（gitleaks），未知令牌由活令牌派生（`toUpperCase()`、`slice(0, 63)`），大写用例先断言令牌含 `[a-f]`。
- 门槛与范围：knip 的 server 入口含 `test/**/*.test.ts`（`knip.json:9`），测试作唯一导入方合法，但未被测试导入的导出类型也会报，只导出测试实际导入的名字；既有测试无一需要改（没有测试枚举 `server/src` 目录或读 `docs/architecture/system.md`，`http-parser-owners.test.ts` 的条数属 #1067）；不是配置切片，不动 `system.md` 第 9 节；服务端纯模块，no checklist rows；只勾 11.1，11.3、11.5 的任务号留给 #1067、#1075。
- 变异：`lookup` 顺手把 `expiresAt` 推后 → 「到期与查找不续期」里 `t + 899999` 查过之后 `t + 900000` 不再是 `null`，判红（`lookup` 不返回 `expiresAt`，这是唯一的观察方式）。
- 变异：到期判定 `>=` 写成 `>` → 同一用例 `t + 900000` 的 `lookup` 非 `null`，判红。
- 变异：`lookup` 到期时不清除记录而只返回 `null` → 「到期后再签发得到新令牌、旧令牌仍为 `null`」判红。
- 变异：`issue` 不判到期、直接复用键上的旧记录 → 补充用例「不经 `lookup` 在 `t + 900000` 再签发」判红；规格场景二原样写法下此变异不可观察。
- 变异：未过期再签发时生成新令牌 → 「签发、复用与续期」的同一令牌断言判红。
- 变异：再签发不推后到期时间（保持 `t + 900000`）→ 同场景 `expiresAt = t + 5 分钟 + 900000` 判红。
- 变异：再签发不更新 `embedOrigin` → 补充的 `embedOrigin` 断言判红。
- 变异：键只用 `ownerId` → `(u1, w2)` 与 `(u1, w1)` 同令牌，判红；键只用 `workspaceId` → `(u2, w1)` 同令牌，判红（跨账号、跨空间的隔离向量）。
- 变异：键改成 `ownerId + ":" + workspaceId` 拼接 → 分隔符碰撞用例判红。
- 变异：令牌改成 16 字节或大写十六进制 → `/^[0-9a-f]{64}$/u` 判红。
- 变异：`lookup` 改成不区分大小写或前缀匹配 → 「未知令牌」判红。
- 变异：存储换成普通对象 → `lookup("constructor")` 非 `null`，判红。
- 变异：去掉撞车检查 → 撞车用例里另一键的令牌被改指，判红。
- 变异：登记表改成模块级单例 → 「两个实例互不可见」判红。
- 变异：不可观察：「不写日志、不进审计」——纯模块没有日志与审计依赖，无从断言；证据在 #1067 的响应头与日志断言。
- 变异：不可观察：遍历、符号链接、「他人空间 404 先于路径检查」「越界写 `sandbox.reject`」——登记表不接触路径，这些向量属 #1067、#1069 与 11.4。

## 12.2（#1068）

- Critical Path：本刀不调 `sandbox.resolve`、不碰 fs、不加 `op`，但这组头是「预览用户文件」的全部来源隔离性质，issue 也要求白盒，按 Critical Path 处理（两席评审加 owner 白盒）。穿越、符号链接、跨空间 id 这些向量在本刀没有对象，归 #1069；本刀的逃逸向量在头层，见变异清单。
- 依赖：边表上 12.2 只 ← 0.1（#1049 / PR #1285）；按代码零 import，前提已齐。不等 1.1 / 1.2 / 1.3，也不等 #1052 的裁决。同批里不依赖任何一刀，可第一个合；下游是 #1069（12.1）与 15.1。
- 与同批的交集：只有 #1066 也建 `server/src/preview/` 目录（它建 `tokens.ts`），两刀文件不同。本刀不建 `index.ts` 桶文件，不 import `tokens.ts` 的类型，`embedOrigin` 就地写成 `string | null`。
- 漂移一：issue 的 Current behavior 属实，`origin/master` 的 `server/src` 里没有 CSP、`frame-ancestors`、`Referrer-Policy`，`nosniff` 只在 `server/src/workspaces/preview.ts:70`。但规格说的「与 workspaces 分类器相同」在代码里不成立：`preview.ts:17-21` 只有 png/jpg/jpeg，其余要等 6.1（#1055）。
- 类型值的处置：按 D 的 workspaces delta（`specs/workspaces/spec.md:9-11`）写死字面量：`image/gif`、`image/webp`、`image/bmp`、`image/x-icon`、`audio/mpeg`、`audio/wav`、`video/mp4`、`video/webm`。不 import `workspaces/preview.ts`（`docs/architecture/system.md:79` 不许 feature 间未声明的依赖），测试里也不调 `classifyPreview`（#1055 会把它改成四参，谁后合谁红）。
- 漂移二：issue 正文与 D14 标题写 `Access-Control-Allow-Origin: *`「一律」，且都没提 `Cross-Origin-Resource-Policy: cross-origin`。规格条文是：ACAO、CORP、CSP 只在成功响应，失败响应只有三项公共头加 `text/plain`。以规格为准，记入偏离记录；issue 验收第三条的「一律带 ACAO」按「成功响应一律」读。
- 新文件 `server/src/preview/headers.ts`（实际 106 行，无 import），两个导出：`previewHeaders(name: string, embedOrigin: string | null): Record<string, string>` 与 `previewFailureHeaders(): Record<string, string>`。类型表与常量不导出；knip 的 server entry 含 `test/**/*.test.ts`，测试是唯一引用方即可过。
- 成功响应恰七键，键名大小写沿用 `preview.ts:68-72`：`Content-Type`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`、`Content-Security-Policy`。失败响应恰四键：`Content-Type: text/plain; charset=utf-8` 加前三项公共头，416 也用它。状态码与 `预览不存在或已过期` 文案归 #1069，本刀不放。
- 类型表用 `Map`，共 29 个扩展名：html htm css js mjs json map svg png jpg jpeg gif webp bmp ico woff woff2 ttf otf pdf mp3 wav mp4 webm txt md csv tsv xml。取法是 `lastIndexOf(".")`，为 `-1` 时直接 `application/octet-stream`，否则取其后小写。不能用对象字面量，否则 `a.constructor`、`a.__proto__` 会命中原型；也不能直接 `slice(lastIndexOf+1)`，否则无扩展名的文件 `html` 会得到 `text/html`。
- 未写明分支一：`name` 可以是带 `/` 的相对路径，含 `/` 的「扩展名」不在表里，自然落到 octet-stream（`site.v2/README`）。`a.`、`.gitignore`、`a.tar.gz` 都是 octet-stream；`.html` 按字面规则是 `text/html`，带 sandbox。`xml` 是 `text/plain`，不是 XML 类型。
- 未写明分支二：CSP 是否带 `sandbox` 只看算出的 `Content-Type === "application/pdf"`，不看原始文件名，所以 `X.PDF` 也走例外，`a.svg` 必带 sandbox。15.1 的 `/o/` 成功响应以一个 `.pdf` 名调用同一函数，本刀不为它加第三个参数。1.1 实测留给 owner 的「PDF 例外是否保留」不挡本刀，照规格实现。
- 未写明分支三（偏离记录，请白盒评审确认）：`embedOrigin` 来自签发请求的 `Origin` 头，账号本人用非浏览器客户端可发 `*`、`null`、`http://a; x`。汇点处 fail-closed：仅当 `URL.canParse(e) && new URL(e).origin === e` 时原样写入，否则与 `null` 一样取 `'none'`。实施时追加第三个条件（`headers.ts:50`、`:70`）：含 `*`、`;`、`,`、`'` 任一字符即取 `'none'`——`http://*`、`http://*.a.test`、`http://a;b`、`http://a,b`、`http://a'b` 都能通过前两个条件原样往返，前两者是 CSP 通配，后三者是指令或策略分隔符。不写正则，避开 semgrep 的 `detect-non-literal-regexp`。
- 新文件 `server/test/preview-headers.test.ts`（实际 284 行，先写红；另有「能当来源解析但含 CSP 语法字符」一组六例，先自证输入能原样往返），用例：HTML 七键整对象 `toEqual` 且 CSP 逐字相等；PDF 的 CSP 恰为 `frame-ancestors http://127.0.0.1:3000`，`null` 时恰为 `frame-ancestors 'none'`；29 行 `it.each` 全表字面量；表外一组全为 octet-stream（`README`、`data.bin`、`html`、`pdf`、`a.`、`a.xhtml`、`a.ts`、`a.docx`、`a.zip`、`a.constructor`、`a.__proto__`、`site.v2/README`）；大小写 `A.HTML`、`X.PDF`；失败四键整对象相等且三项公共头与成功响应逐值相同；非法 `embedOrigin` 一组（`*`、`null`、`http://a.test/`、`http://a.test; sandbox allow-same-origin`、`javascript:alert(1)`）取 `'none'`，合法的 `http://[::1]:3000`、`https://preview.example.test` 原样。
- 门槛与清单：既有测试无一需要改（纯新增两文件，`server/test/workspace-preview.test.ts` 不动）；800 行、jscpd、naming-guard、gitleaks 都不触发，覆盖率要求两个分支都被上面的用例走到。不是配置刀，不动 `system.md` 第 9 节的表与配置条数断言。未接线、无用户可见变化，no checklist rows。`tasks.md` 只勾 12.2，12.3 / 12.4 留给 #1069。
- 变异：非 PDF 的 CSP 加上 `allow-same-origin` → 「HTML 响应是不透明来源」的 CSP 逐字相等断言判红（issue 指定的那条）。
- 变异：CSP 加 `allow-popups`、`allow-top-navigation` 或 `default-src 'self'` → 同一条逐字相等断言判红。
- 变异：PDF 也带 `sandbox` → 「PDF 响应不带 sandbox」的恰等断言判红。
- 变异：PDF 例外改按原始文件名 `endsWith(".pdf")` 判 → `X.PDF` 用例判红。
- 变异：把 `svg` 也列入不带 sandbox 的例外 → `a.svg` 带 sandbox 的断言判红。
- 变异：`embedOrigin` 为 `null` 时输出 `frame-ancestors *` 或省略该指令 → `'none'` 用例判红。
- 变异：去掉 `embedOrigin` 校验、原样拼接 → 非法 `embedOrigin` 一组判红。
- 变异：退回只有前两个条件的原式（去掉字符检查）→ 「含 CSP 语法字符」一组判红。
- 变异：字符表 `*`、`;`、`,`、`'` 各去一个 → 该组对应字符的用例判红。
- 变异：表外回退改成 `text/plain` 或 `text/html` → `README`、`data.bin` 用例判红。
- 变异：`lastIndexOf` 为 `-1` 时不提前返回 → 文件名 `html`、`pdf` 的用例判红。
- 变异：`Map` 换成对象字面量 → `a.constructor`、`a.__proto__` 用例判红。
- 变异：去掉 `toLowerCase` → `A.HTML` 用例判红。
- 变异：`xml` 改成 `application/xml`，或表里加 `xhtml` → 全表行与表外行判红。
- 变异：成功响应删掉 `nosniff`、`no-store`、`no-referrer`、ACAO、CORP 任一项 → 七键整对象相等判红。
- 变异：失败响应多带 ACAO 或 CSP，或 `Content-Type` 变成 JSON → 失败四键整对象相等判红。
- 变异：预期不可观察：「按内容嗅探」。函数签名里没有内容参数，本刀写不出这条变异；它的证据是签名本身，路由层的证明在 #1069 的「类型只看文件名」（`notes.txt` 内容是 HTML）。
- 变异：预期不可观察：404 状态码与正文文案、令牌与 `Origin` 的往返。本刀没有监听器，归 #1069。

## 10.1（#1063）

- Critical Path：本刀不碰 `sandbox.resolve`、不加 `op`、不加路由（那是 #1065），但解析的是用户文件里攻击者可控的字节，按 issue 要求 PR 标注白盒审查、两个评审席；本层的逃逸向量是内存与时间上界、成员名只是数据，「他人工作空间 → 相同 404」「越界 → `sandbox.reject`」归 #1065 / #1075。
- 解析层契约（规格只写了路由层，此处定死）：`archive.ts` 导出 `archiveFormat(name: string): "tar" | "tar.gz" | "gz" | null` 与 `listArchive(format, name, readAt, options): Promise<{format, entries, truncated}>`；`readAt: (position: number, length: number) => Promise<Buffer>`（文件尾返回短 Buffer）；`options: {maxEntries: number; now: () => number}`；条目是 `{path: string; type: "file" | "dir"; size: number | null}`（`size` 必填，`exactOptionalPropertyTypes`）；「不支持」一律 `throw new HttpError("preview_unsupported")`（同 `preview.ts:51` 的做法）。
- `archive.ts` 本刀不导入 `node:fs`、`node:os`、`node:path`：文件由调用方打开并给出 `readAt`，「不落盘、不访问成员路径」由此在结构上成立；只导入 `node:zlib` 与 `../core/errors/index.js`。#1064 的 zip 需要 fd 或路径时由那一刀自己扩签名，记入其偏离记录。
- `archiveFormat` 按小写文件名判定，先判 `.tar.gz` / `.tgz`、再 `.tar`、最后 `.gz`；`.zip` 在本刀返回 null，由 #1064 加入，本刀不写「`.zip` → null」的断言（否则下一刀要改），用 `readme.md` → null 覆盖该分支；`gz` 不读任何字节，`path` 为 `name.slice(0, -3)`（保留原大小写），`size: null`——内容不是 gzip 的 `x.gz` 也返回一项，记入偏离记录。
- 一个遍历器、两个字节源（否则 jscpd 3% 会咬）：内部 `ByteSource {read(n), skip(n)}`；`tar` 的 `skip` 只挪位置不读；`tar.gz` 以固定 65536 字节的块经 `readAt` 取压缩字节喂 `zlib.createGunzip()`，`skip` 丢弃解压出的字节；任何退出路径（上限、时限、损坏、抛错）都在 `finally` 里 `destroy()` gunzip；每次 `readAt` 的 `length` 因此至多 65536。
- 头校验（规格未写，「一项都读不出 → 415」靠它才可测）：每个 512 字节头验 ustar 校验和（校验和域按八个空格计、无符号求和）；`size` 只认八进制，base-256 或非法字符按损坏；`prefix` 只在 magic 恰为 `ustar\0` 时拼接（GNU 的 `ustar␠␠\0` 该区域不是 prefix）；名字取到首个 NUL，优先级 pax `path` > `L` > `prefix/name`；`Buffer.toString("utf8")` 自带 U+FFFD 替换。
- 结束与损坏的判定：读到一个全零块 → 正常结束（零项时返回 `entries: []`、`truncated: false`，不是 415）；短头、缺头（文件尾没有零块）、坏校验和、坏 `size`、gunzip 报错、坏 pax 记录都算损坏——此前零项则抛不支持，已有项则停读并置 `truncated: true`；头已读全而正文被截断的成员计入结果（`cut.tar` 两种切法各一例：切在第二个头中间 → 一项；切在最后一个成员正文中间 → 含该成员）；不取文件大小。
- 扩展记录：`L` 与 `x` 先看声明的 `size`，大于 65536 即不读、按损坏处理；读入后名字（去尾 NUL）超过 4096 字节同样按损坏，该成员不计入；`K`、`g` 整段 `skip`、不读入、不成为条目；pax 用 `indexOf` 逐条按字节解析 `LEN key=value\n`，只取 `path`，不用 `RegExp`（semgrep）；ustar 拼接名最长 256 字节，不会触上限。
- 类型与大小：`typeflag` 为 `5` → `dir`，其余一律 `file`；`path` 原样（含尾部 `/`、`..`、前导 `/`）；`size` 取头里的值，pax 的 `size` 记录不认；正文一律按头里的 `size` 向上取整到 512 跳过。
- 上限：`entries.length === maxEntries` 时立即停读并置 `truncated: true`，不探下一个头（规格字面）；后果是恰有 `maxEntries` 个成员的包也报 `truncated`，用「上限 3、三个成员」一例钉住并记入偏离记录。
- 时限 5000 毫秒是模块常量：开始取一次 `now()`，每轮取头之前判一次（扩展记录那一轮也判，否则一串 `g` 头不受限），`tar.gz` 的 `skip` 每丢一块再判一次；`slow.tar` 的时钟由测试的 `readAt` 驱动——收到第三个成员头的位置时把假时钟拨到 +6000，期望恰三项；另加规格外的 `bomb.tgz`（第一个成员正文 8 MiB 的零、后跟一个成员，假时钟每调用一次加 1000）期望一项 + `truncated`，它同时钉住 `tar.gz` 也有时限。
- 测试落位：字节构造器（`tarHeader`、`tarFile`、`paxRecord`、记录最大 `length` 的 `readAt` 包装）放新文件 `server/test/workspaces-archive-helpers.ts`，因为 `workspaces-archive.test.ts` 还要被 #1064、#1065 续写，本刀控制在约 300 行内；helper 的每个导出都要有测试导入（`knip.json` 里 `test/**` 的非 `.test.ts` 文件只是 project 不是 entry）；`archive.ts` 的导出只被测试引用是合规的。
- 「无新增文件」要能判红：包写进 `tempDir()`（`server/test/core-db-helpers.ts:128`），`readAt` 用真实文件句柄；用 `vi.stubEnv("TMPDIR", <空子目录>)` 后断言该子目录仍为空、包所在目录的列表前后相同，不要快照全局 `os.tmpdir()`（并行 worker 会抖）；恶意成员名一例另用 `spyBodyIo()`（`server/test/workspace-file-helpers.ts:17`）断言没有任何调用收到成员名路径。
- 门槛与清单：biome 认知复杂度上限 15，遍历循环必须拆成 `parseHeader` / `readExtension` / `parsePax` / `walk` 等小函数；`noUncheckedIndexedAccess` 下取字节用 `readUInt8` 或 `subarray`；覆盖率分支 80%，损坏分支逐条有用例（随机 1 KiB 的 `junk.tar` → 不支持、非 gzip 的 `x.tgz` → 不支持、0 字节 `.tar` → 不支持）；不新增配置键、不动 `docs/architecture/system.md` 第 9 节、不动 `server/src/workspaces/index.ts`；纯服务端库函数，no checklist rows。
- 变异：到上限后继续读 → 1500 成员 `big.tar.gz` 的「恰 1000 项」与上限 3 的 `x.tar`「恰 3 项」判红。
- 变异：不认 GNU `L` → 200 字符长路径用例判红；不认 pax `path` → 中文路径用例判红。
- 变异：去掉扩展记录 65536 的声明长度判定（按声明长度分配或读取）→ `evil.tar` / `evil2.tar` 的「`readAt` 最大 `length` ≤ 65536」判红；`evil.tar` 也可能先以 `ERR_OUT_OF_RANGE` 抛出，同样算红。
- 变异：去掉成员名 4096 字节上限 → `long2.tar` 的「恰一项 + `truncated`、没有超过 4096 字节的 `path`」判红。
- 变异：时限只套在 `tar.gz` 上 → `slow.tar`「恰三项」判红；时限只套在 `tar` 上，或去掉 `skip` 里的逐块判定 → `bomb.tgz`「恰一项」判红。
- 变异：去掉校验和校验 → `junk.tar`「不支持」判红。
- 变异：不论 magic 都拼 `prefix` → 需要一例 GNU magic 且 `prefix` 区域非零的头，期望 `path` 只取 `name`；不加这一例则此变异不可观察，建议加。
- 变异：把 `x`、`g`、`K` 记录当成员 → 中文路径用例的条数断言判红。
- 变异：对成员名做规范化（`path.normalize` 或去前导 `/`）→ 恶意成员名用例的原样断言判红；对成员名做文件系统访问 → `spyBodyIo` 断言判红，但只拦得住回调与同步 API，`fs.promises` 不在其内。完整的「空间外无读写」归 #1065。
- 变异：把 `.gz` 的判定排到 `.tar.gz` 之前 → `x.tar.gz` 的 `format` 断言判红。
- 变异：去掉 `finally` 里的 gunzip `destroy()` → 本刀不可观察（没有可数的句柄），靠白盒审查。
- 变异：目录遍历、符号链接、跨工作空间 id、他人工作空间 404、越界审计 → 本刀没有路由，不可观察，归 #1065 / #1075。

## 14.1、14.4（#1071）

- 触及 Critical Path「omp 子进程治理」同类（spawn / 回收、sudo 身份、环境不得带凭证）：两个评审席位，PR 标白盒审查；不经 `sandbox.resolve`（输入已是绝对路径）；纯服务端，无验收清单行；不动 `docs/architecture/system.md`。
- 现状核对：`server/src/preview/` 与 `server/test/fixtures/` 都不存在（既有假可执行文件在 `server/test/support/`，`fake-omp.mjs` 为 100755）；按任务原文新建 `test/fixtures/`，`naming-guard` 的草稿目录正则不命中，约定不一致记入偏离记录。
- 复用点：`server/src/core/process-path.ts` 的 `SETPRIV_PATH`（:5）、`assertSafeSudoPath`（:11）、`assertSetprivExecutable`（:26），调用形态照 `sessions/omp/process.ts:74-77`，每次 `convert` 在 spawn 前检查，抛错即 `failed` 且不 spawn、不回退；作业目录用 `core/sandbox/dirs.ts:41` 的 `ensureOwnedDir(job, 0o2770)`。
- 不导入 `sessions/omp/process.ts:56` 的 `SpawnImpl`（返回 `ChildProcessWithoutNullStreams`，与 `stdio:"ignore"` 不符）；`office.ts` 自定本地 spawn 类型，缺省 `node:child_process` 的 `spawn`。
- 签名偏离：选项为 `{officeBin?, cacheDir, timeoutMs, ompUser?, spawn?}`；`spawn` 是规格五键之外的测试 seam；`concurrency` 本刀不收（无行为可证），由 #1073 加入；错误为 `OfficeConvertError`，`kind ∈ unavailable|failed|timeout|aborted`，`message` 恒等于 `kind`。
- 输出落点（规格未写，#1072 正文「输出留在作业目录」与规格「作业目录已不存在」冲突，以规格为准）：成功后复制为 `<cacheDir>/pdf/<随机名>.pdf` 再删 `<job>` 并返回该路径；#1072 只把随机名换成缓存键并加命中；`work/`、`pdf/` 由调用方建，本刀不 mkdir，`work/` 缺失即 `failed`。
- 成功判定与复制同一个 fd：`open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`（`O_NONBLOCK` 防输出名被换成 FIFO 时 open 挂住） → `fstat` 为普通文件且 `size>0` → 从该 fd 读出写入 `wx`、`0600` 的新文件；不用「`lstat` 后 `copyFile`」（`OMP_USER` 模式下中间可被换成符号链接）；输出名为 `parse(basename(absInput)).name + ".pdf"`。
- 删作业目录：`rmSync(job,{recursive:true,force:true})` 必须包 try/catch（本机实测：子目录 `0500` 时 `force` 仍抛 `ENOTEMPTY`）；`out/`、`profile/` 不预建，由假 `soffice` 自己 `mkdir -p`。
- 终止：同 uid 模式 `detached:true`，仅当 `child.pid` 为正整数且未退出时 `process.kill(-pid,"SIGKILL")`（`officeBin` 不存在时 `pid` 为 `undefined`，不得落成 `kill(0)` 杀掉自己的进程组）；`OMP_USER` 模式不 `detached`，`child.kill("SIGKILL")`；两者都等 `exit` 后才落定；spawn 的 `error` 事件仅在没有 pid（进程未起来）时落定为 `failed`；有 pid 的 `error`（如 `kill` 得 `EPERM`）不落定，仍等 `exit`。
- 未写明的分支：调用时 `signal` 已中止 → `aborted`，不 spawn、不建作业目录；`close()` 幂等，其后 `convert` 立即 `aborted`；`LANG` 缺席时不设该键。
- 夹具 `fake-soffice.mjs`（100755，`#!/usr/bin/env node`）：记录写在 `dirname(<job>)/<job 名>.record.json`，内容 `{argv: process.argv.slice(1), env, pid, childPid?}`；标记取自最后一个 argv 的文件名；「先起子进程再睡眠」的子进程与睡眠都设上限（如 30 秒）自行退出。
- 另加第八、第九个标记（第九个是 `fifo`：输出名是命名管道，断言 `failed` 且不挂住；第八个如下）（偏离 14.4 的七种）：在 `<job>` 下留一个 `0500` 的非空目录后正常写 PDF，用例断言 `convert` 仍成功、结果可读，`afterEach` 先 `chmod` 再清；这是 #1052 第 1 点在同 uid 下的等价物，没有它 try/catch 分支无证。
- 测试 `office-converter.test.ts`：注入的 spawn 包装器记录每次的 `command`、`args`、`options.env` 与 `ChildProcess`，是「恰启动一次」「命令为 `sudo`」「`exit` 的 signal 为 `SIGKILL`」「basename 不为 `soffice` / `libreoffice`」的判据；假 `sudo` 是临时 bin 目录里名为 `sudo`、指向夹具的符号链接，`process.env.PATH` 设为「临时 bin:`dirname(process.execPath)`:/usr/bin:/bin」并在 `afterEach` 还原；sudo 用例套 `useSetprivStub()`（`test/support/setpriv.ts`）。
- 断言口径（偏离记录）：环境键集合对包装器的 `options.env` 精确断言，对子进程记录先去掉 macOS 运行时注入的 `__CF_USER_TEXT_ENCODING` 再精确断言；`LANG` 随 `process.env.LANG` 条件断言；父环境里的 `MODEL_UPSTREAM_API_KEY` 用低熵占位值；「缓存目录里没有新增文件」落实为 `pdf/` 为空且 `work/` 下没有目录（只剩记录文件）；「都已不存在」为对 `pid`、`childPid` 轮询 `process.kill(pid,0)` 直到 `ESRCH`，先断言 `childPid` 已记录；中止与 `close()` 用例先等记录出现再动手；`OMP_USER` 场景末句「并发名额已释放」留给 #1073；`OMP_USER` 用例不断言作业目录已删。
- 门槛：`convert` 拆成 argv / 环境构造、spawn 与等待、终止、输出判定四个函数（Biome 复杂度 15）；sudo 前缀数组不照抄 `process.ts:137-153` 的结构与注释（jscpd），也不抽共用 helper 进 `core/process-path`；knip 以 `test/**/*.test.ts` 为入口，测试是唯一导入方即可，只导出测试用到的符号；`.mjs` 不计 800 行但受 Biome 约束；200 毫秒超时若在 CI 上抖，放大数值并记偏离，不放松断言。
- 变异：同 uid 超时改为只 `child.kill("SIGKILL")` → 「超时与中止」的 `childPid` 不存在断言判红。
- 变异：`OMP_USER` 终止改为经注入的 spawn 再起一个 `sudo … pkill` → 「假 `sudo` 恰被启动一次」判红。绕过注入 spawn 直接调 `child_process` 的写法测试观察不到，靠白盒审查。
- 变异：sudo 立即失败后回退直接启动 `officeBin` → 「sudo 前缀」的启动次数与命令断言判红。
- 变异：环境改为继承 `process.env` → 「argv、环境与成功判定」的键集合断言判红（记录里出现 `MODEL_UPSTREAM_API_KEY`）。
- 变异：`HOME` 不指向作业目录，或 `UserInstallation` / `--outdir` 不在同一作业目录下 → 同一场景的 argv / `HOME` 断言判红。
- 变异：输出判定把 `O_NOFOLLOW` / `fstat` 换成跟随链接的 `stat` → 「各类失败」的符号链接例判红；去掉 `size>0` → 空文件例判红；不看退出码 → 退出码 1 例判红。
- 变异：错误 `message` 带上输入路径或作业目录 → 「各类失败」的「不含路径」断言判红。
- 变异：去掉成败后的删作业目录 → 「作业目录已不存在」判红；让删除失败上抛 → 第八标记用例判红。
- 变异：结果直接返回 `<job>/out/*.pdf` 而不复制 → 「落定路径内容等于假进程所写 PDF」判红（作业目录已删，读不到）。
- 变异：去掉 `close()` 后的 `aborted` 短路 → 「`close()` 之后的 `convert`」判红；去掉 `available:false` 的短路 → 「未配置」的零次 spawn 与 `work` 下无新目录判红。
- 变异：预计不可观察：`lstat` 与复制之间的换链接竞态（假进程无法定时注入）；`OMP_USER` 模式下真实后代残留（已登记残余，归 28.6 人工验证）。

## 23.1（#1104）

- 不触 Critical Path（无沙箱、omp 子进程、审批）；单评审席即可；无配置键、无 `docs/architecture/system.md` 表改动；纯拷入、无用户可见变化——no checklist rows；不登记 `MIGRATED_AREAS`。
- 依赖：边表「23.1 只 ← 0.1」（#1049 / PR #1285 视为已合），代码层面也无其它前提；不等 1.1 / 1.2 / 1.3，与 #1052 的裁决无关；不依赖同批任何兄弟刀。唯一下游是 #1105（23.2–23.6，另 ← 21.1）。
- 合并次序：本刀改根 `package-lock.json`、`web/package.json`、`ATTRIBUTION.md` 第 3 节；同批凡加 npm 依赖的刀（proposal 点名服务端 `yauzl`，属组 10）会在锁文件与 `ATTRIBUTION.md` 冲突，串行合，后合者 rebase 后重跑 `npm install`，不手工合锁文件。
- registry 原件取自 `https://ui.shadcn.com/r/styles/radix-nova/resizable.json`（`web/components.json` 的 style 即 `radix-nova`）：单文件约 50 行，导出 `ResizableHandle`、`ResizablePanel`、`ResizablePanelGroup`，只导入 `cn` 与 `react-resizable-panels`，不导入 `radix-ui`、`lucide-react`、`react`。
- 六类修改实际只有两类，PR 描述逐条列：（三）Biome 格式化（双引号、分号、行宽 100、导入排序；首行 `"use client";` 保留，先例 `web/src/components/ui/collapsible.tsx:1`）；（四）`import { cn } from "cn"` 改为 `from "@/lib/utils"`。颜色类全是主题变量（`bg-border`、`ring-ring`、`ring-offset-background`），无可见文案，预期无需类型适配，不做透传修改。
- 依赖：`npm install react-resizable-panels --workspace web`，当前 4.14.3，MIT，无运行时依赖，peer 为 react / react-dom ^18 || ^19。registry 原件用的是 v4 API（`Group` / `Panel` / `Separator`、`GroupProps` / `PanelProps` / `SeparatorProps`），不得装 3.x。`web/package.json` 的 `@radix-ui/*` 仍是 7 个，PR 描述贴 diff 佐证。
- `ATTRIBUTION.md` 第 3 节新增条目，标题行须满足 `ui-guardrails.test.ts:230` 的 `hasEntry` 格式：``- **react-resizable-panels** —— `MIT License`,版权归 Brian Vaughn（https://github.com/bvaughn/react-resizable-panels）``，下接「用途」（shadcn/ui `resizable` 的依赖，会话页工作空间侧边栏分隔线用；本刀尚无应用层调用方）与「义务」两行。版权人以安装后包内许可文件为准。shadcn/ui 条目的用途句补一句「`resizable` 随 s1f-files-page 任务 23.1 拷入,新增依赖 `react-resizable-panels`」。
- 新测试 `web/test/components-ui-resizable.test.tsx`（命名先例 `components-ui-button.test.tsx`、`components-ui-radio-group.test.tsx`；它是 knip 眼里唯一的导入方）：渲染 `ResizablePanelGroup` + 两个 `ResizablePanel` + `ResizableHandle withHandle`。断言三个 `data-slot`（`resizable-panel-group` / `resizable-panel` / `resizable-handle`）、`getByRole("separator")` 存在且可聚焦、`withHandle` 时分隔线内有一个子 `div`、调用方 `className` 透传到 Group 与 Handle。
- jsdom 坑：库在 Group 挂载时无条件 `new ownerDocument.defaultView.ResizeObserver(...)`，jsdom 没有它，`web/test` 也没有现成桩。测试内 `vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })`，`afterEach` 里 `vi.unstubAllGlobals()` 与 `cleanup`；桩写在本测试文件内，不新建共享 helper。
- 上述渲染断言在 jsdom 下未经执行验证（只确认了 `ResizeObserver` 一处硬依赖，`adoptedStyleSheets` 有守卫）。若还有别的缺口使 Group 挂不上，停下报告，不 mock 整个库、不改拷入文件。
- `web/test/ui-guardrails.test.ts`（254 行）的 `describe("ATTRIBUTION.md")` 加一条：`hasEntry(attribution, "react-resizable-panels", /\bMIT\b/)` 为真，且 `web/package.json` 的 `dependencies` 含该包。这是唯一要动的既有测试文件，只增不改。
- 豁免核对，全部按目录通配，无事可做：`constraints.yaml:169`（`web/src/components/ui/**`）、`web/vitest.config.ts:16`、`.jscpd.json:9`、`scripts/size-guard.sh:20`、`biome.json:44`（只关 linter，formatter 与导入排序仍生效）、`knip.json` 的 `ignore`。`web/test/ui-layering.test.ts:524` 钉死 `knip.json` 只有这两条 `ignore`；不加 `ignoreDependencies`（issue 禁止改 knip 规则）。
- 既有守卫不受影响：`ui-layering.test.ts:704` 只钉 `assistant-ui` 目录的文件集，`components/ui` 无文件清单断言；拷入文件无动态 `import()`；应用层零导入，主包字节数不变。
- 偏离记录写三条：（1）新增测试文件作为唯一导入方，原因见 knip 行为；（2）六类修改只用到两类；（3）版本落在 v4。
- 变异清单：
- 删 `ATTRIBUTION.md` 的 `react-resizable-panels` 条目标题行，或去掉其 `MIT` → `ui-guardrails.test.ts` 新增用例红。
- 删 `web/test/components-ui-resizable.test.tsx`（或去掉其对 `@/components/ui/resizable` 的导入）→ `npx knip` 报 `react-resizable-panels` 未使用依赖，`make check` 的 anti-drift 红（预期，按源码推断）。
- `resizable.tsx` 的 `ResizableHandle` 去掉 `{...props}` 或 `data-slot` → `components-ui-resizable.test.tsx` 的 `data-slot` / `className` 透传断言红。
- `ResizableHandle` 把 `withHandle &&` 改成恒假 → 「分隔线内有子 `div`」断言红。
- 测试里去掉 `ResizeObserver` 桩 → 同文件渲染即抛错变红（证明桩是必需的，不是装饰）。
- `web/package.json` 多加一个未登记的 `@radix-ui/react-*` → 既有 `ui-guardrails.test.ts:219`「Radix 条目列出 web 已安装的每个 @radix-ui/* 包」红。
- 把 `cn` 导入改回 `"cn"` → `npm run typecheck` 与测试的模块解析红。
- 预期不可观测：把 `bg-border` 换成颜色字面量（拷入层关了 linter，无颜色守卫扫 `components/ui`）——只能靠评审对照 registry 原件 diff，PR 描述附逐行对照。

## 26.1（#1111）

- 不触及 Critical Path：只加四个被跟踪的数据文件并改 `smoke/fixtures/README.md`，不动 `sandbox.resolve`、`op`、路由、omp 子进程或审批；单席评审即可，无需 owner 白盒。
- 依赖：边表「26.1 只 ← 0.1」，0.1 即 #1049（PR #1285）；不等实测 1.1 / 1.2 / 1.3，与 #1052 的裁决无关；代码上不依赖同批任何一刀（#1053、#1054、#1055、#1057、#1059、#1061、#1063、#1066、#1068、#1071、#1076、#1077、#1104），可排在批内任意位置。下游是 26.2（#1112）、27.1 的 (a)(b)(c) 与 27.2。
- 引用核对无漂移：夹具目录在 `origin/master` 恰为 `readme.md`（369 B）、`notes.csv`（42 B）、`logo.png`（1277 B）；`smoke/files.hurl:38-43` 对 `tree` 只有三条 `exists` 断言，无计数、无顺序；`web/e2e/ui-walk.spec.ts:326-330` 的 `expectRootFileButtons` 只按名取三个按钮，`:246` 的 `toHaveCount(0)` 只针对 `walk-out`。新增文件不会让既有断言变红。
- 夹具经既有 `cp -R smoke/fixtures/sandbox/u1/. "$SANDBOX_ROOT/u1/"` 进 CI（`.github/scripts/ci-compiled-server.sh:16`、`ci-uid-isolation.sh:95`，后者 `:97` 的 `find -type d -exec chmod 2770` 自动覆盖新目录 `site/`）；`scripts/test-ci-harness.sh:466-469` 只 `cmp` 三个旧文件，本刀不改它。
- `site/index.html`（纯 ASCII、LF、文末换行、两格缩进）：`<!doctype html>`、`<html lang="en">`、`<meta charset="utf-8">`、`<title>smoke-site</title>`、`<link rel="stylesheet" href="./style.css">`、`<h1>smoke-site</h1>`。不放 `<script>`、内联 `style`、外链地址、favicon 链接：27.1(b) 的 oracle 是「只有预览来源的非 `baseURL` 请求、零 console 错误」。
- `site/style.css` 只有一条规则 `h1 { color: rgb(0, 128, 0); }`；不在 `index.html` 里重复颜色，否则 27.2「删掉 `style.css` 必红」失效。
- `sample.py` 两行、四格缩进、文末换行、模式 100644、无 shebang：`def greet(name):` 与 `    return f"hello, {name}"`。首行必须含会被 `highlight.js` 着色的记号（`def` 关键字），因为 27.1(a) 断言首行至少一个高亮元素；首行不要写空行或纯标识符。
- `clip.wav` 定为 844 字节：Python 3 标准库 `wave` + `struct`，单声道、16 位、8000 Hz、400 帧，第 `i` 帧取 `8000 if (i // 9) % 2 == 0 else -8000`（纯整数方波，可逐字节复现）。我在 scratchpad 实测：44 字节文件头、`data` 块 800 字节、0–3 字节为 `RIFF`，`file` 输出 `RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 8000 Hz`，sha256 前缀 `6aef1c67`。
- README 须改的现有句子（否则文档为假）：`:7`「恰好三个文件」改为七个（根下五个加 `site/` 下两个）；`:12` 标题「三个夹具文件」改为「夹具文件」并加四行（用途与内容要点）；`:40`「必须恰好列出五个文件」改为九个并列全；新增一节「`clip.wav` 的生成方式」。
- README 的写法决定（记入偏离记录）：生成方式仿 `logo.png` 一节用文字写参数与逐帧规则，加一句 `file` 核对输出，不贴可运行的代码块（验收写「仓库里没有生成脚本」）；「消费方」一节本刀不加行，因为新文件此刻没有消费方，由 26.2、27.1 各自补；「替换夹具时要同步检查」加一条：标题 `smoke-site`、相对地址 `./style.css`、颜色 `rgb(0, 128, 0)`、`clip.wav` 不超过 1 KiB 由 files-harness 条文钉死。
- 守卫都不会触发：四个路径未被 `.gitignore` 命中（`git check-ignore` 无命中）；biome、ruff、jscpd、knip、semgrep 都不扫 `smoke/`；`size-guard` 对暂存的 `sample.py` 只查 800 行；`naming-guard` 无禁用后缀；`clip.wav` 是二进制 diff，gitleaks 不看内容。`.gitattributes` 不用改（Linux CI 不换行尾，`logo.png` 已有先例）。
- 无清单行：本刀没有产品代码与用户可见行为变化，`docs/acceptance/functional-checklist.md` 不动（该文件现无 `smoke-fixture` 或 `readme.md` 字样）；FL 行随 27.1 与组 17–22。
- 验证证据（写进 PR）：用含新夹具的沙箱起服务，连跑两次 `make smoke` 全绿，并跑 `make ui-walk`（目录树多出 `site`、`sample.py`、`clip.wav` 三行，既有步骤应不变）；另贴 `git ls-files smoke/fixtures/sandbox`（九行）、`wc -c clip.wav`（844）、`file clip.wav` 的输出。
- PR 边界之外允许的唯一改动：`openspec/changes/s1f-files-page/tasks.md` 勾选 26.1 并留注记指针（issue 正文要求）；不改 `smoke/*.hurl`、`.github/**`、`scripts/**`、`web/e2e/**`。
- 变异：删掉 `site/style.css` → 本刀不可观测；27.2 在标题颜色断言处判红，26.2 的 `GET {{base}}site/style.css` 200 判红。
- 变异：`index.html` 的 `href` 写成绝对地址或 `style.css` 改名 → 本刀不可观测；27.1(b) 的 `rgb(0, 128, 0)` 判红。
- 变异：`<h1>` 文本不是 `smoke-site` → 本刀不可观测；27.1(b) 的标题断言与源码视图断言判红。
- 变异：`sample.py` 首行改为空行 → 本刀不可观测；27.1(a) 的首行高亮元素断言判红。
- 变异：`clip.wav` 截成不足 4 字节或换成非 RIFF 内容 → 本刀不可观测；26.2 的 `Range: bytes=0-3` 206 与 4 字节正文判红（仅当 26.2 比对字节；规格只要求长度，见下）。
- 变异：`clip.wav` 超过 1 KiB → 任何切片都不可观测（条文禁止长度字面断言）；只靠本刀 PR 里的 `wc -c` 与 README 的同步检查项。
- 变异：夹具文件漏提交（只在本机沙箱里）→ 本刀 CI 不红（既有 hurl 不取新文件）；PR 里的 `git ls-files` 九行是唯一证据，26.2 的 CI 才会红。
- 变异：回归方向（本刀可观测）：误改 `readme.md`、`notes.csv`、`logo.png` 任一字节 → `ui-walk.spec.ts:250-282` 的标题、五行、256×256 断言判红；`files.hurl:89-103` 因 `file,` 自引用不会红。
