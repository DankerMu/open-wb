# Tasks: s1f-legacy-layer-removal

> 前置：`s1f-session-list-temp-space`（C）与 `s1f-files-page`（D）已归档，代码都在 `master`。当前没有别的进行中的 change，不需要跨 change 的规格对底。
>
> 跟踪：#1393 是 Epic；下面六个组各是一个子 issue、一个 PR（design D6，owner 2026-10-12）：组 1 = A，组 2 = B1，组 3 = B2，组 4 = C1，组 5 = C2，组 6 = D。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - 组 2 ← 组 1；组 3 ← 组 2；组 4 ← 组 3；组 5 ← 组 4；组 6 ← 组 5。线性，不并行；每条边在代码里的理由见 design D9（共改 `web/src/ui/index.ts`、`ui.css`、`web/package.json` 与 `web/test/ui-layering.test.ts` 的同一组常量；组 3 的基线必须是 Toast 已删除的 `master`；组 4 搬不搬 hook 取决于组 3 的分支；组 5 的计算样式基线是组 4 合入后的 `master`；组 6 删的文件是组 5 搬空的那几个）。
> - 组内按编号顺序。唯一的分叉在组 3：3.2 与 3.3 二选一，由 3.1 的实测结果决定；组 4 里凡带「若保留」的部分只在取了 3.3 时执行。
> - 6.9（主规格的 Purpose）由编排方在归档提交里做，不属于任何一组的 PR（design D21）。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行。
> - **不改变任何页面的视觉与行为**（design Non-Goals）：不改使用处的类名，不改 `Icon` / `BrandMark` 的源码内容（只搬位置），不给搬运的规则去重或修正，不碰两个拷入目录。发现非改不可的地方，停下来报告，不自行放宽。
> - 组 1–5 的守卫改动是**过渡断言**（清单逐刀收缩）；规格 delta 描述的是组 6 之后的终态。过渡断言不许放空：清单类断言同时断言长度与「目录里的每个文件都在清单里」。
> - 既有断言只要还有意义就不删除、不削弱；随代码删除而删除或改写的断言，在 PR 的偏离记录里逐条列出，并写明被删的测试文件里有没有与已删代码无关的用例、它们去了哪里（design D14）。
>   **唯一被许可的例外**在组 2（2.4）：查 Toast 元素的断言（`toasts()` 助手、`.ui-toast` 类名查询、对 `通知` 区域的查询）整体删除。理由：被查的元素在 Toast 删除后不可能再存在，这些断言要么恒真、要么抛错，留着是摆设。条件：逐用例有整页范围的文本或角色断言兜底（owner 2026-10-12，design D3）。别处不得援引这个例外。
> - 任务里点名的 `文件:行` 是在 `51ffffb3` 上 grep 的结果。每一刀开工时先重跑该任务给的 grep；命中而未点名的依赖，在**让它变红的那一刀**里按同样的规则处置并记入偏离记录，不留到后一个 PR。
> - 移除依赖的 PR（组 1、组 2）在描述里显式标注依赖变更（`AGENTS.md`「依赖政策」）。
> - 一次性脚本（3.1 的补测、5.3 的计算样式比对）写在系统 scratchpad，不入库；它们的输出贴进 PR。
> - 不实现 design 的 Non-Goals：不设包体上限、不引入通知机制、不把 `ui-*` 类改写成 Tailwind 类、不把 `ui-btn` 纳入旧类扫描。
> - `Suggested fixture level` 只用 `none | compact | expanded`（design D20）。

## 1. ui-primitives / ui-foundation — 删除没有调用方的旧基元（子 issue A）

- [x] 1.1 开工核对：在分支基线上重跑清点，确认 24 个待删文件在 `web/src`（不含 `web/src/ui/` 自身）里没有导入方，8 个待删测试文件只导入这些基元。
  命令：`grep -rnE 'from "[^"]*/ui/(index|[a-z-]+)(\.js)?"|from "@/ui(/[a-z-]+)?"' web/src web/test | grep -v '^web/src/ui/' | grep -v components/ui`，逐行核对具名导入里只剩 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`、`ToastProvider`、`useToast`（测试文件里另有待删的八个）。
  验证：核对结果（与 design「Context」的数字是否一致、有无新增导入方）写进 PR；有出入先改本 change 的 design 与本组任务再继续。
- [x] 1.2 先搬后删——兜底自身的用例（design D4「兜底自身的性质」）：`web/test/ui-escape-dispatch.test.tsx` 里测 `escape-fallback.ts` 的两例（`:85-95` D1 输入法、`:130-157` D4 恰一次）借旧 `Dialog` 与 `ToastProvider` 搭台，1.4 要删这个文件。先新建 `web/test/escape-fallback.test.tsx`（从 `../src/ui/index.js` 导入 `useEscapeFallback`，不用旧基元、不用 Toast），两种搭台：
  (1) hook 接在一个普通 `div` 上（`ref`、`onKeyDown`；没有 Radix）——子树内的普通 Escape → 关闭回调以 `false` 恰一次；`isComposing: true` 的 Escape → 0 次；目标在该 `div` 之外的 Escape → 0 次；先以某个原生事件调用 `onEscapeKeyDown`、再让同一个原生事件进 `onKeyDown` → 0 次；`canClose: false` → 0 次。
  (2) hook 按调用点的写法（`onEscapeKeyDown`、`onKeyDown`、`ref` 三个属性）接在拷入层 `@/components/ui/dialog` 的内容元素上（引入 `radix-platform.ts`）——焦点在内容内，按一次 Escape → 关闭回调恰被调用一次、入参 `false`。
  输入法与子树之外两例只放在 (1)：没有 Toast 时 Radix 自己会在 `isComposing` 的 Escape 上关闭本层（design Context 出入 9），整层断言不成立。
  验证：新文件在删除任何东西**之前**就通过；对 `web/src/ui/escape-fallback.ts` 逐条做变异并撤销——去掉 `:33` 的 `handled` 判断 → (2) 判红（回调两次）；去掉 `:32` 的 `isComposing` 判断 → (1) 的输入法例判红；去掉 `:35` 的 `contains` 判断 → (1) 的子树之外例判红。结果贴进 PR。
- [x] 1.3 删除 24 个文件：`web/src/ui/` 下的 `button.{tsx,css}`、`chip.{tsx,css}`、`confirm-dialog.tsx`、`dialog.{tsx,css}`、`drawer.tsx`、`empty-state.{tsx,css}`、`input.{tsx,css}`、`menu.{tsx,css}`、`popover.{tsx,css}`、`segmented-control.{tsx,css}`、`switch.{tsx,css}`、`tag.{tsx,css}`、`tooltip.{tsx,css}`。
  `web/src/ui/index.ts` 只留四行导出（`BrandMark`、`useEscapeFallback`、`Icon` 与 `IconName`、`ToastProvider` 与 `useToast`）；`web/src/ui/ui.css` 的 `@import` 只留 `./toast.css`，其下的规则不动。
  验证：`ls web/src/ui` 恰为 8 个文件（`brand-mark.tsx`、`escape-fallback.ts`、`icon.tsx`、`index.ts`、`motion.css`、`toast.css`、`toast.tsx`、`ui.css`）；`make typecheck` 通过。
- [x] 1.4 删除只测这些基元的 8 个测试文件：`web/test/ui-dialog.test.tsx`、`ui-dialog-busy.test.tsx`、`ui-empty-state.test.tsx`、`ui-escape-dispatch.test.tsx`（它导入旧 `Dialog` / `ConfirmDialog` / `Drawer`，所以在这一刀而不是组 2；测 hook 的两例 1.2 已搬走）、`ui-form.test.tsx`、`ui-menu.test.tsx`、`ui-popover-tooltip.test.tsx`、`ui-segmented-control.test.tsx`。
  `web/test/app-shell-responsive.test.tsx:560-563`（读 `web/src/ui/drawer.tsx` 的属性键）删除这四行，同一用例的其余断言不动。
  验证：`npm test --workspace web` 通过且覆盖率门槛仍满足；`grep -rn 'ui/drawer\|ui/dialog\|ui/button' web/test | grep -v components/ui` 的命中恰为守卫里的字符串样本——`ui-layering.test.ts:254`、`:256` 与 `ui-guardrails.test.ts:137`（这三行是预期命中，不要改）；
  偏离记录逐个文件写明「没有与已删基元无关的用例」或列出例外。`ui-escape-dispatch.test.tsx` 一项如实写：D1 输入法例与 D4 恰一次例测的是 `escape-fallback.ts`，已由 1.2 搬到 `web/test/escape-fallback.test.tsx`；其余各例以旧基元或 Toast 为前提，随文件删除。
- [x] 1.5 过渡守卫：`web/test/ui-layering.test.ts` 的 `FROZEN_FILES` 收缩为 1.3 留下的 8 个文件名，「冻结清单恰为 32」改为 8，注释同步；
  `web/test/ui-reduced-motion.test.ts:148` 去掉「声明非 `none` 过渡的规则集合非空」（声明过渡的六个样式文件全部在 1.3 删除），保留对 `violations` 为空的断言与两条判定自证用例（它们用注入样本，证明守卫没有放空）。
  验证：两个测试文件通过；在 `web/src/ui/` 下临时放回一个 `button.tsx` → `ui-layering` 判红（做完撤销）。
- [x] 1.6 依赖：从 `web/package.json` 移除 `@radix-ui/react-dialog`、`react-dropdown-menu`、`react-popover`、`react-radio-group`、`react-switch`、`react-tooltip` 六个（保留 `@radix-ui/react-toast` 与合包 `radix-ui`），`npm install` 更新根 `package-lock.json`；
  `ATTRIBUTION.md` 的「Radix UI Primitives」条目把已安装单包的列举改为只剩 `@radix-ui/react-toast`。
  验证：`grep -c '@radix-ui/react-' web/package.json` 为 1；`web/test/ui-guardrails.test.ts` 的 `ATTRIBUTION.md` 一组通过；`make anti-drift`（knip）没有未使用或未登记的依赖；PR 描述标注依赖变更。
- [x] 1.7 变异证据（逐条做、逐条撤销，结果贴进 PR；1.2 的三条兜底变异另计）：`git checkout` 放回 `web/src/ui/chip.tsx` → `ui-layering` 的冻结清单断言判红；
  给 `web/src/ui/toast.css` 加一条 `transition: opacity 0.2s` 而不加 reduce 覆盖 → `ui-reduced-motion` 判红；
  在 `web/src/features/chat/composer.tsx` 加 `import { Root } from "@radix-ui/react-dialog"` → `ui-guardrails` 的依赖方向守卫判红；
  把 `@radix-ui/react-dialog` 加回 `web/package.json` 而不登记 → `ATTRIBUTION.md` 守卫判红。
- [x] 1.8 整刀验证：`make check`、`make test-guardrails`、`make ui-walk`（两个 project）全绿；`npm run build --workspace web` 成功。

Suggested fixture level: compact - 只删没有导入方的代码与只测它们的测试，另搬两例兜底用例；没有运行期行为变化，风险在过渡守卫与依赖登记，由变异证据与 knip 覆盖
Minimal mergeable slice: atomic - 24 个文件经 `ui/index.ts`、`ui.css`、`FROZEN_FILES` 三处与 6 个依赖声明互相牵连：按基元分批删要把这三处各改多遍，每一批的验证路径都是同一条 `make check`，分批没有独立价值；依赖必须与最后一个导入方同刀移除，否则 knip 判红；1.2 的搬迁必须与删除 `ui-escape-dispatch.test.tsx` 同刀，否则兜底的三条性质有一段时间没有测试

## 2. ui-primitives — 删除 Toast（子 issue B1）

- [x] 2.1 先搬后删（design D14；`useEscapeFallback` 与 10 处调用本组不动）：把三个 Toast 测试文件里**与 Toast 无关**的用例先搬到新家，去掉其中 Toast 的搭建：
  `web/test/ui-toast-drawer-escape.test.tsx` 的 D5（`导航` 覆盖层内打开用户菜单，Escape 只关菜单，再按一次才关覆盖层）→ `web/test/app-shell-responsive.test.tsx`；
  `web/test/auth-footer-toast-escape.test.tsx` 的两例去掉 Toast 之后的形态（宽屏：Escape 关闭确认框、不发起退出、焦点回 `用户菜单`；窄屏：`导航` 覆盖层内打开的确认框，一次 Escape 只关确认框、覆盖层保持打开）→ `web/test/auth-footer-focus.test.tsx`。
  目标文件加上之后接近 800 行就另建一个文件（如 `web/test/overlay-escape.test.tsx`）。
  验证：搬来的用例在删除 Toast **之前**就通过（它们不依赖 Toast）；它们对应 ui-primitives「覆盖层的 Escape 关闭」的场景「嵌套层只关最内一层」。
- [x] 2.2 删除 Toast：`web/src/ui/toast.tsx`、`web/src/ui/toast.css`；`web/src/ui/index.ts` 去掉 `ToastProvider` / `useToast` 一行；`web/src/ui/ui.css` 去掉最后一条 `@import`；`web/src/main.tsx` 直接渲染 `<RouterProvider router={router} />`。
  从 `web/package.json` 移除 `@radix-ui/react-toast` 并更新根 `package-lock.json`。`ATTRIBUTION.md`：「Radix UI Primitives」条目的用途改写为「经合包 `radix-ui` 供拷入层使用，不再直接安装单包」（条目与 MIT 义务保留）；`radix-ui` 条目删去「与上条保留的各 `@radix-ui/*` 单包并存到旧基元层退役」一句。
  验证：`grep -rn 'useToast\|ToastProvider' web/src` 零命中；`grep -c '@radix-ui/' web/package.json` 为 0；`make typecheck` 通过；PR 描述标注依赖变更。
- [x] 2.3 Toast 的测试文件与包装：删除 `web/test/ui-toast.test.tsx`、`ui-toast-drawer-escape.test.tsx`、`auth-footer-toast-escape.test.tsx`（2.1 已搬走该留的用例）；`web/test/chat-workspace-sidebar-narrow.test.tsx` 删除「屏上有 Toast 时的 Escape」一组（N3）与随之无用的导入，N1、N2、N4 不动；
  去掉其余 8 个文件里的 `ToastProvider` 包装：`chat-page-lifecycle-support.tsx`、`chat-page-shell-support.tsx`、`previewers-archive.test.tsx`、`previewers-media.test.tsx`、`previewers-table-svg.test.tsx`、`render-app-router.tsx`、`routes.test.tsx`、`settings-support.tsx`。
  验证：`grep -rn 'ToastProvider\|useToast' web/test web/e2e` 只剩 `ui-layering.test.ts` 里的注入样本。
- [x] 2.4 查 Toast 元素的断言整体删除（design D3、D14；通用纪律点名的唯一例外）。名单是在 `51ffffb3` 上 grep 的结果，开工时用本条末尾的命令在工作树上重新导出，以重导的为准：
  (i) 三个 `toasts()` 助手连同定义删除：`chat-page-artifact-card-support.tsx:195`、`chat-page-search-support.tsx:282`、`chat-page-session-meta-support.tsx:259`；它们的调用在 13 个文件里：`chat-list-events.test.tsx`、`chat-page-artifact-card.test.tsx`、`chat-page-artifact-card-feedback.test.tsx`、`chat-page-artifact-card-state.test.tsx`、`chat-page-project-config.test.tsx`、`chat-page-search.test.tsx`、`chat-page-session-delete.test.tsx`、`chat-page-session-delete-concurrency.test.tsx`、`chat-page-session-pin.test.tsx`、`chat-page-session-rename-pin.test.tsx`、`chat-page-slash.test.tsx`、`chat-page-welcome-scene.test.tsx`、`chat-stop-button.test.tsx`。
  (ii) 直接按类名 `.ui-toast` 查询的 18 个文件：`chat-approval-bar.test.tsx`、`chat-copy.test.tsx`、`chat-page-session-delete-concurrency.test.tsx`、`chat-regenerate-button.test.tsx`、`chat-undo-notice.test.tsx`、`chat-undo-support.tsx`、`chat-workspace-sidebar-reveal.test.tsx`、`chat-workspace-sidebar-reveal-html.test.tsx`、`files-ops-delete.test.tsx`、`files-ops-drag.test.tsx`、`files-ops-move.test.tsx`、`files-ops-rename.test.tsx`、`files-preview-states.test.tsx`、`previewers-archive.test.tsx`、`previewers-document.test.tsx`、`previewers-frame.test.tsx`、`previewers-media.test.tsx`、`previewers-table-svg.test.tsx`；走查 `web/e2e/ui-walk-session-list.ts:98`、`:356`。
  (iii) 按角色查通知区（`getByRole` / `findByRole("region", { name: "通知" })` 及其内的断言；Toast 删除后直接抛错）的 14 个文件：`chat-copy.test.tsx:69`、`chat-markdown.test.tsx:156`、`chat-page-welcome-scene.test.tsx:111`、`chat-stop-button.test.tsx:229`（正面断言通知区存在，整条删除）、`files-ops-delete.test.tsx:277`、`files-ops-drag.test.tsx:182`、`files-ops-move.test.tsx:446`、`files-ops-rename.test.tsx:385`、`files-preview-states.test.tsx:337`、`:534`、`previewers-archive.test.tsx:259`、`previewers-document.test.tsx:579`、`:612`、`previewers-frame.test.tsx:443`、`previewers-media.test.tsx:105`、`previewers-table-svg.test.tsx:285`、`:417`；走查 `web/e2e/ui-walk-stop.ts:124`（连同 `:141`、`:158` 的计数）。
  三类去重后是 34 个测试或支撑文件加 2 个走查文件。逐用例处置：删掉上述查询；确认**同一用例**里还有一条整页范围的断言证明「没有提示」——`queryByText(旧提示文案)` 为空、整页 `queryAllByRole("status")` / `("alert")` 的集合与操作前相同、或该用例本来就断言了取代 Toast 的那个界面（行内状态、`alert`、对话框文案）；没有的补一条整页范围的，不补限定在某个区域里的。
  注释同步：`previewers-archive.test.tsx:256`、`previewers-media.test.tsx:99`、`previewers-table-svg.test.tsx:283`、`:290`、`:430`、`files-preview-states.test.tsx:547` 等「挂在 `ToastProvider` 之下 / 通知区在场，没有 Toast 才不是空话」的说明改写为现状；`web/e2e/ui-walk-sessions.spec.ts:609-610`、`web/e2e/ui-walk-session-list.ts:87` 里提到 Toast 元素的注释同样处理。
  验证：`grep -rnE 'ui-toast|toasts\(|"通知"|/通知/' web/test web/e2e` 零命中（`ui-layering.test.ts` 的注入样本只含标识符 `useToast`，不在此列）；`npm test --workspace web` 通过；
  偏离记录是一张表，每个文件一行：删了哪几处查询、同用例里兜底的是哪条断言（既有 / 新补）。表里出现「无兜底」即不合入。
- [x] 2.5 这一步让它们变红的过渡守卫：`web/test/ui-foundation-entry.test.ts:106`（带 `@import` 的既有样式文件由恰为 `ui.css` 改为没有）；
  `web/test/ui-guardrails.test.ts:224` 去掉「已安装的 `@radix-ui/*` 单包数大于 0」，保留「每个已安装单包都在 `ATTRIBUTION.md` 登记」的循环与「标题含 `Radix` 的 MIT 条目存在」；
  `web/test/ui-layering.test.ts` 的 `FROZEN_FILES` 收缩为 6 个（`brand-mark.tsx`、`escape-fallback.ts`、`icon.tsx`、`index.ts`、`motion.css`、`ui.css`），长度断言同步；导入白名单不动（`useEscapeFallback` 仍在）。
  验证：三个守卫文件通过；`make anti-drift` 通过。
- [x] 2.6 注释与记录：提到「Toast 占住 Radix 层栈」的六处——`web/src/ui/escape-fallback.ts` 头注释、`web/src/features/auth/footer.tsx:72`、`web/src/routes/shell/app-shell.tsx:41`、`web/src/features/chat/workspace-sidebar.tsx:207`、`web/src/features/chat/project-config.tsx:117`、`web/e2e/ui-walk-session-list.ts:40`——改写为「Toast 已删除；这个兜底是否仍然需要由 #1393 的 Escape 实测决定」，不预写结论（组 3 写终稿）。
  在 `docs/adr/0013-assistant-ui-frontend-rebuild.md` 末尾新增「增补（change `s1f-legacy-layer-removal`）」，本刀写一条：Toast 删除且不提供替代（owner 2026-10-12），以及测试侧查 Toast 元素的断言整体删除及其理由。
  验证：`grep -rniE 'toast' web/src --include='*.ts' --include='*.tsx' --include='*.css'` 的命中只剩上述改写后的句子与对「不弹提示」的行为说明（逐条在 PR 里列出）。
- [x] 2.7 变异证据（逐条做、逐条撤销，结果贴进 PR）：在 `web/src/features/chat/composer.tsx` 加一行 `useToast` 导入样本 → `ui-layering` 判红（既有自证用例覆盖，确认它仍在跑）；
  把 `@import "./toast.css";` 加回 `ui.css` → `ui-foundation-entry` 判红；`git checkout` 放回 `web/src/ui/toast.tsx` → 冻结清单断言判红；
  在 `web/src/routes/shell/app-shell.tsx` 的 `导航` 覆盖层上临时加一个「任何 Escape 都关闭覆盖层」的 document 监听 → 2.1 搬来的「覆盖层内菜单只关自己」用例判红（证明它确实断言了覆盖层仍在，不是空转）；
  从 2.4 的表里任取三个「新补」的兜底断言，临时让对应的旧提示文案出现在页面上（在被测组件里渲染该文案）→ 各判红（证明补的断言不是摆设）。
- [x] 2.8 整刀验证：`make check`、`make test-guardrails`、`make ui-walk`（两个 project）全绿；`npm run build --workspace web` 成功。

Suggested fixture level: expanded - 改应用入口（`main.tsx`），并在三十多个测试文件里成批删除断言（通用纪律的唯一例外），每一处删除都要有可审计的兜底
Minimal mergeable slice: atomic - `ToastProvider` 从入口与测试包装里一删，14 个文件的通知区查询在同一次测试运行里抛错、`ui-foundation-entry:106` 与 `ui-guardrails:224` 同时变红；只删文件不卸 `@radix-ui/react-toast` 则 knip 判红。按测试文件分批删就得留着 `ToastProvider`，那是保留一个没有调用方的组件来迁就测试。`useEscapeFallback` 原样留着，对没有 Toast 的页面无害

## 3. ui-primitives — Escape 实测与兜底的去留（子 issue B2）

- [x] 3.1 Escape 实测（design D4；基线是组 2 合入后的 `master`；实测用的改动不提交）：
  (0) 开工先对照 design D4 的表逐个调用点检查既有用例：是否同时断言了「覆盖层消失」与「确认动作未触发 / 没有发出请求」。缺的先在未改动的代码上补齐并通过，再往下做；补了哪些写进 PR。
  (a) 把 9 个文件里 10 处 `useEscapeFallback` 调用接到内容元素上的 `onEscapeKeyDown` 与 `onKeyDown` 两个属性去掉，`ref` 保留；
  (b) 跑 `npm test --workspace web`，对照 D4 的表逐个调用点确认按 Escape 的用例（连同 2.1 搬来的三例与 (0) 补的）全部通过——不许改任何断言（`web/test/escape-fallback.test.tsx` 的 (2) 测的是接了 hook 的搭台，不受 (a) 影响）；
  (c) 跑 `make ui-walk` 两个 project；
  (d) 对走查没有 Escape 步骤的七处调用（退出确认框、重命名 / 另存为工作空间、会话删除确认框、撤回冲突确认框、`全部自动` 确认框、文件的创建 / 重命名 / 移动对话框、文件删除确认框），用一次性 Playwright 脚本在真实浏览器里各打开一次、焦点在其内时按一次 Escape，断言它关闭且确认动作未触发；其中能嵌套的（工作空间侧边栏模态层里的文件对话框、`导航` 覆盖层里的退出确认框）另断言只关最内一层。
  某一处触达不了（如撤回冲突确认框需要冲突态）时用 `page.route` 造出该状态；仍触达不了的，该调用点记「未证实」。
  验证：一张十行的结果表（调用点、单测、走查或补测、通过 / 不通过 / 未证实；不通过的写现象、复现步骤、jsdom 能否复现）。**任一处不通过、未证实，或结果不稳定（同一步骤重复三次出现不同结果）即判「不通过」，取 3.3。**
- [x] 3.2 分支一——十处全部通过：删除 `web/src/ui/escape-fallback.ts`、10 处调用与 `web/test/escape-fallback.test.tsx`；四处借用其 `ref` 的地方换成 `useRef<HTMLDivElement>(null)`、行为不变——`footer.tsx:74`（忙碌期焦点救回）、`app-shell.tsx:52`（打开者焦点归还）、`project-config.tsx:148`（`onOpenAutoFocus` 里把焦点定位到 `关闭`，不许删掉这段）、`dialogs.tsx:157`（内容元素引用）；`web/src/ui/index.ts` 去掉该导出；
  `web/test/ui-layering.test.ts` 的白名单去掉 `useEscapeFallback`、`FROZEN_FILES` 收缩为 5 个；2.6 改过的六处注释里随 hook 消失的删掉，其余改写为现状（`app-shell.tsx:42`、`workspace-sidebar.tsx:208`、`web/e2e/ui-walk-session-list.ts:39-41`）。
  验证：`grep -rn useEscapeFallback web/src web/test web/e2e` 只剩守卫里的注入样本；`npm test --workspace web` 与 `make ui-walk` 全绿（`ui-walk-project-config.ts` 的「打开时焦点在 `关闭`」步骤仍通过）。（未取此分支时：在本条后注明「未取，见 3.1 的结果表」并勾选。）
  **未取，见 3.1 的结果表**（#1399 的 PR，2026-10-13）：十处里三处不通过——顶栏入口的重命名、项目配置弹层、窄屏工作空间侧边栏模态层；触发器的 tooltip 还在退出动画里时紧接着按下的 Escape 被 tooltip 层吃掉。取 3.3。
- [x] 3.3 分支二——任一处不通过：撤销 3.1(a) 的改动，10 处调用**全部**保留、原样不动（不做局部删除）；`web/src/ui/escape-fallback.ts` 的头注释与 2.6 改过的另五处注释改写为实测得到的真实原因与需要它的覆盖层（不再提 Toast）；文件留在原处，组 4 搬到 `web/src/components/escape-fallback.ts`。`web/test/escape-fallback.test.tsx` 保留（兜底三条性质的常驻证据）。
  不通过的现象必须留下常驻证据，二者必居其一：jsdom 能复现的，补一条单测（先红后绿：去掉该调用点的 hook 时红，保留时绿），放在该覆盖层既有的测试文件里；只在真实浏览器复现的，把 3.1(d) 里对应的那一步固化为 `make ui-walk` 的常驻步骤（放进该覆盖层所在页面的走查文件，两个 project 里它适用的那个），同样先红后绿。
  验证：补的用例或走查步骤在去掉该调用点的 hook 时判红；`npm test --workspace web` 与 `make ui-walk` 全绿。（未取此分支时：在本条后注明「未取，见 3.1 的结果表」并勾选。）
- [x] 3.4 兜底去留的守卫（规格场景「兜底只有两种合法终态」；design D11 的 G1）：在 `web/test/ui-layering.test.ts` 加一个吃「文件列表 + 内容」的纯判定函数，接受且只接受两种状态——`useEscapeFallback` 在 `web/src` 的 `.ts`/`.tsx` 里完全不出现；或它的定义（`export function useEscapeFallback`）恰一处、在指定路径。
  取 3.2 时：对真实仓库断言前一种，且 `web/src/ui/escape-fallback.ts` 不存在——这就是终态，组 4、组 6 不再改它。取 3.3 时：对真实仓库断言后一种，指定路径暂为 `web/src/ui/escape-fallback.ts`（过渡），组 4 搬家时改为 `web/src/components/escape-fallback.ts`。
  验证：注入样本各判失败——`web/src/features/chat/x.ts` 里定义同名函数；定义出现在指定路径之外的第二处；（取 3.2 时）某个文件调用 `useEscapeFallback`。两种合法状态各有一个样本判通过。
- [x] 3.5 记录：3.1 的结果表与所取的分支写进 PR 描述；在 ADR-0013 的本 change 增补里补一条——Escape 实测的方法、十个调用点的结论与所取分支（保留时写明是哪个覆盖层、什么现象、常驻证据是哪条用例或走查步骤）。
  验证：ADR 增补里能找到十个调用点的结论；ui-primitives「覆盖层的 Escape 关闭」的场景各有对应的测试或走查步骤，在 PR 里列出对应关系——「保留兜底时不重复、不抢输入法」对 `web/test/escape-fallback.test.tsx`（取 3.2 时写「不适用，hook 已删除」），「兜底只有两种合法终态」对 3.4。
- [x] 3.6 变异证据（逐条做、逐条撤销，结果贴进 PR）：
  取 3.2 时：恢复 `web/src/ui/escape-fallback.ts` → 冻结清单断言与 3.4 的守卫判红；在 `project-config.tsx` 去掉 `onOpenAutoFocus` 里定位 `关闭` 的那段 → `chat-page-project-config-dialog.test.tsx` 或 `ui-walk-project-config.ts` 的初始焦点断言判红（没有就补一条再做这条变异）。
  取 3.3 时：去掉 3.3 点名的那个调用点的 hook → 3.3 补的用例或走查步骤判红；去掉 `escape-fallback.ts` 的 `handled` 判断、`isComposing` 判断、`contains` 判断 → `web/test/escape-fallback.test.tsx` 各判红（与 1.2 相同的三条，在改过头注释的文件上重做一遍）；在 `web/src/features/chat/x.ts` 里另定义一个 `useEscapeFallback` → 3.4 的守卫判红。
- [x] 3.7 整刀验证：`make check`、`make test-guardrails`、`make ui-walk` 全绿；`npm run build --workspace web` 成功。

Suggested fixture level: expanded - 触及十处覆盖层的键盘关闭行为；有两个由实测决定的分支，结论（十行结果表、所取分支、常驻证据）要可审计
Minimal mergeable slice: atomic - 实测的改动与所取分支的终态落在同一批 10 处调用上：实测本身不产生可合入的代码（design D4 不许合入「hook 被掏空」的中间态），可合入的只有「全删」或「全留并写明原因」之一，连同它的守卫与 ADR 记录；再拆就只剩一个没有代码的 PR

## 4. ui-foundation / ui-primitives — 搬 `Icon`、`IconName`、`BrandMark`，改导入方（子 issue C1）

- [x] 4.1 搬文件、改导入（design D1、D2、D17）：`git mv web/src/ui/icon.tsx web/src/components/icon.tsx`、`git mv web/src/ui/brand-mark.tsx web/src/components/brand-mark.tsx`，文件内容不改；若组 3 取了 3.3，`git mv web/src/ui/escape-fallback.ts web/src/components/escape-fallback.ts`。删除 `web/src/ui/index.ts`，不新建统一出口。样式规则本组不动：`.ui-icon*`、`.ui-brand*` 仍在 `web/src/ui/ui.css`，类名没变，所以计算样式不变。
  改导入路径：`Icon` 的 32 个文件、`IconName` 的 8 个、`BrandMark` 的 4 个（去重后 36 个文件；名单见 #1393「清点一」，开工时以 `grep -rln 'ui/index' web/src` 为准），若保留 hook 再加它的 9 个导入方。各文件沿用自己现有的写法（别名 `@/components/icon` 或相对路径带 `.js`）。
  测试侧：`web/test/chat-stop-button.test.tsx:4`、`topbar-actions.test.tsx:13`、`ui-icon-brand.test.tsx:3` 改导入路径（若保留 hook，`web/test/escape-fallback.test.tsx` 同样）；`web/test/chat-module-layout.test.ts:147` 的样本字符串改为新路径。`ATTRIBUTION.md` lucide 条目里的 `web/src/ui/icon.tsx` 改为 `web/src/components/icon.tsx`。
  验证：`grep -rnE '/ui/index|"@/ui' web/src web/test web/e2e` 的命中恰为守卫里的注入样本——`ui-layering.test.ts` 的各行与 `ui-guardrails.test.ts:114`（预期命中，不要改）；`git diff -M --stat` 显示两个（或三个）文件为 100% 相似度的重命名；`web/test/ui-icon-brand.test.tsx` 不改断言即通过；`make typecheck` 通过。
- [x] 4.2 过渡守卫与自写共享文件的断言：`web/test/ui-layering.test.ts`——导入白名单清空（任何文件都不得从 `web/src/ui` 导入）、`FROZEN_FILES` 收缩为 `motion.css` 与 `ui.css`；新增 design D1/D2 的 (a)：两个文件存在于 `web/src/components/` 且不在拷入目录下；
  新增「没有统一出口」：`web/src/components/index.ts` 与 `index.tsx` 不存在（design D17），注入样本（文件列表里出现 `web/src/components/index.ts`）判失败；
  「拷入层门槛豁免」一组补 (c) 的两个样本（`src/components/**`、`src/components/icon.tsx` 写进排除项都不算精确）。
  `web/test/ui-guardrails.test.ts`——取色与内联 `style={` 的扫描对象由 `web/src/ui` 下的 `.tsx` 改为直接放在 `web/src/components/` 下的 `.tsx`（断言非空）；依赖方向一组补 (b) 的样本（`web/src/components/icon.tsx` 导入 `radix-ui` 判失败）。`web/src/ui` 下 `.css` 的取色扫描保留到组 6。
  若保留 hook：3.4 的守卫把指定路径改为 `web/src/components/escape-fallback.ts`，并断言 `web/src/ui/escape-fallback.ts` 不存在（终态，组 6 不再改）；(a)(b)(c) 各为 `escape-fallback.ts` 补一个样本。
  验证：两个守卫文件通过；(a)(b)(c) 与「没有统一出口」各有注入样本用例。
- [x] 4.3 变异证据（逐条做、逐条撤销，结果贴进 PR）：在 `web/src/components/icon.tsx` 加 `import { Slot } from "radix-ui"` → 依赖方向守卫判红；在 `web/vitest.config.ts` 的 `coverage.exclude` 加 `src/components/icon.tsx` → 「豁免路径精确」判红；
  在 `web/src/features/chat/composer.tsx` 加 `import { Icon } from "../../ui/index.js"` → 分层守卫判红；新建 `web/src/components/index.ts`（再导出 `Icon`）→ 「没有统一出口」判红；
  若保留 hook：把 `web/src/components/escape-fallback.ts` 复制回 `web/src/ui/escape-fallback.ts` → 3.4 的守卫判红。
- [x] 4.4 整刀验证：`make check`（含覆盖率——搬入的文件计入统计）、`make test-guardrails`、`make ui-walk` 全绿（图标的 `display` 探针 `ui-walk-files.ts:14-24` 不改即通过）；`npm run build --workspace web` 成功。

Suggested fixture level: compact - 两个（或三个）文件 100% 相似度的重命名加 36 个以上文件的导入路径替换，样式规则不动；正确性由类型检查、`git diff -M` 与不改断言的 `ui-icon-brand` 证明，风险在守卫样本
Minimal mergeable slice: atomic - `git mv`、导入方改路径与删除 `ui/index.ts` 必须同刀：只搬不改导入，类型检查红；想分批改导入就得让 `ui/index.ts` 暂时再导出新位置的组件，那正是 design D17 不许建的统一出口；守卫（`ui-guardrails:46-56` 的非空断言）在文件搬走的同时变红

## 5. ui-foundation — 活规则搬进 `theme.css` 的 `base` 块（子 issue C2）

- [x] 5.1 先写 `theme.css` `base` 块的守卫（红）：`web/test/ui-foundation-entry.test.ts` 按 design D11 的 G2 第四条改写 `borderBaselineViolations`——`@layer` 块恰为一个 `base`、第一条是边框色基线、块内选择器集合等于清单（清单按 design「逐规则去向」两张表列全）、块外的顶层规则块只有既有的五项（四条无花括号的 `@custom-variant` 声明不是规则块，不计）；
  `:282-290` 对 `legacy.css` 的 `body` 的断言改为对 `theme.css` `base` 块内 `body` 的断言（含 `font-size: 14px`、`line-height: 22px`，不含底色与文字色），块外的 `body` 仍只声明底色与文字色；`:299`「reduce 覆盖规则不在任何层里」的写法改为不依赖「文件里 `@layer` 只出现在它之前」。`base` 块里嵌套的 `@media (max-width: 760px)` 块单独断言（恰一个、只含 `body { overflow: auto; }`），不混进选择器清单；它在块内保持缩进，不要挪到行首——`:299` 与 `:295` 用 `^@media` 找文件顶层的 reduce 块。
  判定自证的变异表同步：原「缺边框色基线」「基线换层」「基线改色」「多一个入层块」四条保留并适配，新增「块内多一个选择器」「`button` 的 reset 挪到块外」两条。
  `themeViolations` 变异表里以 `body {` 为锚点的两条（「`.dark` 类」「多一个入层块」，都是 `theme.replace("body {", …)` 取首次匹配）改成只命中块外未分层的 `body`（行首匹配，如 `/^body \{/m`）：规则搬入后首个 `body {` 是块内缩进的那条，不改的话变异打进块内、同时触发选择器清单判定，不再是「恰一条违例」。「hex 字面量」「oklch 字面量」两条的锚点（`var(--background)`、`var(--foreground)`）在被搬的规则里不出现，不用改。
  验证：此时该文件判红（规则还没搬）；5.2 之后变异表里每条变异恰好只触发它对应的那一条判定（含改过锚点的两条）。
- [x] 5.2 搬规则（design D7 与「逐规则去向」表）：把 `web/src/ui/ui.css:18-78`（`.ui-icon`、五个 `.ui-icon-<size>`、五条 `.ui-brand*`）与 `web/src/styles/legacy.css:10-127` 的全部规则**逐字**移进 `web/src/styles/theme.css` 的 `@layer base` 块，次序为：边框色基线、`ui.css` 的规则、`legacy.css` 的规则（各自内部顺序不变，760px 的媒体块留在最后）。
  从 `ui.css` 与 `legacy.css` 里删掉被搬走的规则（`ui.css` 只剩 `.ui-sr-only`，`legacy.css` 只剩文件头与两条 `@import`）。
  注释同步：`theme.css` 文件头与边框色基线上方的注释（不再提 `web/src/ui` 与「低于 `legacy`」）、`web/src/features/chat/tool-call-group.tsx:13`（「`legacy` 层的全局 `:focus-visible`」→ `base` 层）、`web/src/features/chat/message-action-row.tsx:116-117`（「冻结的图标注册表」）、`web/e2e/ui-walk-login.ts:34`。
  验证：5.1 的守卫转绿；`git diff` 里被搬的每条规则在删除侧与新增侧除缩进外逐字相同；`web/test/ui-tokens.test.ts`（未定义的 `--wb-*` 引用）与 `ui-reduced-motion.test.ts` 通过；`make ui-walk` 全绿（层序探针此时仍在、仍应通过）。
- [x] 5.3 计算样式比对（design D15，验收的硬条件）：一次性 Playwright 脚本按 D15 的十四项探针清单输出——亮暗两种主题 × 1440×900 与 390×844 两种视口，每个探针输出全部计算属性。每次运行都是独立构建、独立起服务，不是对着同一个运行中的服务比。
  (a) **A/A 对照**：基线（组 4 合入后的 `master`）独立跑两遍，两份输出做 diff。为空则排除清单为空；不为空则逐个列出不稳定的「探针 × 属性」作为排除清单。被搬的规则声明过的属性（两张去向表里那些规则的属性名）不得进排除清单——它们抖动就固定该探针的数据或等待条件，重跑 A/A 直到它们稳定。
  (b) **A/B**：基线与本分支各跑一遍，去掉 (a) 的排除清单后做 diff。
  验证：A/B 的 diff **为空**；A/A 的原始 diff、排除清单与 A/B 的 diff 三样都贴进 PR；排除清单只来自 A/A，不得根据 A/B 的差异增补；读不到计算值的三条滚动条规则以搬运前后规则文本逐字相同代替并注明；靠注入元素读取的探针逐个注明。
  A/B 非空则不合入——先查原因，属于本刀引入的差异就修正搬运，不调整探针、不扩排除清单。
- [x] 5.4 变异证据（逐条做、逐条撤销，结果贴进 PR）：把 `theme.css` `base` 块里的 `.ui-icon` 规则挪到块外（未分层）→ 5.1 的守卫判红；在块内加一条 `.ui-new { margin: 0 }` → 判红；
  把块内 `button { … }` 的 `padding: 0` 挪到块外 → 守卫判红，且 `make ui-walk` 的登录页断言或 5.3 的脚本显示按钮内边距变化（证明「不能未分层」不是空话，也证明 5.3 的脚本看得见差异；记录现象后撤销）。
- [x] 5.5 整刀验证：`make check`、`make test-guardrails`、`make ui-walk` 全绿（层序探针此时仍在、仍应通过）；`npm run build --workspace web` 成功。

Suggested fixture level: expanded - 改全站共用的样式入口链（全局规则换层），每个页面的层叠结果都在影响面内；「计算样式不变」要有 A/A 与 A/B 两份逐探针的证据
Minimal mergeable slice: atomic - 守卫（5.1）在规则搬完（5.2）之前是红的；规则必须整批搬——design D7 的层叠论证以「`ui.css` 的规则在前、`legacy.css` 的规则在后、同处一层」为前提，分批搬会让一部分在 `base`、一部分在 `legacy`，相对次序要另行证明；5.3 是对整批搬运的验收，没有可以先行合入的一半

## 6. ui-foundation — 删除旧样式层，守卫改为终态，文档收尾（子 issue D）

- [x] 6.1 先把三个守卫改成终态断言（红），再删文件。`web/test/ui-foundation-entry.test.ts`（design D11 的 G2）：`LAYER_ORDER` 改为 `@layer theme, base, components, utilities;`；`ENTRY_IMPORTS` 去掉 `legacy.css` 一条（剩七条）；去掉 `LEGACY`、`UI_BARREL` 常量；
  「其余既有 `.css` 只被 `legacy.css` 导入」一条改为「`web/src` 下的 `.css` 恰为 `styles.css`、`styles/tokens.css`、`styles/theme.css`，后两个不含 `@import`」；「文件页样式已退出 legacy 层」一条改为「`web/src/features/files` 下没有 `.css`，`web/src/styles/legacy.css` 不存在」；
  入口结构的判定自证变异表改为：层声明里加回 `legacy`、加回 `@import "./styles/legacy.css" layer(legacy);`、`tokens.css` 入层、类名扫描范围放开、多一条 `@import`、reduce 块入层、`web/src/features` 下出现一个 `.css`（样本路径）。
  验证：此时该文件判红；变异表每条都判失败。
- [x] 6.2 `web/test/ui-layering.test.ts`（G1）：删除 `MIGRATED_AREAS`、`MIGRATED_ALLOWED_IMPORTS`、`FROZEN_FILES` 与 `areaEntryViolations`；「组件分层」一组改为终态——`web/src/ui` 下没有文件、没有模块从解析到 `web/src/ui` 的路径导入（保留现有的导入识别式与它的自证用例：别名、多行、`type`、`as`、命名空间、副作用、动态、再导出）、`web/src` 下不出现标识符 `useToast` 与 `ToastProvider`、自写共享组件的位置与「没有统一出口」（4.2 已加）、兜底的两种合法终态（3.4 / 4.2 已加；本条只确认它还在、指定路径是 `web/src/components/escape-fallback.ts` 或「不出现」）；
  「会话页迁移终态」去掉「每个文件都已登记」与对 `legacy.css` 的读取，保留「没有 `.css`、没有 `session-filter.tsx`」与 `assistant-ui` 目录的文件清单；
  「显式列表语义」的扫描范围由「已迁移区域的 `.tsx`」改为「`web/src` 下除两个拷入目录之外的全部 `.tsx`」（design D10），「确有四个带 `list-none` 的文件」的非空断言保留。
  验证：此时「`web/src/ui` 下没有文件」判红（目录还在）；其余用例通过；注入样本 `web/src/ui/card.tsx`、`import { Button } from "../../ui/index.js"`、`useToast` 导入、`web/src/features/chat/chat.css`、`web/src/ui/escape-fallback.ts`、`web/src/components/index.ts` 各判失败。
- [x] 6.3 `web/test/ui-guardrails.test.ts`（G3）：`RADIX_ALLOWED_DIRS` 去掉 `web/src/ui/`；`:137` 的样本改为 `isApplicationLayer("web/src/ui/dialog.tsx")` 为 `true`；取色扫描去掉 `web/src/ui` 的 `.css` 一组（对象为 features、routes、直接放在 `web/src/components/` 下的 `.tsx`，三组都断言非空），相应的用例标题与注释改写；删除 `motion.css` 一组。
  验证：依赖方向与取色两组通过；注入样本（features 下的文件导入 `@radix-ui/react-dialog`、`web/src/ui/x.tsx` 导入 `radix-ui`）各判失败。
- [x] 6.4 删除旧样式层：`web/src/styles/legacy.css`、`web/src/ui/ui.css`、`web/src/ui/motion.css`（`web/src/ui/` 目录随之消失）；`web/src/styles.css` 的层声明改为 `@layer theme, base, components, utilities;`、去掉 `@import "./styles/legacy.css" layer(legacy);`、头注释改写（不再提 `legacy` 层与 `legacy.css`，写明全局基础规则在 `theme.css` 的 `base` 块）。
  验证：`test ! -e web/src/ui && test ! -e web/src/styles/legacy.css`；`find web/src -name '*.css'` 恰为三个文件；6.1–6.3 的守卫全部转绿；`npm run build --workspace web` 成功。
- [x] 6.5 读 `legacy.css` 的五处断言改为读 `web/src/styles/theme.css`，断言内容不变（「不含某旧规则 / 某导入」，design D14）：`web/test/chat-steps.test.tsx:133`、`login-form.test.tsx:275`、`settings-footer.test.tsx:539`、`sidebar.test.tsx:398`、`topbar.test.tsx:276`（该处的路径清单里把 `legacy.css` 换成 `theme.css`）；用例标题里的 `legacy` 字样同步。
  验证：`grep -rn 'legacy\.css' web/test web/e2e` 只剩守卫里「该文件不存在」的断言与注入样本；`npm test --workspace web` 通过。
- [x] 6.6 走查：删除 `web/e2e/ui-walk-files.ts` 的 `expectLegacyOverPreflight`（连同它上方三行注释），以及 `web/e2e/ui-walk-layout.ts` 里对它的导入与调用（`:5`、`:198`，`:190` 的注释去掉「与层序探针」）。本组不新增走查步骤（整个 change 里唯一可能新增的一步在 3.3：取保留分支且现象只在真实浏览器复现时；它若存在，本组不动它）。
  验证：`grep -rn 'LegacyOverPreflight\|legacy' web/e2e` 零命中；`make ui-walk` 两个 project 全绿。
- [x] 6.7 文档（design D18）：`AGENTS.md:164` 去掉「与冻结区 `web/src/ui/`」（改后仍是 Enforcement Index 说明段之后、`Known blind spots` 之前唯一一行同时点名两个拷入目录与 ADR-0013 的注记）；
  `constraints.yaml:173` 与 `:178` 的 `exit_condition` 把「应用层与冻结区门槛不变」改为「应用层门槛不变」；
  `IMPLEMENTATION_PLAN.md`：`:149`（F-UI-7 的「`web/src/ui` 自有基元退役」标明已由本 change 完成）、`:163`（「不再新增 `web/src/ui` 基元」改为该目录已删除、自写共享组件放 `web/src/components/`）、`:354`（后续第 1 条标为已完成，指向 #1393）；
  ADR-0013 的本 change 增补补上终态：旧基元层与 `legacy` 层已删除、`web/src` 只剩三个样式文件、全局基础规则与 `ui-*` 类在 `theme.css` 的 `base` 块里及其理由（design D7）、分层守卫改为终态断言、七个 Radix 单包已卸载。
  验证：`grep -rnE '冻结区|web/src/ui|legacy\.css|layer\(legacy\)' AGENTS.md constraints.yaml ATTRIBUTION.md IMPLEMENTATION_PLAN.md web/src web/e2e` 的命中只剩对历史的记述（逐条在 PR 里说明）；`web/test/ui-layering.test.ts` 的 `AGENTS.md` 与 `constraints.yaml` 两条用例通过；`make test-guardrails` 通过（`scripts/test-ci-harness.sh` 没有镜像被改动的文本，design D18 已核对，开工时再 grep 一次）。
- [x] 6.8 变异证据（对真实文件逐条做、逐条撤销，结果贴进 PR）：
  新建 `web/src/ui/card.tsx` → `ui-layering` 判红；
  新建 `web/src/features/chat/x.css` → `ui-foundation-entry` 的「样式文件恰为三个」与 `ui-layering` 的会话页终态都判红；
  在 `web/src/styles.css` 的层声明里加回 `legacy`，或加回 `@import "./styles/legacy.css" layer(legacy);` → `ui-foundation-entry` 各判红；
  在 `web/src/features/files/tree.tsx` 加 `import * as Dialog from "@radix-ui/react-dialog"`（已卸载的单包）或 `import { Dialog } from "radix-ui"` → `ui-guardrails` 的依赖方向守卫各判红（前者在应用层另由 knip 判红；**实施更正**：原文写「另由类型检查判红」，实测不成立——该单包仍是 `radix-ui` 的传递依赖，`make typecheck` 退出码 0；同一导入写在拷入层之内时没有任何东西拦，见 design D11 的更正）；
  在 `web/src/features/chat/composer.tsx` 加 `import { useToast } from "@/components/toast"` → `ui-layering` 判红；
  在 `web/src/features/chat/todo-panel.tsx` 去掉 `role="list"` → 显式列表语义守卫判红；
  把 `theme.css` 的 `@layer base` 改名为 `@layer components` → `ui-foundation-entry` 判红；
  新建 `web/src/ui/escape-fallback.ts`（内容为 `export function useEscapeFallback() {}`）→ 「`web/src/ui` 下没有文件」与兜底终态守卫都判红。
- [x] 6.9 归档时改 Purpose——**执行者是编排方，在归档提交里做（或紧随其后的一个文档提交）；不属于本组的 PR，实现本组的人不做、不勾**（design D21；先例 `6996028a`）：归档把 delta 并入主规格之后，改两份主规格的 `## Purpose`——`openspec/specs/ui-foundation/spec.md` 去掉「frozen-zone split with its migrated-area guard」，改述为拷入层 / 应用层两层与自写共享组件；
  `openspec/specs/ui-primitives/spec.md` 去掉「`web/src/ui/` 基元层」「以 Radix UI Primitives 为行为层的组件库」，改述为设计 token、图标与品牌标记、动效约束与覆盖层的键盘关闭。
  验证：两个 CLI 的 `openspec validate --specs --strict` 通过；`grep -n 'web/src/ui\|frozen' openspec/specs/ui-foundation/spec.md openspec/specs/ui-primitives/spec.md` 的命中只剩条文里对「已不存在」的陈述。编排方做完后勾选本条；Epic #1393 的收尾清单里单列这一步。
- [x] 6.10 收尾验证：逐条核对 #1393 的七条验收标准并在 PR 里给出各自的证据（命令输出或测试名）；`make check`、`make test-guardrails`、`make ui-walk` 全绿；
  `$HOME/.nvm/versions/node/v24.13.1/bin/openspec validate s1f-legacy-layer-removal --strict --no-interactive` 与 `$HOME/.local/bin/openspec validate s1f-legacy-layer-removal --strict --no-interactive` 都通过；本文件的任务**除 6.9 外**全部勾选（3.2 / 3.3 中未取的一条带「未取」注记；6.9 留给归档）。

Suggested fixture level: expanded - 改唯一的样式入口（层声明与导入）并重写三个守卫——它们是此后整个前端分层的判据；另含 `AGENTS.md`、`constraints.yaml` 的条文改动
Minimal mergeable slice: atomic - 删除 `legacy.css` 与 `legacy` 层、三个守卫里断言它们存在的常量、读 `legacy.css` 的五个测试与走查探针必须同刀：文件一删，这些断言立即变红；先改守卫不删文件同样是红的。文档（6.7）随同一 PR；6.9 由编排方在归档时做
