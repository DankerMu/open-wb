# Proposal: s1f-legacy-layer-removal

## Why

S1f 的 C（`s1f-session-list-temp-space`）与 D（`s1f-files-page`）合入后，所有页面都已建在拷入层 + Tailwind 上，但旧样式层还整层留着（#1393 的逐文件清点）：
`web/src/ui/` 32 个文件里 24 个在产品代码中已没有导入方，`ToastProvider` 挂在入口却没有任何 `useToast` 调用方，7 个 `@radix-ui/react-*` 单包只为这些死代码存在；
同时 `legacy` 层里还有少量活着的规则（全局 reset、`.ui-icon*`、`.ui-brand*`、`.ui-alert` / `.ui-muted` / `.ui-empty`）。
ADR-0013 的终态是「`web/src/ui/*` 自有基元层与逐组件 CSS 随迁移退役」「不保留第二套样式体系」；`s1f-files-page` 的 design 把这件事留在「Not yet specified」，等 C 与 D 都合入后对着代码清点——现在可以清点了。
留着的代价：守卫与两份主规格继续为一个过渡态背书，死代码照常计入覆盖率与门槛，新代码还会继续从 `ui/index` 取名字。

## What Changes

- **删除没有调用方的旧基元**：`web/src/ui/` 下 24 个文件（`Button`、`Chip`、`ConfirmDialog`、`Dialog`、`Drawer`、`EmptyState`、`Input`、`Menu`、`Popover`、`SegmentedControl`、`Switch`、`Tag`、`Tooltip` 及其样式）与只测它们的 8 个单测文件；
  只被它们导入的 6 个 `@radix-ui/react-*` 单包从 `web/package.json` 与 lockfile 移除（**依赖变更，PR 中标注**）。
- **删除 Toast**（owner 裁定）：`toast.tsx` / `toast.css`、入口的 `ToastProvider` 包裹、它的单测、测试里的包装与走查里的 `.ui-toast` 断言；`@radix-ui/react-toast` 随之移除。**本 change 不提供替代的通知机制。**
- **`useEscapeFallback` 先实测再定**（owner 裁定）：Toast 删除后逐个调用点实测 Escape 是否仍关得掉覆盖层。全部通过则删除该 hook 与全部调用；任一不通过则保留并搬到 `web/src/components/escape-fallback.ts`，记录是哪个覆盖层需要它。
  规格只规定用户可见的行为（一次 Escape 恰好关闭所在覆盖层一次，嵌套菜单只关自己），两种结果都是合法终态。
- **`Icon` / `IconName` / `BrandMark` 搬家**（owner 裁定）：搬到 `web/src/components/icon.tsx` 与 `web/src/components/brand-mark.tsx`，组件与名字不变，只改导入路径。它们是自写代码，不是 registry 拷入的组件，不进两个拷入目录，照常受 lint、覆盖率与行数门槛约束。
- **活着的规则搬进 `theme.css`**：全局基础规则（`html` / `body` / `#root`、表单控件 reset、`:focus-visible`、选区、滚动条、`color-scheme`）与 `.ui-icon*`、`.ui-brand*`、`.ui-alert`、`.ui-muted`、`.ui-empty` 原样搬到 `web/src/styles/theme.css` 的 `@layer base` 块里，使用处不改；搬运前后的计算样式逐项比对。
- **删除旧样式层**：`web/src/styles/legacy.css`、`web/src/ui/ui.css`、`web/src/ui/motion.css`、整个 `web/src/ui/` 目录与层声明里的 `legacy`。`web/src` 下的样式文件只剩 `styles.css`、`styles/tokens.css`、`styles/theme.css`。
- **守卫改成终态断言**：分层守卫、入口结构守卫与依赖方向守卫不再描述「冻结区」「已迁移清单」，改为断言旧目录不存在、样式文件恰为三个、Radix 只在拷入层；走查里的层序探针删除。
- **文档同步**：`AGENTS.md`、`constraints.yaml`、`ATTRIBUTION.md`、`IMPLEMENTATION_PLAN.md`、代码注释，以及 ADR-0013 的一条增补（终态达成、Escape 实测结果）。
- **不做**：包体上限；替代的通知机制；任何页面的视觉或行为变化；预览令牌与 S3a 登录会话的关系。

没有 **BREAKING** 的用户可见变化：这是保持行为的清理。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `ui-foundation`：「Tailwind 入口与层叠顺序」（层声明去掉 `legacy`、入口导入、全局基础规则的去处、层序探针场景移除）；「主题映射」（调色板到组件的映射边界只剩 `theme.css`）；
  「组件分层」（冻结区与已迁移清单退役，改为拷入层 + 自写共享组件 + 应用代码；Radix 只在拷入层）；「拷入层的门槛豁免」（不再提冻结区，写明两个自写共享组件不在豁免内）。
- `ui-primitives`：「设计 token 全集」（映射边界一句）；「动效与图标」（`Icon` 的新位置，`motion.css` 条款移除）；「按钮单一实现与旧类退役」（去掉对旧 `Button` 的条款）；
  「全局 reduced-motion 规则」（不再提 `legacy` 层，「声明过渡的规则集合非空」不再成立）。
  移除「基元组件库」（十三个旧基元的规格；其中仍然有效的内容迁入新增的「品牌标记与取色边界」与「手写对话框迁移不回归」）与「Escape 分派不受 Toast 层栈影响」（由新增的「覆盖层的 Escape 关闭」接替）。
- `verification-harness`：「UI 走查（Playwright）」里一句——reduced-motion 切换断言的对象是运行中会话的状态标记，不是已不存在的 `.ui-pulse`。

其余主规格里提到「不显示 Toast / 轻提示」的条文（`chat-web`、`session-sidebar`、`turn-control`、`turn-artifacts`、`tool-approval`、`message-undo`、`conversation-search`、`file-previewers`、`files-web`、`workspace-sidebar`、`chat-harness`）在 Toast 删除后仍然为真，不改；
`files-harness` 两处提到 `legacy.css` 的是对已删除规则的历史说明，同样不改。

## Impact

- **代码**：`web/src/ui/**`（整目录删除）、`web/src/styles.css`、`web/src/styles/{legacy,theme}.css`、`web/src/main.tsx`、从 `ui/index` 导入的 43 个产品文件（`main.tsx` 去掉 `ToastProvider` 包裹，其余只改导入路径；Escape 分支决定是否另改 9 个文件里的 10 处调用）、新增 `web/src/components/{icon,brand-mark}.tsx`（搬入）。
- **测试与走查**：`web/test/` 删除 11 个文件（约 2.6k 行）、改写三个守卫文件与约 20 个引用旧层的测试或支撑文件；`web/e2e/` 改 4 个文件。
- **依赖**：`web/package.json` 移除 7 个 `@radix-ui/react-*` 单包（拷入层只用合包 `radix-ui`，不受影响）；根 `package-lock.json` 随之更新。不新增依赖。
- **文档**：`AGENTS.md`、`constraints.yaml`、`ATTRIBUTION.md`、`IMPLEMENTATION_PLAN.md`、`docs/adr/0013-assistant-ui-frontend-rebuild.md`；归档后两份主规格的 `## Purpose` 另以文档提交更新（delta 改不了 Purpose）。
- **服务端、API、数据**：无。

## 流程记录

- **压测门禁：跳过，owner 已批准（2026-10-12）。** 理由：范围由 #1393 的逐文件清点与 owner 的四条裁定固定；这是保持行为的清理，没有待定的产品分支。
- **owner 裁定（2026-10-12）**：`Icon` / `IconName` 搬到 `web/src/components/icon.tsx`；`BrandMark` 搬到 `web/src/components/brand-mark.tsx`；Toast 直接删除、不提供替代；`useEscapeFallback` 先实测再定。落点见 design D1–D4。
- **跟踪**：#1393 作为 Epic；四个子 issue，每个一个 PR，对应 tasks 的组 1–4，依赖次序 1 → 2 → 3 → 4。
