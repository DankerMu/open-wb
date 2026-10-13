# Design: s1f-legacy-layer-removal

## Context

动机见 proposal。这里只列决定做法的代码事实。#1393 的清点取自 `5cafd012`；下面的数字在 `51ffffb3`（本分支的基线，`origin/master`）上用 grep 重新核对过，**一致**与**有出入**分开列。

**核对一致的：**

- `web/src/ui/` 32 个文件、1943 行；`web/src/styles/legacy.css` 127 行；`web/src/ui/ui.css` 91 行、`motion.css` 95 行。
- 从 `ui/index` 导入的产品文件 43 个（`web/src`，不含 `web/src/ui/` 自身）：`Icon` 32、`IconName` 8、`BrandMark` 4、`useEscapeFallback` 9、`ToastProvider` 1（`web/src/main.tsx`）；`useToast` 与其余十三个基元在产品代码里 0 个导入方。没有深层导入，没有动态导入。
- 测试里的导入方：`ToastProvider` 13 个文件、`useToast` 5 个；只测死基元或 Toast 的单测 11 个文件（行数与 issue 所列逐个相同）。
- 样式导入链只有一条：`styles.css:14` → `legacy.css:7-8` → `ui.css:5-16`（12 个组件样式）。`.ui-alert` 5 处、`.ui-muted` 1 处、`.ui-empty` 1 处，共 7 处使用；`.ui-sr-only` 与 `motion.css` 的五个工具类、六组关键帧在 `web/src/ui/` 之外零使用。
- 7 个 `@radix-ui/react-*` 单包（`dialog`、`dropdown-menu`、`popover`、`radio-group`、`switch`、`toast`、`tooltip`）在 `web/src` 里只被 `web/src/ui/*.tsx` 导入；拷入层的十个文件与 `tooltip-icon-button.tsx` 一律导入合包 `radix-ui`。所以 7 个都可以移除，没有哪个要留。

**有出入、以这里为准的：**

1. **`useEscapeFallback` 是 9 个文件、10 处调用。** `web/src/features/files/dialogs.tsx` 里有两处（`:156` 创建 / 重命名 / 移动共用的对话框框架，`:510` 删除确认框）。另有四处把它返回的 `ref` 挪作他用：`footer.tsx:74`（忙碌期焦点救回）、`app-shell.tsx:52`（打开者焦点归还）、`project-config.tsx:148`（打开时把焦点定位到 `关闭`，`web/e2e/ui-walk-project-config.ts:42` 依赖这个行为）、`dialogs.tsx:157`（内容元素引用）——删除 hook 时这四处要换成普通的 `useRef`。
2. **`AGENTS.md` 要改。** issue 写「无需改」，但 `AGENTS.md:164` 的拷入层豁免注记以「应用层与冻结区 `web/src/ui/` 门槛不变」结尾。
3. **走查早就不读 `.ui-pulse`。** `verification-harness`「UI 走查（Playwright）」与 `ui-primitives`「动效与图标」都写着「对 `.ui-pulse` 断言 reduced-motion 切换」，而 `web/e2e/ui-walk-layout.ts:366` 读的是 `[data-status-mark="running"]`。这是既有的规格漂移，本 change 删掉 `.ui-pulse` 规则时一并改正。
4. **`ui-primitives`「焦点归还不滚动」写的「仍由旧 `Dialog` 渲染」已不成立**（重命名对话框自 C 起由拷入层的 `dialog` 渲染），同样一并改正。
5. **issue 没列出的四个会变红的断言**：`web/test/ui-reduced-motion.test.ts:148`（声明过渡的规则集合非空——声明过渡的六个样式文件全在 A 删除的 24 个文件里）；
   `web/test/ui-guardrails.test.ts:224`（已安装的 `@radix-ui/*` 单包数大于 0）；`web/test/ui-foundation-entry.test.ts:106`（带 `@import` 的既有样式文件恰为 `ui.css`）；
   `web/test/ui-layering.test.ts:658`（显式列表语义的扫描范围取自 `MIGRATED_AREAS`）。各自落在哪一刀见 D9。
6. **lockfile 在仓库根**（`package-lock.json`），`web/` 下没有。
7. **issue 的「与 preflight 重复（推断）」对链接不成立**：preflight 给 `a` 的是 `text-decoration: inherit`，旧规则是 `none`。所以全局规则一律原样搬，不做去重（D7）。
8. **测试对 Toast 的依赖有三类，issue 只数了第一类。** 在 `51ffffb3` 上 grep（不计将整文件删除的四个与守卫 `ui-layering.test.ts`）：
   (i) `ToastProvider` 包装 8 个文件（另 4 个随整文件删除、`chat-workspace-sidebar-narrow.test.tsx` 的随 N3 整组删除；共 13）；
   (ii) 按类名查 Toast——三个支撑文件各导出一个 `toasts()`（`chat-page-artifact-card-support.tsx:195`、`chat-page-search-support.tsx:282`、`chat-page-session-meta-support.tsx:259`），被 13 个测试文件调用；另有 18 个文件直接写 `document.querySelector(".ui-toast")`，走查 2 处；
   (iii) 按角色查通知区——14 个测试文件与 `web/e2e/ui-walk-stop.ts:124` 用 `getByRole("region", { name: "通知" })`。
   去重后约 40 个测试或支撑文件。第 (ii) 类在 Toast 删除后恒真（查不到任何东西），第 (iii) 类直接变红（`getByRole` 抛错，`chat-stop-button.test.tsx:229` 还正面断言通知区存在）。处置见 D3、D14，名单见 tasks 2.4。
9. **Radix 自己不看输入法组合。** `@radix-ui/react-use-escape-keydown`（1.1.5，`dist/index.mjs`）只判 `event.key === "Escape"`，DismissableLayer 在 `onEscapeKeyDown` 没有 `preventDefault` 时就关闭本层。
   所以「输入法组合中的 Escape 不关闭」在没有 Toast 的真实覆盖层上不是可断言的整层行为（jsdom 里派发 `isComposing: true` 的 Escape，Radix 照样关），它只是兜底自身的性质；真实浏览器里组合中的按键 `key` 不是 `Escape`，Radix 本来就收不到。这决定了兜底的三条性质在哪一层测（D4「兜底自身的性质」）。

**约束：**

- 旧层里的规则今天位于 `legacy` 层：高于 preflight（`base`），低于 utilities。使用处依赖这个位置——`web/src/features/chat/tool-call-group.tsx:13` 靠 `-outline-offset-2` 压过全局 `:focus-visible`，拷入层按钮靠 `disabled:opacity-50` 压过 `opacity: 0.45`，`bg-primary` 压过 `button { background: none }`。搬到哪里都不能改变这个相对位置。
- `web/test/ui-guardrails.test.ts:135` 已经把 `web/src/components/shell.tsx` 这种「直接放在 `components/` 下的文件」判为应用层；五处豁免配置（`web/vitest.config.ts`、`.jscpd.json`、`knip.json`、`biome.json`、`scripts/size-guard.sh`）都只写两个拷入目录，`isPrecise`（`ui-layering.test.ts:455`）拒绝任何多出来的条目。两个搬入的文件因此天然不在豁免内。
- 两个 `openspec` CLI 里较新的那个（1.13.2）拒绝「MODIFIED 少了主规格现有的场景」。这决定了规格 delta 的写法（D12）。
- 当前没有别的进行中的 change（`openspec/changes/` 下只有 `archive/`），不存在跨 change 的条文对底问题。

## Goals / Non-Goals

**Goals:**

- `web/src/ui/` 与 `web/src/styles/legacy.css` 不存在，层声明不含 `legacy`，`web/src` 下只有三个样式文件。
- 所有页面在亮暗两种主题下的计算样式与搬运前相同；Escape 关闭覆盖层的行为不变。
- 三个守卫从「描述过渡态」改成「断言终态」，每条都有会让它变红的变异。
- 只为死代码存在的 7 个 Radix 单包卸载，归属登记同步。
- 两份主规格与 ADR-0013 不再为过渡态背书。

**Non-Goals:**

- **包体上限。** ADR-0013 增补已定「S1f 的全部 change 完成后再定」；本 change 不量、不设、不为此做分割。
- **替代的通知机制。** Toast 直接删除（owner 裁定）；以后要通知机制另开 change。
- **任何页面的视觉或行为变化。** 包括：不把 `.ui-alert` / `.ui-muted` / `.ui-empty` / `.ui-icon*` / `.ui-brand*` 改写成 Tailwind 类，不给全局规则去重或「顺手修正」，不改 `Icon` 的图标名集合，不改任何使用处的类名。
- **预览令牌与 S3a 登录会话的关系。**（`s1f-files-page` 留下的另一条，与本 change 无关。）
- 拷入层的任何改动；新增 registry 组件。
- 把守卫扩展到本 change 之前没有约束的东西（例如把 `ui-btn` 也纳入旧类扫描）。

## Decisions

### owner 的裁定（2026-10-12，已定，不是选项）

**D1 `Icon` / `IconName` 搬到 `web/src/components/icon.tsx`。** 保留现有的包装组件与名字（name→lucide 组件的映射、`size` 五档、`ui-icon ui-icon-<size>` 类名、`label` 语义），只改文件位置与导入路径。
放弃的方案：各处直接用 `lucide-react`——少一层，但要改 32 个文件的调用写法，且失去「图标名是一个联合类型」的约束。

**D2 `BrandMark` 搬到 `web/src/components/brand-mark.tsx`。** 同样只改位置与导入路径。

D1、D2 共同的性质：这两个文件是**自写共享组件，不是 registry 拷入的组件**，不得描述为拷入层。它们放在 `web/src/components/` 下，与两个拷入目录（`ui/`、`assistant-ui/`）平级而不在其内，照常受 Biome linter、覆盖率、jscpd、行数与 knip 约束。
守卫对这两个文件要断言的恰是三件事（D11 的 G1、G3）：
(a) 两个文件存在于上述路径，且路径不以任一拷入目录为前缀；
(b) 它们按应用层对待——注入「`web/src/components/icon.tsx` 导入 `radix-ui`」的样本时依赖方向守卫判失败；
(c) 五处豁免配置没有一条匹配它们——注入「把 `src/components/**` 或 `src/components/icon.tsx` 写进排除项」的样本时「豁免路径精确」判失败（既有的 `isPrecise` 已经如此，只需补这两个样本）。
不为 `web/src/components/` 另立一份「允许的文件清单」：那是又一份要维护的冻结清单，而这里要防的只是「自写代码被当成拷入代码豁免」，上面三条已经防住。

**D3 Toast 直接删除。** 删除 `web/src/ui/toast.tsx`、`toast.css`、`web/src/main.tsx` 的 `ToastProvider` 包裹、它的单测、测试里的 13 处包装（其中 `ui-escape-dispatch.test.tsx` 因依赖旧 `Dialog` 已在 A 删除，B1 处理其余 12 处）、测试与走查里全部查 Toast 元素的写法（Context 出入 8 的第 ii、iii 类）。不提供替代的通知机制（Non-Goal）。
各功能规格里「不显示 Toast / 轻提示」的条文仍然为真。它们今天的测试证据多数是「按类名 `.ui-toast` 查不到」或「通知区里没有条目」，这两种查询的对象在 Toast 删除后不可能再存在：前者恒真，后者抛错。
B1 把这些查询连同三个 `toasts()` 助手全部删除（owner 2026-10-12 选定；这是「既有断言不删除、不削弱」的唯一例外，理由就是被查的元素已不可能存在），并逐用例确认同一用例里有一条**整页范围**的文本或角色断言仍然证明该行为（`queryByText(旧文案)` 为空、整页 `queryByRole("status"|"alert")` 的集合不变之类）；没有的补一条。
分层守卫另加一条机械保证：`web/src` 下不再出现标识符 `useToast` 与 `ToastProvider`（接替旧白名单「已登记文件不得导入 `useToast`」）——没有通知组件可调用，「不显示 Toast」就不再需要逐页面去证。

**D4 `useEscapeFallback`：先实测再定。** 这个 hook 的注释写明它是为「Toast 占着 Radix 层栈、覆盖层收不到 Escape」设的兜底。Toast 删掉之后它是否还有必要，由实测回答，不由推断回答。

- **时点**：B2，基线是 B1 合入后的 `master`（Toast 已删除、hook 与 10 处调用原样）。实测用的改动（去掉两个属性）不单独提交、不合入：B2 的 PR 里只有所取分支的终态，不存在「hook 被掏空」的中间态。
- **方法**（owner 定的两项）：把 10 处调用的 `onEscapeKeyDown` / `onKeyDown` 两个属性去掉（`ref` 保留），然后 (1) 跑既有单测，(2) 跑 `make ui-walk` 两个 project。
- **判据**：每个调用点都满足 ui-primitives「覆盖层的 Escape 关闭」——焦点在覆盖层内时一次 Escape 关闭它、确认动作不触发；嵌套层只关最内一层。既有断言不许为了通过而修改。某个调用点的既有用例若没有同时断言「覆盖层消失」与「确认动作未触发」，先在未改动的代码上补齐并通过，再开始实测。
- **调用点与证据的对照**（写作时 `grep -ln Escape web/test web/e2e` 的命中；开工时重跑并补漏）：

  | 调用点 | 覆盖层 | 按 Escape 的既有单测 | 走查里的 Escape 步骤 |
  |---|---|---|---|
  | `routes/shell/app-shell.tsx:51` | `导航` 覆盖层（窄屏） | `app-shell-responsive.test.tsx`、`nav-overlay-initial-focus.test.tsx`、`sidebar.test.tsx`、`ui-toast-drawer-escape.test.tsx` 的 D5 | `ui-walk-layout.ts:417`、`ui-walk-session-list.ts` 的 `inspectSidebar` |
  | `features/auth/footer.tsx:73` | 退出确认框 | `auth-footer-focus.test.tsx`、`settings-footer.test.tsx`、`auth-footer-toast-escape.test.tsx` | 无 |
  | `features/chat/rename-dialog.tsx:77` | 重命名 / 另存为工作空间 | `chat-page-rename-focus.test.tsx`、`chat-page-session-rename-pin.test.tsx`、`chat-promote.test.tsx` | 无 |
  | `features/chat/delete-dialog.tsx:54` | 会话删除确认框 | `chat-page-session-delete.test.tsx` | 无 |
  | `features/chat/undo-conflict-dialog.tsx:36` | 撤回冲突确认框 | `chat-undo.test.tsx` | 无 |
  | `features/chat/permission-tier.tsx:143` | `全部自动` 确认框 | `chat-permission-tier.test.tsx` | 无 |
  | `features/chat/project-config.tsx:134` | 项目配置弹层 | `chat-page-project-config-dialog.test.tsx` | `ui-walk-project-config.ts:85` |
  | `features/chat/workspace-sidebar.tsx:217` | 工作空间侧边栏（窄屏模态） | `chat-workspace-sidebar-narrow.test.tsx` 的 N1、N4 | `ui-walk-workspace-sidebar.ts:270`、`:394` |
  | `features/files/dialogs.tsx:156` | 创建 / 重命名 / 移动对话框 | `files-overlays.test.tsx`、`files-ops-rename.test.tsx`、`files-ops-move.test.tsx` | 无 |
  | `features/files/dialogs.tsx:510` | 文件删除确认框 | `files-ops-delete.test.tsx` | 无 |

  走查只在三个文件的调用点上按 Escape；其余六个文件、七处调用**只有 jsdom 证据**。这个 hook 当初正是因为真实浏览器里的时序才加的，所以对这七处另用一个一次性的 Playwright 脚本（不入库，与 D15 的脚本同样处理）在真实浏览器里各按一次 Escape，结果写进 PR。这一步是起草者加的，编排方已确认（D19）。某一处在真实浏览器里触达不了（例如撤回冲突确认框需要冲突态）时，用 `page.route` 造出该状态；仍触达不了的，该调用点按「未证实」计，等同不通过。
- **两个分支**（都写成 tasks 里可执行的任务）：
  - **十处全部通过** → 删除 `web/src/ui/escape-fallback.ts`、10 处调用、`ui/index.ts` 的导出与 A 建的 `web/test/escape-fallback.test.tsx`；四处借用 `ref` 的地方（Context 出入 1）换成 `useRef<HTMLDivElement>(null)`，各自的行为不变（`project-config.tsx` 打开时焦点仍落在 `关闭`）；拷入层内容元素上的 `onEscapeKeyDown` / `onKeyDown` / `ref` 三个属性随之去掉（`ref` 另有用途的保留）。
  - **任一处不通过** → hook 保留，10 处调用**全部**原样不动（不做「只留在失败的那几处」的局部删除——那会让同类覆盖层有两种行为、测试矩阵翻倍）；C1 把它搬到 `web/src/components/escape-fallback.ts`，头注释在 B2 改写为实测得到的真实原因（不再提 Toast）。
    不通过的现象要有常驻证据：jsdom 能复现的，补一条先红后绿的单测（去掉该调用点的 hook 时红）；只在真实浏览器复现的，把实测里对应的那一步固化成 `make ui-walk` 的常驻步骤（去掉该调用点的 hook 时走查红）。二者必居其一，不能只留一段文字说明。
- **兜底自身的性质**（保留分支下规格的三条 SHALL NOT：同一次 Escape 不关两次、输入法组合中不关、不响应本层子树之外的目标）。它们今天唯一的测试是 `web/test/ui-escape-dispatch.test.tsx` 的 D1 输入法例与 D4 恰一次例，借旧 `Dialog` 搭台，A 要删这个文件。
  所以 A 在删它之前把这几例搬到 `web/test/escape-fallback.test.tsx`（先搬后删，与 D14 对 Toast 测试的处理相同），搭台换成不依赖旧基元与 Toast 的两种：
  (1) 把 hook 接在一个普通 `div` 上（没有 Radix）——组合中的 Escape、目标在子树之外的 Escape 都不调用关闭回调；`onEscapeKeyDown` 标记过的同一个原生事件再进 `onKeyDown` 不调用关闭回调；子树内的普通 Escape 以 `false` 调用恰一次。
  (2) 把 hook 按调用点的写法接在拷入层的 `Dialog` 内容元素上——Radix 分派与兜底都会触发，关闭回调以 `false` 恰被调用一次（去掉 `handled` 去重则为两次）。
  输入法与子树之外两例只能在 (1) 里测：Context 出入 9 说明了为什么它们在真实覆盖层上断言不了。这个文件在 B2 之前就存在；B2 取删除分支时随 hook 删除，取保留分支时留下，C1 改它的导入路径。
- **终态守卫**：规格场景「兜底只有两种合法终态」由 `ui-layering.test.ts` 的一条判定承担（D11 的 G1）。hook 在 C1 之前还在 `web/src/ui/` 下，所以它分两步到位：B2 取删除分支时直接写成终态（`web/src` 里没有这个标识符）；取保留分支时 B2 先断言「定义恰一处」，C1 搬家时把这一处钉到 `web/src/components/escape-fallback.ts`。
- **记录**：结果（逐调用点的通过 / 不通过、不通过的现象与复现步骤、所取的分支）写进 B2 的 PR 描述，并写进 ADR-0013 的增补（B2 里就写，不等 D）。
- **规格**：ui-primitives「覆盖层的 Escape 关闭」只规定用户可见的行为，并写明两种结果都是合法终态；无论走哪个分支都不需要再改规格。

**D5 压测门禁跳过。** owner 2026-10-12 批准。理由：范围由 #1393 的逐文件清点与上面四条裁定固定；这是保持行为的清理。已记入 proposal「流程记录」。

**D6 跟踪方式。** #1393 作为 Epic；**六个**子 issue，每个一个 PR，对应 tasks 的组 1–6：

| 子 issue | tasks 组 | 内容 |
|---|---|---|
| A | 1 | 删除没有调用方的旧基元 |
| B1 | 2 | 删除 Toast |
| B2 | 3 | Escape 实测与 hook 的去留 |
| C1 | 4 | 搬 `Icon` / `IconName` / `BrandMark`，改导入方 |
| C2 | 5 | 活规则搬进 `theme.css` 的 `base` 块 |
| D | 6 | 删除旧样式层，守卫改为终态，文档收尾 |

owner 最初定的是四个；2026-10-12 看过 tasks 审核之后改判为六个（原第二个拆成 B1、B2，原第三个拆成 C1、C2）：拆出来的每一个都能独立合入保绿，B2 或 C2 出问题时可以单独回滚，C1（三十多个文件的机械改名）与 C2（全站层叠位置变更）的审阅负担和风险性质不同。下文凡说「某一刀」都指这六个之一。

### 起草者的技术决定

**D7 活着的规则原样搬进 `web/src/styles/theme.css` 的 `@layer base` 块，使用处不改。**

决定性的约束是**层叠位置**而不是放在哪个文件：这些规则必须留在 utilities 之下、preflight 之上（Context「约束」第一条）。因此：

- **不能未分层**（`theme.css` 里现有的 `body` 底色那种写法）：未分层规则压过 utilities，全局 `:focus-visible { border-radius: 4px }` 会盖掉所有 `rounded-*`，`button { padding: 0 }` 会盖掉所有 `px-*`。
- **放进 `base` 层**：`theme.css` 在 `tailwindcss/preflight.css` 之后导入，它里面的 `@layer base { … }` 排在 preflight 之后。同一层内的胜负由特异性与源码顺序决定。逐条核对过旧规则与 preflight 的重叠：
  旧规则的特异性都不低于 preflight 的对应规则（`button`、`input, textarea, select`、`a`、`body` 与 preflight 同为元素选择器，靠靠后的源码顺序取胜；`.ui-icon` 是类选择器，高于 preflight 的 `svg { display: block }`；`:focus-visible` 与 preflight 的 `:-moz-focusring` 同级、靠后取胜）。
  所以每一处「旧规则压过 preflight」在同层里依然成立，utilities 依然压过它们。块内保持原来的相对次序（`ui.css` 的规则先于 `legacy.css` 自己的规则，各自内部顺序不变），已有的边框色基线仍在最前——它的选择器是 `*`，特异性最低，任何元素规则照旧压过它。
- **原样搬，不去重**：与 preflight 字面重复的只有 `box-sizing` 一条；`a` 的 `text-decoration` 并不重复（Context 出入 7）；其余是否「等价」都要逐个证明。原样搬的证明成本是零，去重的收益是几行 CSS。

放弃的方案：

- **在使用处改写成 Tailwind 类**（`.ui-alert` → `rounded-lg px-2.5 py-2 …`）：规则从 `base` 升到 `utilities`，与使用处已有的类（`flex-none`、`m-0`）进入同层竞争；`text-xs` 会连带改行高；7 处使用加 `Icon` / `BrandMark` 的组件源码都要动，而 D1、D2 要求组件不变。改动更大，且每一处都要单独证明计算样式不变。
- **新建 `web/src/styles/base.css`，入口以 `layer(base)` 导入**：守卫改动最小（`theme.css` 仍然只做映射，`borderBaselineViolations` 不用动），但 `web/src` 下会有四个样式文件，而 #1393 的验收写的是三个，且它实质上是 `legacy.css` 换名留存。编排方已确认不取这个方案（D19）。
- **放进 `components` 层**：层叠结果相同，但规则里一半是元素级 reset，放 `base` 才名副其实；分两层放又要多证明一次两层之间没有次序依赖。

`theme.css` 因此从「只做映射」变成「映射 + 一个 `base` 块」。为了不让这个块成为新的杂物间，守卫把块内的选择器集合钉成清单：可以减，不能加（D11 的 G2）。文件头注释同步改写。

**D8 层声明改为 `@layer theme, base, components, utilities;`。** 只去掉 `legacy`。`components` 保留：这是 Tailwind 的默认层序，去掉它是另一件事。

**D9 六刀的切法与每一刀必须同刀处理的守卫改动。** 次序 A → B1 → B2 → C1 → C2 → D，线性，不并行。每条边在代码里的理由：

- **B1 ← A**：两刀改同一批东西——`web/src/ui/index.ts` 的导出、`ui.css` 的 `@import`、`web/package.json` 的 `@radix-ui/*`、`ui-layering.test.ts` 的 `FROZEN_FILES`。
- **B2 ← B1**：实测要回答的就是「Toast 没了之后还需不需要兜底」，基线必须是 Toast 已删除的 `master`。
- **C1 ← B2**：搬不搬 `escape-fallback.ts`、导入白名单里还有没有 `useEscapeFallback`，取决于 B2 的分支；`footer.tsx:19` 在同一条 `import` 里同时取 `Icon` 与 `useEscapeFallback`。
- **C2 ← C1**：D15 的基线是「C1 合入后的 `master`」，这样计算样式的差异只能归因于规则换层；`Icon` / `BrandMark` 的位置也已固定。
- **D ← C2**：D 删的三个样式文件正是 C2 搬空的那三个。

每一刀合入后 `make check` 与 `make ui-walk` 全绿。

| 刀 | 做什么 | 这一刀里会变红、必须同刀改的既有断言 |
|---|---|---|
| A | 删 24 个无调用方的基元文件与 8 个单测（先把 `ui-escape-dispatch` 里测 hook 的几例搬走）；`ui/index.ts` 去掉十三个导出；`ui.css` 只留 `toast.css` 的导入；卸 6 个 Radix 单包 | `ui-layering.test.ts` 的 `FROZEN_FILES`（32 → 8）与「恰为 32」；`ui-reduced-motion.test.ts:148`（非空）；`app-shell-responsive.test.tsx:560`（读 `drawer.tsx`）；`ATTRIBUTION.md` 的 Radix 条目（只剩 `react-toast`） |
| B1 | 删 Toast 与测试里全部查 Toast 元素的写法；卸 `@radix-ui/react-toast` | `ui-foundation-entry.test.ts:106`（`ui.css` 不再有 `@import`）；`ui-guardrails.test.ts:224`（单包数 > 0）；`ui-layering.test.ts` 的 `FROZEN_FILES`（8 → 6）；14 个测试文件与 `ui-walk-stop.ts` 的通知区查询（`getByRole` 抛错）；走查两处 `.ui-toast` |
| B2 | Escape 实测并落分支 | 删除分支：`ui-layering.test.ts` 的 `FROZEN_FILES`（6 → 5）与白名单（去掉 `useEscapeFallback`）。保留分支：没有既有断言变红，新增「定义恰一处」的过渡断言 |
| C1 | `Icon` / `BrandMark`（及保留的 hook）搬到 `web/src/components/`，改 36 个导入方（保留 hook 时另加它的 9 个）；删 `ui/index.ts` | `ui-guardrails.test.ts:46-56`、`:88-93`（`web/src/ui` 下 `.tsx` 非空）；`ui-layering.test.ts` 的白名单（清空）与 `FROZEN_FILES`（→ `motion.css`、`ui.css`）；`chat-module-layout.test.ts:147` 的样本 |
| C2 | 活规则搬进 `theme.css` 的 `base` 块 | `ui-foundation-entry.test.ts` 的 `borderBaselineViolations`、`:282-290`（`legacy.css` 的 `body`）、`:299`，以及 `themeViolations` 变异表里以 `body {` 为锚点的两条 |
| D | 删 `legacy.css`、`motion.css`、`ui.css`、`web/src/ui/` 目录与 `legacy` 层；三个守卫改成终态；删层序探针；文档 | `ui-foundation-entry.test.ts` 的 `LEGACY` / `UI_BARREL` / `LAYER_ORDER` / `ENTRY_IMPORTS` 与 `:99`；`ui-layering.test.ts:357` 与整组「组件分层」「会话页迁移终态」、`:658` 的扫描范围；`ui-guardrails.test.ts` 的 `RADIX_ALLOWED_DIRS`、`:137`、`motion.css` 一组；五个读 `legacy.css` 的测试 |

说明：

- A **必须**碰分层守卫——「冻结清单恰为 32」是对清单长度的断言，清单不缩它不会红，但 brief 与规格都要求清单随删除收缩，留着 24 个不存在的文件名等于允许它们被加回来。
- A 删 `ui-escape-dispatch.test.tsx` 而不是留到 B1：它导入旧 `Dialog` / `ConfirmDialog` / `Drawer`，这三个 A 就没了。其中测 hook 的几例先搬走（D4「兜底自身的性质」）。
- A 至 C2 的守卫是**过渡断言**（清单逐刀收缩）；规格 delta 描述的是 D 之后的终态。过渡期间主规格仍是旧文本，不矛盾。
- `motion.css` 在 B1 之后已无使用方，但留到 D 与 `ui.css`、`legacy.css` 一起删：它没有自己的导入方要处理，提前删只是把 D 的守卫改动（`motion.css` 那一组测试）拆到 B1 去。
- C1 之后 `ui.css` 里的 `.ui-icon*` / `.ui-brand*` 规则还在原处（类名没变），所以 C1 不改变任何计算样式；C2 才动规则。

**D10 已迁移清单与冻结清单一起退役。** `MIGRATED_AREAS`（逐文件登记，76 条）、`MIGRATED_ALLOWED_IMPORTS`、`FROZEN_FILES` 是为「旧基元还在、不许回用」设的。旧目录不存在之后，它们要防的事由一条更强的断言接替：`web/src/ui` 下没有文件、没有模块从它导入。
继续保留「会话页每个文件都要登记」只剩记账的成本，没有它在保护的东西。随之处理两个依附于这份清单的断言：

- **「会话页迁移终态」**里「每个 `.ts`/`.tsx` 都已登记」一项去掉；「没有 `.css`、没有 `session-filter.tsx`」与 `assistant-ui` 目录的文件清单保留。
- **显式列表语义守卫**（`ui-layering.test.ts:658`，session-todo「任务清单面板」）今天扫描「已迁移区域的 `.tsx`」。清单没了之后改为扫描 `web/src` 下除两个拷入目录之外的全部 `.tsx`。
  写作时带 `list-none` 的 8 个文件都在 `web/src/features/chat/` 下，扫描范围扩大不会新增违例；拷入目录不扫，因为那里的代码不归本仓改。这一处 owner 的裁定没有覆盖，编排方已确认（D19）。

**D11 守卫的终态与每条的判定自证。** 三个文件各自的终态断言，以及必须让它变红的变异（实现时写成注入样本的用例；tasks 里另有一次对真实文件的变异证据）：

- **G1 `web/test/ui-layering.test.ts`（组件分层）**
  - `web/src/ui` 下没有任何文件。变异：出现 `web/src/ui/card.tsx` → 红。
  - `web/src` 下没有模块从解析到 `web/src/ui` 的路径导入（沿用现有的识别式：具名、`type`、`as`、命名空间、副作用、再导出、动态导入、`@/ui` 别名）。变异：`import { Button } from "../../ui/index.js"` → 红。
  - `web/src` 下不出现标识符 `useToast`、`ToastProvider`。变异：`composer.tsx` 加一行 `useToast` 导入 → 红。
  - `web/src/components/icon.tsx`、`brand-mark.tsx` 存在且不在拷入目录下（D1、D2 的 (a)）。变异：把样本路径换成 `web/src/components/ui/icon.tsx` → 红。
  - 没有新的统一出口：`web/src/components/index.ts` 与 `index.tsx` 不存在（D17）。变异：文件列表里出现 `web/src/components/index.ts` → 红。
  - 兜底的两种合法终态：`web/src` 的 `.ts`/`.tsx` 里，要么标识符 `useEscapeFallback` 完全不出现，要么它的定义（`export function useEscapeFallback`）恰一处、在 `web/src/components/escape-fallback.ts`；`web/src/ui/escape-fallback.ts` 不存在。判定写成吃「文件列表 + 内容」的纯函数，两种终态各用样本证明被接受。
    变异：`web/src/features/chat/x.ts` 里定义同名函数 → 红；`web/src/ui/escape-fallback.ts` 重新出现 → 红；删除分支下某个文件又调用 `useEscapeFallback` → 红。保留分支下 `escape-fallback.ts` 同样适用 D1、D2 的 (a)(b)(c)，各补一个样本。
  - 会话页终态：`web/src/features/chat` 下没有 `.css`、没有 `session-filter.tsx`；`assistant-ui` 目录文件清单不变。变异：目录下出现 `chat.css` → 红。
  - 「拷入层门槛豁免」一组不变，补两个样本（D1、D2 的 (c)）。变异：`web/vitest.config.ts` 的 `coverage.exclude` 加 `src/components/icon.tsx` → 红。
  - 显式列表语义：扫描范围按 D10。变异：`todo-panel.tsx` 去掉 `role="list"` → 红（既有）。
- **G2 `web/test/ui-foundation-entry.test.ts`（入口结构与 `theme.css`）**
  - 层声明恰为 `@layer theme, base, components, utilities;`。变异：加回 `legacy` → 红。
  - 入口导入恰为七条（原八条去掉 `legacy.css` 一条）。变异：加回 `@import "./styles/legacy.css" layer(legacy);` → 红。
  - `web/src` 下的 `.css` 恰为三个文件，`tokens.css` 与 `theme.css` 不含 `@import`。变异：`web/src/features/chat/x.css` 出现 → 红。
  - `theme.css` 的 `@layer` 块恰为一个 `base`；块内第一条是边框色基线；块内选择器集合等于清单；块内 `body` 含 `font-size: 14px`、`line-height: 22px`；块内恰有一个嵌套的 `@media (max-width: 760px)` 块，只含 `body { overflow: auto; }`（嵌套的 at-rule 不是选择器，守卫要单独处理它，不能漏掉也不能当成选择器）；块外的顶层规则块只有既有的五项（`theme.css:8,13,14,17` 的四条 `@custom-variant` 是无花括号的声明，不是规则块，不计）。
    变异：块内加一个 `.ui-new` → 红；把 `button` 的 reset 挪到块外 → 红；块改名 `@layer components` → 红；删基线 → 红。
  - 「主题映射」的既有判定不变（颜色字面量扫描覆盖整份 `theme.css`，搬入的规则只引用 `--wb-*` 语义 token，不触发），但它的变异表要改两条：「`.dark` 类」与「多一个入层块」用 `theme.replace("body {", …)` 取首次匹配，规则搬入后首个 `body {` 变成 `base` 块内缩进的那条，变异会打进块内、同时触发选择器清单判定，不再满足「恰一条违例」。
    两条的锚点改成只命中块外未分层 `body` 的写法（行首匹配，如 `/^body \{/m`；块内的规则保持缩进，C2 的任务已要求）。「hex 字面量」「oklch 字面量」两条以 `var(--background)` / `var(--foreground)` 为锚点，被搬的规则里没有这两个引用，不受影响。
- **G3 `web/test/ui-guardrails.test.ts`（依赖方向与取色）**
  - Radix 只在两个拷入目录：`RADIX_ALLOWED_DIRS` 去掉 `web/src/ui/`。变异：`web/src/features` 下一个文件导入 `@radix-ui/react-dialog` → 红；`web/src/components/icon.tsx` 导入 `radix-ui` → 红；`isApplicationLayer("web/src/ui/dialog.tsx")` 由 `false` 变为 `true`（旧目录不再是例外，重新出现在那里的文件若导入 Radix 同样判红，且先被 G1 判红）。
  - 「导入一个已卸载的 Radix 单包」：在拷入层之外由上一条判红；在拷入层之内不归分层守卫管——包不在 `package.json` 里，`make check` 的类型检查与 knip 的未登记依赖检查会拦下。
  - 取色扫描的对象由「features、routes、`web/src/ui` 的 css 与 tsx」改为「features、routes、直接放在 `web/src/components/` 下的 `.tsx`」，三组都断言非空。内联 `style={` 的扫描对象同样改为后者。
  - `motion.css` 一组删除；`ATTRIBUTION.md` 一组去掉「单包数大于 0」，其余不变。
- **走查**：`web/e2e/ui-walk-files.ts` 的 `expectLegacyOverPreflight` 与 `ui-walk-layout.ts` 里对它的调用删除（D）。新增的走查步骤至多一种：B2 取保留分支且不通过的现象只在真实浏览器复现时，那一步成为常驻步骤（D4）。「全局基础规则压过 preflight」改由 G2 的静态断言与入口导入次序保证（规格场景「旧页面规则压过 preflight」的正文随之改为静态判定）。

**D12 规格 delta 的写法。** 较新的 CLI 拒绝少了既有场景的 MODIFIED，所以：

- **主体还在的条文用 MODIFIED，原样保留主规格该条文的全部场景标题**，含义变了只改正文（沿用 `s1f-files-page` D25 的规则）。标题与正文字面不再一致的有五处，以正文为准：
  ui-foundation「utilities 压过旧全局规则」（规则现在在 `base` 层）、「旧页面规则压过 preflight」（由走查探针改为对 `theme.css` `base` 块的静态判定）、「文件页样式已退出 legacy 层」（`legacy.css` 不存在）、「已迁移区域不回用旧基元，冻结区不增长」（旧目录不存在、无人从它导入）；ui-primitives「图标可访问、动效可禁用、归属登记」（正文已没有动效内容，只剩「`motion.css` 不存在」）。
- **场景确实要消失的条文整条 REMOVED，仍然有效的内容进新条文**：
  - `ui-primitives`「基元组件库」→ REMOVED（CLI 的硬约束逼出来的写法；另一种合法写法是保留五个死场景的标题、正文改成「该文件不存在」，那更糟）。十一个场景里五个只描述已删基元（表单级、模态、弹出与分段、通知与空态、忙碌期焦点留在模态内），无从改写。其余内容进两条 ADDED：「品牌标记与取色边界」（原场景「出口与品牌」「基元层取色边界」）与「手写对话框迁移不回归」（原四个场景）。
  - `ui-primitives`「Escape 分派不受 Toast 层栈影响」→ REMOVED，由 ADDED「覆盖层的 Escape 关闭」接替。没有用 RENAMED：条文不只是改名，四个场景里三个以 Toast 在场为前提。
- **只改一两句的条文**（ui-foundation「主题映射」「拷入层的门槛豁免」，ui-primitives「设计 token 全集」「全局 reduced-motion 规则」，verification-harness「UI 走查（Playwright）」）：全文取自主规格，只替换点名的句子，其余逐字不动。verification-harness 那条改两处：`.ui-pulse` 一句，以及路径描述里的「打开 `Menu`」改为「打开用户菜单」（`Menu` 是已删基元的名字）。
- **`## Purpose` 改不了**：delta 不能改 Purpose。两份主规格的 Purpose 仍写着「frozen-zone split」「`web/src/ui/` 基元层」。先例是 `6996028a`（归档之后以一个文档提交改 Purpose）；本 change 照此在归档时处理：由编排方在归档提交里做，不属于任何子 issue 的 PR（tasks 6.9）。
- **不改的主规格**：见 proposal「Modified Capabilities」末段。

**D13 依赖移除分两刀。** A 移除只被 24 个死基元导入的 6 个（`react-dialog`、`react-dropdown-menu`、`react-popover`、`react-radio-group`、`react-switch`、`react-tooltip`）；B1 随 Toast 移除 `react-toast`。两个 PR 都在描述里标注依赖变更（`AGENTS.md`「依赖政策」）。
这些包仍会作为合包 `radix-ui` 的传递依赖留在 lockfile 里，产物里也仍有它们的代码——被卸的是直接依赖声明，不是代码。`ATTRIBUTION.md` 的「Radix UI Primitives」条目保留（MIT 义务不变，`ui-guardrails` 也要求有一条标题含 `Radix` 的条目），用途改写为「经合包 `radix-ui` 供拷入层使用，不再直接安装单包」；
`radix-ui` 条目里「与上条保留的各 `@radix-ui/*` 单包并存到旧基元层退役」一句删除；lucide 条目里的 `web/src/ui/icon.tsx` 改为新路径（C1）。

**D14 测试的处置规则。**

- 只测已删代码的测试文件随代码删除，不改写、不搬家。`ui-escape-dispatch.test.tsx` 不全属此类：它的 D1 输入法例与 D4 恰一次例测的是 `escape-fallback.ts`，只是借旧 `Dialog` 搭台——A 先把它们搬到 `web/test/escape-fallback.test.tsx`（D4「兜底自身的性质」），再删原文件；其余各例（D2、D3、D6 与 D1 的 Toast 在场例）以旧基元或 Toast 为前提，随文件删除。
- **查 Toast 元素的断言整体删除**（B1；「既有断言不删除、不削弱」的唯一例外）：三个 `toasts()` 助手及其全部调用、全部 `.ui-toast` / `.ui-toast-message` 查询、全部对 `通知` 区域的查询及其内的断言。理由只有一个——被查的元素不可能再存在，这些断言要么恒真要么抛错，留着是摆设。
  条件：逐用例确认同一用例里有整页范围的文本或角色断言仍证明「没有提示」，没有的补一条；PR 的偏离记录逐文件列出删了什么、兜底的是哪一条断言。「挂在 `ToastProvider` 之下，没有 Toast 才不是空话」一类的注释同步改写。
- 混着测「Toast 在场」与「与 Toast 无关的行为」的三个文件，后者要留下：`ui-toast-drawer-escape.test.tsx` 的 D5（覆盖层内的菜单只关自己）、`auth-footer-toast-escape.test.tsx` 的两例去掉 Toast 之后的形态（Escape 关确认框不发起退出；窄屏覆盖层内的确认框一次 Escape 只关确认框）。
  它们是新条文场景「嵌套层只关最内一层」的证据，去掉 Toast 相关的搭建后并入 `app-shell-responsive.test.tsx` 与 `auth-footer-focus.test.tsx`（行数接近上限就另建一个文件），原文件删除。`chat-workspace-sidebar-narrow.test.tsx` 只删 N3 一组，N1、N2、N4 不动。
- 断言「`legacy.css` 不含某规则」的五处（`chat-steps.test.tsx:133`、`login-form.test.tsx:275`、`settings-footer.test.tsx:539`、`sidebar.test.tsx:398`、`topbar.test.tsx:276`）在 D 改为对 `web/src/styles/theme.css` 断言同样的「不含」——
  这些断言防的是旧规则回流到全局样式，全局样式现在只在 `theme.css`。不是简单删除。
- `app-shell-responsive.test.tsx:560-563`（读 `drawer.tsx` 的属性键）在 A 删除：被读的文件不存在了，外壳用的是拷入层的 `sheet`。
- 每一刀开工时重跑该任务给的 grep；命中而未点名的断言在**让它变红的那一刀**里按同样的规则处置并记入 PR 的偏离记录。

**D15 计算样式比对的方法与探针清单。** C2 的验收。一个一次性的 Playwright 脚本（**不入库**；写在系统 scratchpad 里），对着由调用方启动的服务（与 `make ui-walk` 相同的前提）分别在基线提交（**C1 合入后的 `master`**——组件已搬、规则未动，差异只能归因于规则换层）与 C2 分支上运行：
每个探针把 `getComputedStyle` 的**全部属性**（伪元素探针则是该伪元素的全部属性）写成一份 JSON；两份 JSON 做 diff，**必须为空**，diff 结果（含空的那一份）贴进 PR。
亮暗两种主题各跑一遍（以 `workbuddy-theme` 存储值切换）；视口 1440×900 与 390×844 各一遍（`body` 的溢出规则带 760px 的媒体查询）。探针按固定次序、固定名字输出，保证两次运行可比。

| # | 探针 | 怎么让它出现 |
|---|---|---|
| 1 | `html`、`body`、`#root` | 任一页面；两种视口都读（`body` 的 `overflow`） |
| 2 | 任一普通 `div` 的 `box-sizing` | 任一页面 |
| 3 | `.ui-alert` × 5：会话页的历史读取失败、发送失败、事件流失败（`conversation-view.tsx:250,255,260`）；会话列表读取失败（`session-sidebar.tsx:224`）；附件提示（`attachment-chips.tsx:140`） | 用 `page.route` 让对应请求失败 / 选入一个会被拒绝的附件 |
| 4 | `.ui-muted`：会话列表读取中（`session-sidebar.tsx:229`） | 用 `page.route` 拖住列表请求 |
| 5 | `.ui-empty` 及其内的 `p`（`router.tsx:73`） | 打开 `/center` |
| 6 | `Icon` 五档尺寸各一个（`svg.ui-icon-12` … `-20`），另加一个位于拷入层 `Button` 内的图标与一个位于 flex 容器内的图标 | 在走过的页面里各取第一个 |
| 7 | `BrandMark`：登录卡片上的无字标标记；侧栏里带字标的整组（`.ui-brand`、`.ui-brand-mark`、`.ui-brand-mark-bg`、`.ui-brand-mark-check`、`.ui-brand-wordmark`）；设置页与助手头像里的标记 | 登录页、`/`、`/settings`、一条助手消息 |
| 8 | 键盘聚焦下的描边（`outline-*`、`border-radius`）：拷入层按钮（登录页 `登录`）、原生 `button`（工具调用组的标题，它带 `-outline-offset-2`）、侧栏导航链接、登录输入框、会话输入框 | 用 Tab 聚焦，不用 `focus()`（要触发 `:focus-visible`） |
| 9 | 禁用态（`opacity`、`cursor`）：禁用的拷入层按钮、禁用的原生 `button`、锁定中的输入框 | 空草稿时的 `发送`、回合进行中的输入框、挂起中的对话框提交按钮 |
| 10 | 原生表单控件：文件对话框的原生 `select`（`dialogs.tsx:235`）、会话输入框 `textarea`、登录 `input` | `新建文件夹` 对话框、`/`、登录页 |
| 11 | 原生 `button` 的底色、边框、内边距、光标 | 侧栏里一个未带底色类的按钮 |
| 12 | 链接的 `color`、`text-decoration` | 侧栏导航链接 |
| 13 | 选区：一段正文的 `::selection` 的 `color`、`background-color` | `getComputedStyle(el, "::selection")` |
| 14 | 滚动条：一个出现纵向滚动条的容器的 `offsetWidth - clientWidth` | 文件树或长转录；只在 1440×900 下读（窄屏模拟是覆盖式滚动条） |

读不到的部分如实写明：滚动条滑块与轨道的颜色（`::-webkit-scrollbar-thumb` / `-track`）读不出计算值，以「这三条规则的文本在搬运前后逐字相同」的静态比对代替，并在 PR 里注明。
某个状态在真实页面上确实复现不出来时，退而在同一父元素里注入一个带相同类名的元素来读，同样在 PR 里注明是哪一个。

**A/A 对照先行。** 全部计算属性里有依赖布局、数据与时间的已用值（`width`、`height`、`transform-origin` 之类），两次独立的构建与服务之间可能自己就有差异。所以先把基线提交按同样的办法独立跑两遍（两次构建、两个服务），两份输出做 diff：
- A/A 为空 → 直接做 A/B，A/B 必须为空。
- A/A 不为空 → 逐个列出不稳定的「探针 × 属性」，这就是排除清单；A/B 在去掉清单之后必须为空。排除清单与 A/A 的原始 diff 一起贴进 PR。
- 排除清单**只能**来自 A/A，不能来自 A/B 的差异；被搬的规则声明过的属性（两张去向表里那些规则的属性名，如 `overflow`、`font-size`、`opacity`、`outline-*`、`display`）不得进排除清单——它们抖动说明探针不稳，改探针的数据或等待条件之后重跑 A/A，而不是把它排除。

**D16「按钮单一实现与旧类退役」只做最小改写。** 去掉对旧 `Button` 基元的条款，保留「`web/src` 不出现 `ui-button`」的守卫与两个场景。不把 `ui-btn` 加进扫描：那是给守卫加新的约束（Non-Goal），还要为此改 `theme.css` 里一句提到 `.ui-btn--primary` 的注释。编排方已确认（D19）。

**D17 不设新的统一出口。** `web/src/ui/index.ts` 删除后不在 `web/src/components/` 下另建 `index.ts`：使用方直接从 `icon` 与 `brand-mark` 两个文件导入。两个文件、三个名字用不着出口，出口只会成为下一个「什么都从这里取」的地方。各文件沿用自己现有的导入写法（别名 `@/…` 或相对路径带 `.js`）。「不另建」由守卫断言：`web/src/components/index.ts` 与 `index.tsx` 不存在（D11 的 G1，C1 落地）。

**D18 文档与注释的同步范围。**

- `AGENTS.md:164`：去掉「与冻结区 `web/src/ui/`」。该行受 `ui-layering.test.ts:594` 约束（恰一行、点名两个目录与 ADR-0013），改后仍满足。`scripts/test-ci-harness.sh` 与 `scripts/test-guardrails.sh` 核对过，没有镜像这一行或其它被改动文本的字面量。
- `constraints.yaml:173,178`：`exit_condition` 的「应用层与冻结区门槛不变」改为「应用层门槛不变」。`ui-layering.test.ts:575-590` 只断言 `rules`、`reason`、`expires` 三个键，不读 `exit_condition`。
- `ATTRIBUTION.md`：见 D13。
- `IMPLEMENTATION_PLAN.md`：`:149`（F-UI-7 的「`web/src/ui` 自有基元退役」标为已完成并指向本 change）、`:163`（「不再新增 `web/src/ui` 基元」改为该目录已不存在）、`:354`（后续第 1 条标为已完成）。
- ADR-0013：一条增补，B1 起头写 Toast 删除且不提供替代，B2 写 Escape 实测结果，D 补「终态达成」（旧基元层与 `legacy` 层删除、分层守卫改为终态、`theme.css` 多了一个 `base` 块及其理由）。
- 代码注释：`web/src/styles.css:3-5`、`web/src/styles/theme.css:1-6,88-90`、`web/src/features/chat/tool-call-group.tsx:13`、`web/src/features/chat/message-action-row.tsx:116`、`web/e2e/ui-walk-login.ts:34`——凡写着「`legacy` 层」「冻结」的，在让它变成假话的那一刀里改。提到「Toast 占住 Radix 层栈」的五处（`web/src/ui/escape-fallback.ts` 头注释、`footer.tsx:72`、`app-shell.tsx:41`、`workspace-sidebar.tsx:207`、`project-config.tsx:117`）与 `web/e2e/ui-walk-session-list.ts:40` 在 B1 就成了假话，但真话要等 B2 的实测：B1 把它们改成「Toast 已删除，这个兜底是否仍然需要由随后的实测决定」，B2 按所取分支写成终稿或随 hook 删除。
- 功能验收清单不加行：没有用户可见的变化。

### 编排方确认的事项（2026-10-12，已定）

**D19 起草者按最小改动选定、owner 的裁定没有覆盖的七项，编排方全部按原稿确认，不再待定：**

1. 活规则的去处是 `theme.css` 的 `@layer base` 块，不新建 `base.css`（D7）。
2. 三个 `ui-*` 工具类与 `ui-icon*` / `ui-brand*` 原样保留类名，不改写成 Tailwind 类（D7）。
3. `MIGRATED_AREAS` 等三份清单整体退役，显式列表语义守卫的扫描范围改为「除拷入层外的全部 `.tsx`」（D10）。
4. Escape 实测追加一次性的真实浏览器补测，针对走查没有覆盖的七处调用（D4）。
5. Escape 任一处不通过时 10 处调用全部保留，不做局部删除（D4）。
6. 「按钮单一实现与旧类退役」最小改写，既不整条移除，也不把 `ui-btn` 纳入扫描（D16）。
7. 不设新的统一出口，并由守卫断言 `web/src/components/index.ts(x)` 不存在（D17）。

**D20 fixture 档位的词表是 `none | compact | expanded`**（流水线 `stage-flow.md` 的词表），tasks 各组的 `Suggested fixture level` 只用这三个词。

**D21 两份主规格的 `## Purpose` 在归档时改，执行者是编排方。** delta 改不了 Purpose（D12）；这一步在归档提交里做（或紧随其后的一个文档提交），不属于六个子 issue 中任何一个的 PR，也不计入 D 的「任务全部勾选」（tasks 6.9、6.10）。

## 逐文件与逐规则的去向

### `web/src/ui/` 的 32 个文件

| 文件 | 去向 |
|---|---|
| `button.tsx`、`button.css` | A 删除 |
| `chip.tsx`、`chip.css` | A 删除 |
| `confirm-dialog.tsx` | A 删除 |
| `dialog.tsx`、`dialog.css` | A 删除 |
| `drawer.tsx` | A 删除 |
| `empty-state.tsx`、`empty-state.css` | A 删除 |
| `input.tsx`、`input.css` | A 删除 |
| `menu.tsx`、`menu.css` | A 删除 |
| `popover.tsx`、`popover.css` | A 删除 |
| `segmented-control.tsx`、`segmented-control.css` | A 删除 |
| `switch.tsx`、`switch.css` | A 删除 |
| `tag.tsx`、`tag.css` | A 删除 |
| `tooltip.tsx`、`tooltip.css` | A 删除 |
| `toast.tsx`、`toast.css` | B1 删除 |
| `escape-fallback.ts` | B2：实测全通过则删除；否则原地保留，C1 搬到 `web/src/components/escape-fallback.ts` |
| `icon.tsx` | C1 搬到 `web/src/components/icon.tsx`（内容不变） |
| `brand-mark.tsx` | C1 搬到 `web/src/components/brand-mark.tsx`（内容不变） |
| `index.ts` | A、B1（及 B2 的删除分支）逐步去掉导出；C1 删除 |
| `ui.css` | A 去掉 11 条 `@import`、B1 去掉最后一条；C2 搬走 `.ui-icon*`、`.ui-brand*`；D 删除 |
| `motion.css` | D 删除 |

（A 24 个；B1 2 个；B2 0 个或 1 个；C1 3 个或 4 个（两个或三个搬走、`index.ts` 删除）；D 2 个。合计 32。）

### `web/src/styles/legacy.css` 的规则块

| 行 | 内容 | 去向 |
|---|---|---|
| 1-5 | 文件头注释 | D 随文件删除 |
| 7-8 | `@import "../ui/motion.css"`、`"../ui/ui.css"` | D 随文件删除 |
| 10-14 | `*, ::before, ::after { box-sizing }` | C2 搬进 `theme.css` 的 `base` 块 |
| 16-20 | `html, body, #root { height: 100% }` | 同上 |
| 22-28 | `html { color-scheme }` 与深色取值 | 同上 |
| 30-37 | `body` 的边距、字体、字号、行高、溢出、字体平滑 | 同上 |
| 39-45 | `button, input, textarea, select { font; color }` | 同上 |
| 47-52 | `button { background; border; padding; cursor }` | 同上 |
| 54-60 | 禁用态的 `cursor` 与 `opacity` | 同上 |
| 62-68 | `input, textarea, select` 的底色、边框、圆角 | 同上 |
| 70-73 | `a { color; text-decoration }` | 同上 |
| 75-79 | 全局 `:focus-visible` | 同上 |
| 81-84 | `::selection` | 同上 |
| 86-98 | `::-webkit-scrollbar`、`-thumb`、`-track` | 同上 |
| 100-107 | `.ui-alert` | 同上 |
| 109-113 | `.ui-muted` | 同上 |
| 115-121 | `.ui-empty` | 同上 |
| 123-127 | `@media (max-width: 760px) { body { overflow: auto } }` | 同上（媒体块整体进 `base` 块，保持在最后） |

C2 之后 `legacy.css` 只剩文件头与两条 `@import`；D 删除。

### `web/src/ui/ui.css` 的规则块

| 行 | 内容 | 去向 |
|---|---|---|
| 5-14、16 | 11 条组件样式的 `@import`（`toast.css` 之外） | A 删除 |
| 15 | `@import "./toast.css"` | B1 删除 |
| 18-22 | `.ui-icon` | C2 搬进 `theme.css` 的 `base` 块（排在基线之后、全局规则之前，与原导入次序一致） |
| 24-47 | `.ui-icon-12` … `.ui-icon-20` | 同上 |
| 49-54 | `.ui-brand` | 同上 |
| 56-67 | `.ui-brand-mark`、`-bg`、`-check` | 同上 |
| 69-78 | `.ui-brand-wordmark` | 同上 |
| 80-91 | `.ui-sr-only` | D 随文件删除（`web/src`、`web/test`、`web/e2e` 都没有使用方） |

### `web/src/ui/motion.css` 的规则块

| 行 | 内容 | 去向 |
|---|---|---|
| 7-64 | 六组 `@keyframes wb-*` | D 随文件删除（使用方只有 A、B1 删掉的基元样式） |
| 66-84 | `.ui-fadein`、`.ui-pop`、`.ui-pulse`、`.ui-caret`、`.ui-spin` | 同上 |
| 86-95 | 五个工具类的 reduce 块 | 同上 |

## Risks / Trade-offs

- **[搬运后某条规则的层叠结果变了]** → D7 的逐条核对给出理由，D15 的计算样式 diff 给出证据；diff 非空就不合入。C2 之后 `legacy` 层里已无活规则，D 删层不再影响任何计算样式。两次独立运行之间的噪声由 A/A 对照先行排除（D15）。
- **[Escape 实测的结论依赖环境]**（jsdom 与真实浏览器的时序不同，hook 当初就是为此加的） → 走查没覆盖的七处补一次真实浏览器按键；任一处不稳定即按「不通过」处理，走保留分支。保留分支的代价只是一个 30 行的文件。
- **[删测试时把仍然有效的断言一起删掉]** → D14 逐文件规定哪些用例要留下并搬到哪里；删除的文件在 PR 的偏离记录里逐个列出「里面有没有与已删代码无关的用例」。B1 成批删除查 Toast 元素的断言是唯一被许可的例外，条件是逐用例有整页范围的文本或角色断言兜底（D3、D14）。
- **[`theme.css` 的 `base` 块变成新的杂物间]** → G2 把块内选择器钉成清单，加一个就红；规格写明只减不增。
- **[A 至 C2 的过渡守卫写错，留下一个放空的断言]** → 每一刀的变异证据任务要求对真实文件做一次变异并看到红；清单类断言同时断言长度与「目录里的每个文件都在清单里」。
- **[卸载单包后某处仍隐式依赖它]** → 类型检查、构建与 knip 在 `make check` 里都会报；`make ui-walk` 证明运行时没有缺模块。
- **取舍**：保留 `ui-*` 类名意味着仓库里还有十几条非 Tailwind 的类规则。它们现在集中在一个受清单约束的块里，不再是「第二套样式体系」，但也不是零。把它们改写成 Tailwind 类是可以以后单独做的事，本 change 不做。

## Migration Plan

六个 PR 按 A → B1 → B2 → C1 → C2 → D 合入，每个合入后主干可运行、`make check` 与 `make ui-walk` 全绿。没有数据迁移、没有配置变更、没有服务端改动。
回滚：每一刀都可以单独 `git revert`，前提是它后面的各刀未合入或一并回滚（次序是线性的）。拆成六个的用处就在这里：B2 的 Escape 结论或 C2 的规则换层出问题时，只回滚那一个，Toast 的删除与组件的搬家不受牵连。
归档在 D 合入之后；归档时由编排方按 D21 处理两份主规格的 Purpose。

## Open Questions

无。Escape hook 的去留是一项有确定分支的实测（D4），不是开放问题；起草者自定的各项已由编排方确认（D19–D21），切法由 owner 定为六个子 issue（D6）。

## Not yet specified

无。本 change 的范围是 #1393 的逐文件清点：每个文件、每个规则块的去向都在上面的表里，唯一的不确定项（Escape hook）两个分支都已写成任务。
被划出范围的事（包体上限、通知机制、把 `ui-*` 类改写成 Tailwind 类、预览令牌与 S3a）在 Non-Goals 里，不是「以后再说的雾」。

## Sketch seams under test

- **静态守卫三件套（既有）**：`web/test/ui-layering.test.ts`、`ui-foundation-entry.test.ts`、`ui-guardrails.test.ts`。本 change 的终态几乎全是「某个文件不存在 / 某个导入不出现 / 样式文件恰为这三个」这类结构性质，只有读文件系统与源码的静态判定能证明；每条判定带注入样本自证。
- **`make ui-walk`（既有）**：真实浏览器里的层叠结果（登录按钮底色、亮暗主题的 `body`）、Escape 步骤、reduced-motion 切换、零失败资源请求。它是唯一能证明「删掉一层之后页面还是那个页面」的常驻检查。本 change 默认不为它新增步骤；唯一的例外是 B2 取保留分支、且不通过的现象只在真实浏览器复现时，实测里对应的那一步固化为常驻步骤（D4）。
- **整页渲染（既有 `render-app-router` + 假 fetch）**：十处覆盖层的 Escape、嵌套层只关最内一层。沿用各覆盖层既有的测试文件——被测的是用户可见的关闭行为，hook 在不在都一样测。
- **兜底的组件级渲染（`web/test/escape-fallback.test.tsx`，A 建；只在 hook 存在期间存在）**：兜底自身的三条性质（不重复、组合中不关、不响应子树之外）在整页渲染里测不出来——没有 Toast 时 Radix 先一步关掉本层，去掉兜底里的任何一个判断整页用例都照样绿（Context 出入 9）。所以把 hook 接在普通 `div` 与一个拷入层 `Dialog` 上直接测。它接替的是 `ui-escape-dispatch.test.tsx` 里同样性质的用例，不是新的测试层次。
- **`Icon` / `BrandMark` 的组件渲染（既有 `ui-icon-brand.test.tsx`）**：搬家后只改导入路径即应通过，证明组件没变。
- **一次性的计算样式比对脚本（不入库，D15）**：只用于 C2 的验收。不做成常驻检查：它比的是「搬运前后」，搬完之后没有「前」可比。

除上面点名的组件级文件（接替被删的同类用例）外不新增 seam。

## Traceability

| 来源 | 落点 |
|---|---|
| owner 裁定 1（`Icon`） | D1；ui-primitives「动效与图标」；ui-foundation「组件分层」；tasks 4.1、4.2 |
| owner 裁定 2（`BrandMark`） | D2；ui-primitives「品牌标记与取色边界」；ui-foundation「组件分层」「拷入层的门槛豁免」；tasks 4.1、4.2 |
| owner 裁定 3（Toast） | D3、D14；ui-primitives 两条 REMOVED；ui-foundation「组件分层」；tasks 2.1–2.5 |
| owner 裁定 4（Escape） | D4；ui-primitives「覆盖层的 Escape 关闭」；tasks 1.2（搬 hook 的用例）、3.1–3.6、4.2（保留时的终态守卫） |
| owner 裁定 5（压测门禁） | D5；proposal「流程记录」 |
| owner 裁定 6（跟踪，2026-10-12 改判为六个） | D6、D9；tasks 的六个组 |
| 编排方确认（2026-10-12） | D19–D21 |
| #1393 清点一（导出与导入方） | Context；D9；逐文件去向表；tasks 1.1、2.1、4.1 |
| #1393 清点二（`legacy.css` 与 `ui/*.css`） | D7；逐规则去向表；D15；tasks 5.1–5.3、6.1 |
| #1393 清点三（守卫、规格、文档） | D9、D11、D12、D14、D18；tasks 各组的守卫任务与 6.6–6.9 |
| #1393 验收标准七条 | Goals；D11（守卫）、D13（依赖）、D15（计算样式）；tasks 6.10 |
