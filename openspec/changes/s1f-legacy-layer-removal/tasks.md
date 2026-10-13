# Tasks: s1f-legacy-layer-removal

> 前置：`s1f-session-list-temp-space`（C）与 `s1f-files-page`（D）已归档，代码都在 `master`。当前没有别的进行中的 change，不需要跨 change 的规格对底。
>
> 跟踪：#1393 是 Epic；下面四个组各是一个子 issue、一个 PR（design D6）。
>
> 依赖（「A ← B」读作「A 的前提是 B」）：
> - 组 2 ← 组 1；组 3 ← 组 2；组 4 ← 组 3。线性，不并行（design D9：三刀都改 `web/test/ui-layering.test.ts` 里同一组常量；组 3 搬的规则与组 4 删的文件是同一批）。
> - 组内按编号顺序。唯一的分叉在组 2：2.6 与 2.7 二选一，由 2.5 的实测结果决定；组 3 的 3.1、3.2 里凡带「若保留」的部分只在取了 2.7 时执行。
> - 4.9（主规格的 Purpose）在归档时做，不在组 4 的 PR 里。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行。
> - **不改变任何页面的视觉与行为**（design Non-Goals）：不改使用处的类名，不改 `Icon` / `BrandMark` 的源码内容（只搬位置），不给搬运的规则去重或修正，不碰两个拷入目录。发现非改不可的地方，停下来报告，不自行放宽。
> - 组 1–3 的守卫改动是**过渡断言**（清单逐刀收缩）；规格 delta 描述的是组 4 之后的终态。过渡断言不许放空：清单类断言同时断言长度与「目录里的每个文件都在清单里」。
> - 既有断言只要还有意义就不删除、不削弱；随代码删除而删除或改写的断言，在 PR 的偏离记录里逐条列出，并写明被删的测试文件里有没有与已删代码无关的用例、它们去了哪里（design D14）。
> - 任务里点名的 `文件:行` 是在 `51ffffb3` 上 grep 的结果。每一刀开工时先重跑该任务给的 grep；命中而未点名的依赖，在**让它变红的那一刀**里按同样的规则处置并记入偏离记录，不留到后一个 PR。
> - 移除依赖的 PR（组 1、组 2）在描述里显式标注依赖变更（`AGENTS.md`「依赖政策」）。
> - 一次性脚本（2.5 的补测、3.5 的计算样式比对）写在系统 scratchpad，不入库；它们的输出贴进 PR。
> - 不实现 design 的 Non-Goals：不设包体上限、不引入通知机制、不把 `ui-*` 类改写成 Tailwind 类、不把 `ui-btn` 纳入旧类扫描。

## 1. ui-primitives / ui-foundation — 删除没有调用方的旧基元（子 issue A）

- [ ] 1.1 开工核对：在分支基线上重跑清点，确认 24 个待删文件在 `web/src`（不含 `web/src/ui/` 自身）里没有导入方，8 个待删测试文件只导入这些基元。
  命令：`grep -rnE 'from "[^"]*/ui/(index|[a-z-]+)(\.js)?"|from "@/ui(/[a-z-]+)?"' web/src web/test | grep -v '^web/src/ui/' | grep -v components/ui`，逐行核对具名导入里只剩 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`、`ToastProvider`、`useToast`（测试文件里另有待删的八个）。
  验证：核对结果（与 design「Context」的数字是否一致、有无新增导入方）写进 PR；有出入先改本 change 的 design 与本组任务再继续。
- [ ] 1.2 删除 24 个文件：`web/src/ui/` 下的 `button.{tsx,css}`、`chip.{tsx,css}`、`confirm-dialog.tsx`、`dialog.{tsx,css}`、`drawer.tsx`、`empty-state.{tsx,css}`、`input.{tsx,css}`、`menu.{tsx,css}`、`popover.{tsx,css}`、`segmented-control.{tsx,css}`、`switch.{tsx,css}`、`tag.{tsx,css}`、`tooltip.{tsx,css}`。
  `web/src/ui/index.ts` 只留四行导出（`BrandMark`、`useEscapeFallback`、`Icon` 与 `IconName`、`ToastProvider` 与 `useToast`）；`web/src/ui/ui.css` 的 `@import` 只留 `./toast.css`，其下的规则不动。
  验证：`ls web/src/ui` 恰为 8 个文件（`brand-mark.tsx`、`escape-fallback.ts`、`icon.tsx`、`index.ts`、`motion.css`、`toast.css`、`toast.tsx`、`ui.css`）；`make typecheck` 通过。
- [ ] 1.3 删除只测这些基元的 8 个测试文件：`web/test/ui-dialog.test.tsx`、`ui-dialog-busy.test.tsx`、`ui-empty-state.test.tsx`、`ui-escape-dispatch.test.tsx`（它导入旧 `Dialog` / `ConfirmDialog` / `Drawer`，所以在这一刀而不是组 2）、`ui-form.test.tsx`、`ui-menu.test.tsx`、`ui-popover-tooltip.test.tsx`、`ui-segmented-control.test.tsx`。
  `web/test/app-shell-responsive.test.tsx:560-563`（读 `web/src/ui/drawer.tsx` 的属性键）删除这四行，同一用例的其余断言不动。
  验证：`npm test --workspace web` 通过且覆盖率门槛仍满足；`grep -rn 'ui/drawer\|ui/dialog\|ui/button' web/test` 只剩 `ui-layering.test.ts` 里的字符串样本；偏离记录逐个文件写明「没有与已删基元无关的用例」或列出例外。
- [ ] 1.4 过渡守卫：`web/test/ui-layering.test.ts` 的 `FROZEN_FILES` 收缩为 1.2 留下的 8 个文件名，「冻结清单恰为 32」改为 8，注释同步；
  `web/test/ui-reduced-motion.test.ts:148` 去掉「声明非 `none` 过渡的规则集合非空」（声明过渡的六个样式文件全部在 1.2 删除），保留对 `violations` 为空的断言与两条判定自证用例（它们用注入样本，证明守卫没有放空）。
  验证：两个测试文件通过；在 `web/src/ui/` 下临时放回一个 `button.tsx` → `ui-layering` 判红（做完撤销）。
- [ ] 1.5 依赖：从 `web/package.json` 移除 `@radix-ui/react-dialog`、`react-dropdown-menu`、`react-popover`、`react-radio-group`、`react-switch`、`react-tooltip` 六个（保留 `@radix-ui/react-toast` 与合包 `radix-ui`），`npm install` 更新根 `package-lock.json`；
  `ATTRIBUTION.md` 的「Radix UI Primitives」条目把已安装单包的列举改为只剩 `@radix-ui/react-toast`。
  验证：`grep -c '@radix-ui/react-' web/package.json` 为 1；`web/test/ui-guardrails.test.ts` 的 `ATTRIBUTION.md` 一组通过；`make anti-drift`（knip）没有未使用或未登记的依赖；PR 描述标注依赖变更。
- [ ] 1.6 变异证据（逐条做、逐条撤销，结果贴进 PR）：`git checkout` 放回 `web/src/ui/chip.tsx` → `ui-layering` 的冻结清单断言判红；
  给 `web/src/ui/toast.css` 加一条 `transition: opacity 0.2s` 而不加 reduce 覆盖 → `ui-reduced-motion` 判红；
  在 `web/src/features/chat/composer.tsx` 加 `import { Root } from "@radix-ui/react-dialog"` → `ui-guardrails` 的依赖方向守卫判红；
  把 `@radix-ui/react-dialog` 加回 `web/package.json` 而不登记 → `ATTRIBUTION.md` 守卫判红。
- [ ] 1.7 整刀验证：`make check`、`make test-guardrails`、`make ui-walk`（两个 project）全绿；`npm run build --workspace web` 成功。

Suggested fixture level: compact - 只删没有导入方的代码与只测它们的测试；没有运行期行为变化，风险在过渡守卫与依赖登记，由变异证据与 knip 覆盖
Minimal mergeable slice: atomic - 24 个文件经 `ui/index.ts`、`ui.css`、`FROZEN_FILES` 三处与 6 个依赖声明互相牵连：按基元分批删要把这三处各改多遍，每一批的验证路径都是同一条 `make check`，分批没有独立价值；依赖必须与最后一个导入方同刀移除，否则 knip 判红

## 2. ui-primitives — 删除 Toast，实测 Escape 并落分支（子 issue B）

- [ ] 2.1 先搬后删（design D14）：把三个 Toast 测试文件里**与 Toast 无关**的用例先搬到新家，去掉其中 Toast 的搭建：
  `web/test/ui-toast-drawer-escape.test.tsx` 的 D5（`导航` 覆盖层内打开用户菜单，Escape 只关菜单，再按一次才关覆盖层）→ `web/test/app-shell-responsive.test.tsx`；
  `web/test/auth-footer-toast-escape.test.tsx` 的两例去掉 Toast 之后的形态（宽屏：Escape 关闭确认框、不发起退出、焦点回 `用户菜单`；窄屏：`导航` 覆盖层内打开的确认框，一次 Escape 只关确认框、覆盖层保持打开）→ `web/test/auth-footer-focus.test.tsx`。
  目标文件加上之后接近 800 行就另建一个文件（如 `web/test/overlay-escape.test.tsx`）。
  验证：搬来的用例在删除 Toast **之前**就通过（它们不依赖 Toast）；它们对应 ui-primitives「覆盖层的 Escape 关闭」的场景「嵌套层只关最内一层」。
- [ ] 2.2 删除 Toast：`web/src/ui/toast.tsx`、`web/src/ui/toast.css`；`web/src/ui/index.ts` 去掉 `ToastProvider` / `useToast` 一行；`web/src/ui/ui.css` 去掉最后一条 `@import`；`web/src/main.tsx` 直接渲染 `<RouterProvider router={router} />`。
  从 `web/package.json` 移除 `@radix-ui/react-toast` 并更新根 `package-lock.json`。`ATTRIBUTION.md`：「Radix UI Primitives」条目的用途改写为「经合包 `radix-ui` 供拷入层使用，不再直接安装单包」（条目与 MIT 义务保留）；`radix-ui` 条目删去「与上条保留的各 `@radix-ui/*` 单包并存到旧基元层退役」一句。
  验证：`grep -rn 'useToast\|ToastProvider' web/src` 零命中；`grep -c '@radix-ui/' web/package.json` 为 0；`make typecheck` 通过；PR 描述标注依赖变更。
- [ ] 2.3 测试与走查里的 Toast：删除 `web/test/ui-toast.test.tsx`、`ui-toast-drawer-escape.test.tsx`、`auth-footer-toast-escape.test.tsx`（2.1 已搬走该留的用例）；`web/test/chat-workspace-sidebar-narrow.test.tsx` 删除「屏上有 Toast 时的 Escape」一组（N3）与随之无用的导入，N1、N2、N4 不动；
  去掉其余 8 个文件里的 `ToastProvider` 包装：`chat-page-lifecycle-support.tsx`、`chat-page-shell-support.tsx`、`previewers-archive.test.tsx`、`previewers-media.test.tsx`、`previewers-table-svg.test.tsx`、`render-app-router.tsx`、`routes.test.tsx`、`settings-support.tsx`。
  `web/e2e/ui-walk-session-list.ts:98` 与 `:356` 的 `.ui-toast` 计数断言删除（同处「页面上不出现某文本」的断言保留）。
  验证：`grep -rn 'ToastProvider\|useToast\|ui-toast' web/test web/e2e` 只剩 `ui-layering.test.ts` 里的注入样本；`npm test --workspace web` 通过。
- [ ] 2.4 这一步让它们变红的过渡守卫：`web/test/ui-foundation-entry.test.ts:106`（带 `@import` 的既有样式文件由恰为 `ui.css` 改为没有）；
  `web/test/ui-guardrails.test.ts:224` 去掉「已安装的 `@radix-ui/*` 单包数大于 0」，保留「每个已安装单包都在 `ATTRIBUTION.md` 登记」的循环与「标题含 `Radix` 的 MIT 条目存在」；
  `web/test/ui-layering.test.ts` 的 `FROZEN_FILES` 收缩为 6 个（`brand-mark.tsx`、`escape-fallback.ts`、`icon.tsx`、`index.ts`、`motion.css`、`ui.css`），长度断言同步。
  验证：三个守卫文件通过；`make anti-drift` 通过。
- [ ] 2.5 Escape 实测（design D4；在 2.2–2.4 之后的同一分支上做，实测用的改动不单独提交）：
  (a) 把 9 个文件里 10 处 `useEscapeFallback` 调用接到内容元素上的 `onEscapeKeyDown` 与 `onKeyDown` 两个属性去掉，`ref` 保留；
  (b) 跑 `npm test --workspace web`，对照 design D4 的表逐个调用点确认按 Escape 的既有用例（连同 2.1 搬来的三例）全部通过——除 2.3 已做的去包装之外不许改任何断言；
  (c) 跑 `make ui-walk` 两个 project；
  (d) 对走查没有 Escape 步骤的七处调用（退出确认框、重命名 / 另存为工作空间、会话删除确认框、撤回冲突确认框、`全部自动` 确认框、文件的创建 / 重命名 / 移动对话框、文件删除确认框），用一次性 Playwright 脚本在真实浏览器里各打开一次、焦点在其内时按一次 Escape，断言它关闭且确认动作未触发；其中能嵌套的（工作空间侧边栏模态层里的文件对话框、`导航` 覆盖层里的退出确认框）另断言只关最内一层。
  验证：一张十行的结果表（调用点、单测、走查或补测、通过 / 不通过；不通过的写现象与复现步骤）。**任一处不通过或结果不稳定（同一步骤重复三次出现不同结果）即判「不通过」，取 2.7。**
- [ ] 2.6 分支一——十处全部通过：删除 `web/src/ui/escape-fallback.ts` 与 10 处调用；`footer.tsx:74`、`app-shell.tsx:52`、`dialogs.tsx:157` 三处借用其 `ref` 的地方换成 `useRef<HTMLDivElement>(null)`；`web/src/ui/index.ts` 去掉该导出；
  `web/test/ui-layering.test.ts` 的白名单去掉 `useEscapeFallback`、`FROZEN_FILES` 收缩为 5 个；各文件里提到「由 `useEscapeFallback` 兜底」的注释（`app-shell.tsx:42`、`workspace-sidebar.tsx:208`、`web/e2e/ui-walk-session-list.ts:39-41`）改写为现状。
  验证：`grep -rn useEscapeFallback web/src web/test web/e2e` 只剩守卫里的注入样本；`npm test --workspace web` 与 `make ui-walk` 全绿。（未取此分支时：在本条后注明「未取，见 2.5 的结果表」并勾选。）
- [ ] 2.7 分支二——任一处不通过：撤销 2.5(a) 的改动，10 处调用**全部**保留、原样不动（不做局部删除）；`web/src/ui/escape-fallback.ts` 的头注释改写为实测得到的真实原因与需要它的覆盖层（不再提 Toast）；文件留在原处，组 3 搬到 `web/src/components/escape-fallback.ts`。
  为不通过的那个现象补一条单测（先红后绿：去掉 hook 时红，保留时绿），放在该覆盖层既有的测试文件里。
  验证：补的用例在去掉该调用点的 hook 时判红；`npm test --workspace web` 与 `make ui-walk` 全绿。（未取此分支时：在本条后注明「未取，见 2.5 的结果表」并勾选。）
- [ ] 2.8 记录：2.5 的结果表与所取的分支写进 PR 描述；在 `docs/adr/0013-assistant-ui-frontend-rebuild.md` 末尾新增「增补（change `s1f-legacy-layer-removal`）」，本刀写两条——Toast 删除且不提供替代（owner 2026-10-12）、Escape 实测的方法、结果与所取分支（保留时写明是哪个覆盖层、什么现象）。
  验证：ADR 增补里能找到十个调用点的结论；ui-primitives「覆盖层的 Escape 关闭」的四个场景各有对应的测试或走查步骤（在 PR 里列出对应关系）。
- [ ] 2.9 变异证据：在 `web/src/features/chat/composer.tsx` 加一行 `useToast` 导入样本 → `ui-layering` 判红（既有自证用例覆盖，确认它仍在跑）；
  把 `@import "./toast.css";` 加回 `ui.css` → `ui-foundation-entry` 判红；
  取 2.6 时：恢复 `web/src/ui/escape-fallback.ts` → 冻结清单断言判红；取 2.7 时：去掉 2.7 点名的那个调用点的 hook → 2.7 补的用例判红；
  在 `web/src/routes/shell/app-shell.tsx` 的 `导航` 覆盖层上临时加一个「任何 Escape 都关闭覆盖层」的 document 监听 → 2.1 搬来的「覆盖层内菜单只关自己」用例判红（证明它确实断言了覆盖层仍在，不是空转）。
- [ ] 2.10 整刀验证：`make check`、`make test-guardrails`、`make ui-walk` 全绿；`npm run build --workspace web` 成功。

Suggested fixture level: expanded - 改应用入口（`main.tsx`）并触及十处覆盖层的键盘关闭行为；Escape 一项有两个由实测决定的分支，结论要可审计
Minimal mergeable slice: 2.1–2.4（删 Toast，`useEscapeFallback` 原样留着，hook 对没有 Toast 的页面无害）可以独立合并保绿；2.5–2.8 的实测与分支依赖它。按 owner 裁定四个子 issue、每个一个 PR（design D6），且实测必须在 Toast 删除后的同一分支上做，本组仍作为一个 PR 交付——Stage 5 若按首刀拆分，后半刀 Depends on 前半刀

## 3. ui-foundation / ui-primitives — 搬 `Icon`、`BrandMark` 与活着的规则（子 issue C）

- [ ] 3.1 搬文件、改导入（design D1、D2、D17）：`git mv web/src/ui/icon.tsx web/src/components/icon.tsx`、`git mv web/src/ui/brand-mark.tsx web/src/components/brand-mark.tsx`，文件内容不改；若组 2 取了 2.7，`git mv web/src/ui/escape-fallback.ts web/src/components/escape-fallback.ts`。删除 `web/src/ui/index.ts`，不新建统一出口。
  改导入路径：`Icon` 的 32 个文件、`IconName` 的 8 个、`BrandMark` 的 4 个（去重后 36 个文件；名单见 #1393「清点一」，开工时以 `grep -rln 'ui/index' web/src` 为准），若保留 hook 再加它的 9 个导入方。各文件沿用自己现有的写法（别名 `@/components/icon` 或相对路径带 `.js`）。
  测试侧：`web/test/chat-stop-button.test.tsx:4`、`topbar-actions.test.tsx:13`、`ui-icon-brand.test.tsx:3` 改导入路径；`web/test/chat-module-layout.test.ts:147` 的样本字符串改为新路径。`ATTRIBUTION.md` lucide 条目里的 `web/src/ui/icon.tsx` 改为 `web/src/components/icon.tsx`。
  验证：`grep -rnE '/ui/index|"@/ui' web/src web/test web/e2e` 只剩 `ui-layering.test.ts` 的注入样本；`git diff -M --stat` 显示两个（或三个）文件为 100% 相似度的重命名；`web/test/ui-icon-brand.test.tsx` 不改断言即通过；`make typecheck` 通过。
- [ ] 3.2 过渡守卫与两个文件的三项断言：`web/test/ui-layering.test.ts`——导入白名单清空（任何文件都不得从 `web/src/ui` 导入）、`FROZEN_FILES` 收缩为 `motion.css` 与 `ui.css`；新增 design D1/D2 的 (a)：两个文件存在于 `web/src/components/` 且不在拷入目录下；
  「拷入层门槛豁免」一组补 (c) 的两个样本（`src/components/**`、`src/components/icon.tsx` 写进排除项都不算精确）。
  `web/test/ui-guardrails.test.ts`——取色与内联 `style={` 的扫描对象由 `web/src/ui` 下的 `.tsx` 改为直接放在 `web/src/components/` 下的 `.tsx`（断言非空）；依赖方向一组补 (b) 的样本（`web/src/components/icon.tsx` 导入 `radix-ui` 判失败）。`web/src/ui` 下 `.css` 的取色扫描保留到组 4。
  验证：两个守卫文件通过；(a)(b)(c) 各有一条注入样本用例。
- [ ] 3.3 先写 `theme.css` `base` 块的守卫（红）：`web/test/ui-foundation-entry.test.ts` 按 design D11 的 G2 第四条改写 `borderBaselineViolations`——`@layer` 块恰为一个 `base`、第一条是边框色基线、块内选择器集合等于清单（清单按 design「逐规则去向」两张表列全）、块外的顶层规则只有既有的五项；
  `:282-290` 对 `legacy.css` 的 `body` 的断言改为对 `theme.css` `base` 块内 `body` 的断言（含 `font-size: 14px`、`line-height: 22px`，不含底色与文字色），块外的 `body` 仍只声明底色与文字色；`:299`「reduce 覆盖规则不在任何层里」的写法改为不依赖「文件里 `@layer` 只出现在它之前」。`base` 块里嵌套的 `@media (max-width: 760px)` 块单独断言（恰一个、只含 `body { overflow: auto; }`），不混进选择器清单；它在块内保持缩进，不要挪到行首——`:299` 与 `:295` 用 `^@media` 找文件顶层的 reduce 块。
  判定自证的变异表同步：原「缺边框色基线」「基线换层」「基线改色」「多一个入层块」四条保留并适配，新增「块内多一个选择器」「`button` 的 reset 挪到块外」两条。
  验证：此时该文件判红（规则还没搬）；变异表里每条变异恰好只触发它对应的那一条判定。
- [ ] 3.4 搬规则（design D7 与「逐规则去向」表）：把 `web/src/ui/ui.css:18-78`（`.ui-icon`、五个 `.ui-icon-<size>`、五条 `.ui-brand*`）与 `web/src/styles/legacy.css:10-127` 的全部规则**逐字**移进 `web/src/styles/theme.css` 的 `@layer base` 块，次序为：边框色基线、`ui.css` 的规则、`legacy.css` 的规则（各自内部顺序不变，760px 的媒体块留在最后）。
  从 `ui.css` 与 `legacy.css` 里删掉被搬走的规则（`ui.css` 只剩 `.ui-sr-only`，`legacy.css` 只剩文件头与两条 `@import`）。
  注释同步：`theme.css` 文件头与边框色基线上方的注释（不再提 `web/src/ui` 与「低于 `legacy`」）、`web/src/features/chat/tool-call-group.tsx:13`（「`legacy` 层的全局 `:focus-visible`」→ `base` 层）、`web/src/features/chat/message-action-row.tsx:116-117`（「冻结的图标注册表」）、`web/e2e/ui-walk-login.ts:34`。
  验证：3.3 的守卫转绿；`git diff` 里被搬的每条规则在删除侧与新增侧除缩进外逐字相同；`web/test/ui-tokens.test.ts`（未定义的 `--wb-*` 引用）与 `ui-reduced-motion.test.ts` 通过；`make ui-walk` 全绿（层序探针此时仍在、仍应通过）。
- [ ] 3.5 计算样式比对（design D15，验收的硬条件）：一次性 Playwright 脚本按 D15 的十四项探针清单，在基线（组 2 合入后的 `master`）与本分支上各跑一遍——两次各自构建、各起一个服务，不是对着同一个运行中的服务比——亮暗两种主题 × 1440×900 与 390×844 两种视口，每个探针输出全部计算属性。
  验证：两份输出的 diff **为空**，贴进 PR；读不到计算值的三条滚动条规则以搬运前后规则文本逐字相同代替并注明；靠注入元素读取的探针逐个注明。diff 非空则不合入——先查原因，属于本刀引入的差异就修正搬运，不调整探针。
- [ ] 3.6 变异证据：把 `theme.css` `base` 块里的 `.ui-icon` 规则挪到块外（未分层）→ 3.3 的守卫判红；在块内加一条 `.ui-new { margin: 0 }` → 判红；
  把块内 `button { … }` 的 `padding: 0` 挪到块外 → 守卫判红，且 `make ui-walk` 的登录页断言或 3.5 的脚本显示按钮内边距变化（证明「不能未分层」不是空话，记录现象后撤销）；
  在 `web/src/components/icon.tsx` 加 `import { Slot } from "radix-ui"` → 依赖方向守卫判红；在 `web/vitest.config.ts` 的 `coverage.exclude` 加 `src/components/icon.tsx` → 「豁免路径精确」判红；
  在 `web/src/features/chat/composer.tsx` 加 `import { Icon } from "../../ui/index.js"` → 分层守卫判红。
- [ ] 3.7 整刀验证：`make check`（含覆盖率——两个搬入的文件计入统计）、`make test-guardrails`、`make ui-walk` 全绿；`npm run build --workspace web` 成功。

Suggested fixture level: expanded - 改全站共用的样式入口链（全局规则换层）与 36 个以上文件的导入路径；「计算样式不变」要有逐探针的证据
Minimal mergeable slice: 3.1–3.2（搬两个组件与改导入，样式规则原地不动——类名没变，规则仍在 `ui.css`）可以独立合并保绿；3.3–3.6（规则换层与计算样式比对）随后。按 owner 裁定每个子 issue 一个 PR（design D6），本组作为一个 PR 交付——Stage 5 若按首刀拆分，后半刀 Depends on 前半刀

## 4. ui-foundation — 删除旧样式层，守卫改为终态，文档收尾（子 issue D）

- [ ] 4.1 先把三个守卫改成终态断言（红），再删文件。`web/test/ui-foundation-entry.test.ts`（design D11 的 G2）：`LAYER_ORDER` 改为 `@layer theme, base, components, utilities;`；`ENTRY_IMPORTS` 去掉 `legacy.css` 一条（剩七条）；去掉 `LEGACY`、`UI_BARREL` 常量；
  「其余既有 `.css` 只被 `legacy.css` 导入」一条改为「`web/src` 下的 `.css` 恰为 `styles.css`、`styles/tokens.css`、`styles/theme.css`，后两个不含 `@import`」；「文件页样式已退出 legacy 层」一条改为「`web/src/features/files` 下没有 `.css`，`web/src/styles/legacy.css` 不存在」；
  入口结构的判定自证变异表改为：层声明里加回 `legacy`、加回 `@import "./styles/legacy.css" layer(legacy);`、`tokens.css` 入层、类名扫描范围放开、多一条 `@import`、reduce 块入层、`web/src/features` 下出现一个 `.css`（样本路径）。
  验证：此时该文件判红；变异表每条都判失败。
- [ ] 4.2 `web/test/ui-layering.test.ts`（G1）：删除 `MIGRATED_AREAS`、`MIGRATED_ALLOWED_IMPORTS`、`FROZEN_FILES` 与 `areaEntryViolations`；「组件分层」一组改为终态——`web/src/ui` 下没有文件、没有模块从解析到 `web/src/ui` 的路径导入（保留现有的导入识别式与它的自证用例：别名、多行、`type`、`as`、命名空间、副作用、动态、再导出）、`web/src` 下不出现标识符 `useToast` 与 `ToastProvider`、两个自写共享组件的位置（3.2 已加）；
  「会话页迁移终态」去掉「每个文件都已登记」与对 `legacy.css` 的读取，保留「没有 `.css`、没有 `session-filter.tsx`」与 `assistant-ui` 目录的文件清单；
  「显式列表语义」的扫描范围由「已迁移区域的 `.tsx`」改为「`web/src` 下除两个拷入目录之外的全部 `.tsx`」（design D10），「确有四个带 `list-none` 的文件」的非空断言保留。
  验证：此时「`web/src/ui` 下没有文件」判红（目录还在）；其余用例通过；注入样本 `web/src/ui/card.tsx`、`import { Button } from "../../ui/index.js"`、`useToast` 导入、`web/src/features/chat/chat.css` 各判失败。
- [ ] 4.3 `web/test/ui-guardrails.test.ts`（G3）：`RADIX_ALLOWED_DIRS` 去掉 `web/src/ui/`；`:137` 的样本改为 `isApplicationLayer("web/src/ui/dialog.tsx")` 为 `true`；取色扫描去掉 `web/src/ui` 的 `.css` 一组（对象为 features、routes、直接放在 `web/src/components/` 下的 `.tsx`，三组都断言非空），相应的用例标题与注释改写；删除 `motion.css` 一组。
  验证：依赖方向与取色两组通过；注入样本（features 下的文件导入 `@radix-ui/react-dialog`、`web/src/ui/x.tsx` 导入 `radix-ui`）各判失败。
- [ ] 4.4 删除旧样式层：`web/src/styles/legacy.css`、`web/src/ui/ui.css`、`web/src/ui/motion.css`（`web/src/ui/` 目录随之消失）；`web/src/styles.css` 的层声明改为 `@layer theme, base, components, utilities;`、去掉 `@import "./styles/legacy.css" layer(legacy);`、头注释改写（不再提 `legacy` 层与 `legacy.css`，写明全局基础规则在 `theme.css` 的 `base` 块）。
  验证：`test ! -e web/src/ui && test ! -e web/src/styles/legacy.css`；`find web/src -name '*.css'` 恰为三个文件；4.1–4.3 的守卫全部转绿；`npm run build --workspace web` 成功。
- [ ] 4.5 读 `legacy.css` 的五处断言改为读 `web/src/styles/theme.css`，断言内容不变（「不含某旧规则 / 某导入」，design D14）：`web/test/chat-steps.test.tsx:133`、`login-form.test.tsx:275`、`settings-footer.test.tsx:539`、`sidebar.test.tsx:398`、`topbar.test.tsx:276`（该处的路径清单里把 `legacy.css` 换成 `theme.css`）；用例标题里的 `legacy` 字样同步。
  验证：`grep -rn 'legacy\.css' web/test web/e2e` 只剩守卫里「该文件不存在」的断言与注入样本；`npm test --workspace web` 通过。
- [ ] 4.6 走查：删除 `web/e2e/ui-walk-files.ts` 的 `expectLegacyOverPreflight`（连同它上方三行注释），以及 `web/e2e/ui-walk-layout.ts` 里对它的导入与调用（`:5`、`:198`，`:190` 的注释去掉「与层序探针」）。不新增走查步骤。
  验证：`grep -rn 'LegacyOverPreflight\|legacy' web/e2e` 零命中；`make ui-walk` 两个 project 全绿。
- [ ] 4.7 文档（design D18）：`AGENTS.md:164` 去掉「与冻结区 `web/src/ui/`」（改后仍是 Enforcement Index 说明段之后、`Known blind spots` 之前唯一一行同时点名两个拷入目录与 ADR-0013 的注记）；
  `constraints.yaml:173` 与 `:178` 的 `exit_condition` 把「应用层与冻结区门槛不变」改为「应用层门槛不变」；
  `IMPLEMENTATION_PLAN.md`：`:149`（F-UI-7 的「`web/src/ui` 自有基元退役」标明已由本 change 完成）、`:163`（「不再新增 `web/src/ui` 基元」改为该目录已删除、自写共享组件放 `web/src/components/`）、`:354`（后续第 1 条标为已完成，指向 #1393）；
  ADR-0013 的本 change 增补补上终态：旧基元层与 `legacy` 层已删除、`web/src` 只剩三个样式文件、全局基础规则与 `ui-*` 类在 `theme.css` 的 `base` 块里及其理由（design D7）、分层守卫改为终态断言、七个 Radix 单包已卸载。
  验证：`grep -rnE '冻结区|web/src/ui|legacy\.css|layer\(legacy\)' AGENTS.md constraints.yaml ATTRIBUTION.md IMPLEMENTATION_PLAN.md web/src web/e2e` 的命中只剩对历史的记述（逐条在 PR 里说明）；`web/test/ui-layering.test.ts` 的 `AGENTS.md` 与 `constraints.yaml` 两条用例通过；`make test-guardrails` 通过（`scripts/test-ci-harness.sh` 没有镜像被改动的文本，design D18 已核对，开工时再 grep 一次）。
- [ ] 4.8 变异证据（对真实文件逐条做、逐条撤销，结果贴进 PR）：
  新建 `web/src/ui/card.tsx` → `ui-layering` 判红；
  新建 `web/src/features/chat/x.css` → `ui-foundation-entry` 的「样式文件恰为三个」与 `ui-layering` 的会话页终态都判红；
  在 `web/src/styles.css` 的层声明里加回 `legacy`，或加回 `@import "./styles/legacy.css" layer(legacy);` → `ui-foundation-entry` 各判红；
  在 `web/src/features/files/tree.tsx` 加 `import * as Dialog from "@radix-ui/react-dialog"`（已卸载的单包）或 `import { Dialog } from "radix-ui"` → `ui-guardrails` 的依赖方向守卫各判红（前者另由类型检查判红）；
  在 `web/src/features/chat/composer.tsx` 加 `import { useToast } from "@/components/toast"` → `ui-layering` 判红；
  在 `web/src/features/chat/todo-panel.tsx` 去掉 `role="list"` → 显式列表语义守卫判红；
  把 `theme.css` 的 `@layer base` 改名为 `@layer components` → `ui-foundation-entry` 判红。
- [ ] 4.9 归档时（不在本组的 PR 里；先例 `6996028a`）：归档把 delta 并入主规格之后，以一个文档提交改两份主规格的 `## Purpose`——`openspec/specs/ui-foundation/spec.md` 去掉「frozen-zone split with its migrated-area guard」，改述为拷入层 / 应用层两层与自写共享组件；
  `openspec/specs/ui-primitives/spec.md` 去掉「`web/src/ui/` 基元层」「以 Radix UI Primitives 为行为层的组件库」，改述为设计 token、图标与品牌标记、动效约束与覆盖层的键盘关闭。
  验证：两个 CLI 的 `openspec validate --specs --strict` 通过；`grep -n 'web/src/ui\|frozen' openspec/specs/ui-foundation/spec.md openspec/specs/ui-primitives/spec.md` 的命中只剩条文里对「已不存在」的陈述。
- [ ] 4.10 收尾验证：逐条核对 #1393 的七条验收标准并在 PR 里给出各自的证据（命令输出或测试名）；`make check`、`make test-guardrails`、`make ui-walk` 全绿；
  `$HOME/.nvm/versions/node/v24.13.1/bin/openspec validate s1f-legacy-layer-removal --strict --no-interactive` 与 `$HOME/.local/bin/openspec validate s1f-legacy-layer-removal --strict --no-interactive` 都通过；本文件的任务全部勾选（2.6 / 2.7 中未取的一条带「未取」注记）。

Suggested fixture level: expanded - 改唯一的样式入口（层声明与导入）并重写三个守卫——它们是此后整个前端分层的判据；另含 `AGENTS.md`、`constraints.yaml` 的条文改动
Minimal mergeable slice: atomic - 删除 `legacy.css` 与 `legacy` 层、三个守卫里断言它们存在的常量、读 `legacy.css` 的五个测试与走查探针必须同刀：文件一删，这些断言立即变红；先改守卫不删文件同样是红的。文档（4.7）随同一 PR，4.9 在归档时
