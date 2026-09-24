# Proposal: ui-tokens-foundation（#275）

## Why
S1e（`openspec/changes/s1e-frontend-parity`）组 1 首刀。当前 `web/src/styles.css` 只有 21 个与 demo 同名的变量 + 两个本仓自有变量（`--wb-home-bg`/`--wb-control-bg`），feature css 直接引用少量语义 token 但没有调色板层；demo（`resource/workbuddy-live-demo.html:19-188`）定义了 163 行 token（调色板 + 语义，亮/暗）。没有 token 全集，后续基元与页面对齐（#276–#302）无处取值；没有 `web/src/ui/index.ts` 唯一出口，依赖方向守卫无从落地。

## What Changes
- 新增 `web/src/styles/tokens.css`：demo `:root`/`[data-theme="dark"]` 两块全部 `--wb-*` 逐字移植（唯一差异：`--wb-font-heading` 去掉 `Poppins,`）；"逐字"定义为经归一化后相等（biome 会把 hex 小写、`rgba(0,0,0,.9)` 展开为 `rgba(0, 0, 0, 0.9)`、长值折行；归一化规则见 design.md）。demo 引用但未定义的六个变量补定为固定值（见 design.md）并注明"demo 缺失、本仓补定"；本仓既有 `--wb-home-bg`/`--wb-control-bg` 删除，消费者改用 demo 等价 token `--wb-home-bg-primary`（`#f2f2f2`/`#1f1f1f`）与 `--wb-color-bg-input`（`rgba(0,0,0,.04)`/`rgba(255,255,255,.04)`），值完全一致。文件头保留来源说明（ATTRIBUTION §4）。
- 新增 `web/src/ui/icon.tsx`（单组件：`name` 联合类型 + 内部 lucide 映射，默认 `aria-hidden`，`label` 给可访问名，size `12|14|16|18|20`）、`web/src/ui/brand-mark.tsx`（自有 mark SVG——沿用现有对勾——+ 可选字标 `WorkBuddy`，不含上游资产）、`web/src/ui/motion.css`（`wb-fadein/wb-pop/wb-pulse/wb-caret/wb-spin/wb-drawer-in` 关键帧 + `ui-*` 工具类 + reduced-motion 块）、`web/src/ui/index.ts`（唯一出口，首刀导出 `Icon`/`BrandMark`）。
- `web/src/styles.css` 收缩：token 块移出、改 `@import "./styles/tokens.css"` 与 `./ui/motion.css`；既有 reset/骨架/页面样式保留（视觉不变）。清理 `web/src/features/chat/chat.css` 头注释里的 hex。
- 新依赖 `lucide-react`（ISC）；`ATTRIBUTION.md` §2 或 §3 增 lucide（ISC）与 Radix UI Primitives（MIT，后续切片安装）条目。
- 单测（`web/test`）：token 对照（解析 demo 两块与 tokens.css 两块，归一化后逐名逐值 + 六个补定值断言）、未定义引用守卫（`web/src/**/*.css` 每个 `var(--wb-*)` 在 tokens.css 有定义）、grep 守卫（feature/routes css 与 tsx 无 `#hex`/`rgba?(`/`--wb-palette-`；`web/src/ui/**/*.tsx` 无 `style={`）、`motion.css` 文本断言、`ATTRIBUTION.md` 条目断言、Icon/BrandMark RTL。

## Non-goals
Radix 组件（#276–#279）；既有对话框迁移（#280/#302）；任何页面/feature 视觉改动；夹具。

## Capabilities
### New
- `ui-primitives`：本切片交付父 change 三个 Requirement 中的「设计 token 全集」（完整）与「基元组件库」「动效与图标」的首刀子集（标题与父 change 一致；#276–#279 以 MODIFIED 扩展「基元组件库」，#295 以 MODIFIED 给「动效与图标」补 ui-walk 断言）。
### Modified
无。

## Impact
- `web/package.json`（+`lucide-react`）、`package-lock.json`；`web/src/styles.css`（token 块移出、`--wb-home-bg`/`--wb-control-bg` 四处引用改名）、`web/src/styles/tokens.css`、`web/src/ui/*`、`web/src/features/chat/chat.css`（仅注释）、`ATTRIBUTION.md`、`web/test/ui-*.test.ts(x)`。
- knip：`Icon`/`BrandMark` 由单测消费（`test/**` 是 entry）；`lucide-react` 被 `icon.tsx` 消费。
- `make ui-walk`/`make smoke` 不受影响（视觉与 DOM 不变）。

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：前端通用契约——呈现类任务至少 expanded；触碰共享入口 `styles.css` 与新的公共出口 `ui/index.ts`)
Blast radius: token 值/名错一处即全站配色偏差且被后续 27 个 issue 继承；styles.css 收缩若丢规则或丢变量（`--wb-home-bg`/`--wb-control-bg` 四处引用）则登录/外壳/设置页背景静默变透明——`make ui-walk` 不检查颜色，只有未定义引用守卫能抓；grep 守卫过严会误伤既有 css。
Selected risk packs: Public API / CLI / script entry（`ui/index.ts` 出口）；Config / project setup（新依赖、ATTRIBUTION）；Schema / columns / units / field names（token 名/值契约）；Legacy compatibility / examples（既有 styles.css 消费者与三份 feature css）；Release / packaging / dependency compatibility（lucide-react 打包离线）；Documentation / migration notes（来源头注释、ATTRIBUTION）。
Evidence floor: `make check`（lint/typecheck/test/anti-drift）exit 0；新增单测各自先红后绿（含 `rgba(` 与未定义引用的负例）；`npm run build --workspace web` 产物无公网字体请求（grep dist 无 `fonts.googleapis`/`Poppins` URL）；`make ui-walk` 对运行中服务全绿（视觉不变的运行时证据）。
