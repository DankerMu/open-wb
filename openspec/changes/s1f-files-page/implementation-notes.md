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
