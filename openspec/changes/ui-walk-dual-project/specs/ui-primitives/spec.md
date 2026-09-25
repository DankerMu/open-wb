# Spec: ui-primitives

## MODIFIED Requirements

### Requirement: 动效与图标
`Icon` SHALL 是单一组件：`name` 为本仓用到的 lucide 图标名联合类型，内部维护 name→组件映射、不逐个再导出 lucide 图标；size `12|14|16|18|20`（类名 `ui-icon-<size>`）；默认 `aria-hidden="true"`，传 `label` 时为 `role="img"` 且以 `label` 为可访问名。`web/src/ui/motion.css` SHALL 提供 demo 的 `wb-fadein`、`wb-pop`、`wb-pulse`、`wb-caret`、`wb-spin`、`wb-drawer-in` 关键帧与对应工具类（`ui-fadein`、`ui-pop`、`ui-pulse`、`ui-caret`、`ui-spin`），并在 `prefers-reduced-motion: reduce` 下把每个工具类置为 `animation: none` 与 `transition: none`；demo 未使用的 `wb-float`/`wb-shimmer` 不移植。图标 SHALL 全部经 `Icon` 取自 `lucide-react`（ISC，打包进产物，运行时零网络请求），`ATTRIBUTION.md` SHALL 新增 lucide（ISC）与 Radix UI Primitives（MIT）条目。

#### Scenario: 图标可访问、动效可禁用、归属登记
- WHEN 在 jsdom 渲染 `<Icon name="folder" />` 与 `<Icon name="folder" label="目录" size={12} />`，并静态读取 `motion.css` 与 `ATTRIBUTION.md`
- THEN 第一个 svg `aria-hidden="true"`；第二个 `role="img"`、可访问名 `目录`、类名含 `ui-icon-12`；`motion.css` 的 reduced-motion 块覆盖全部五个 `ui-*` 工具类；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目

#### Scenario: 图标离线、动效可禁用且归属登记
- WHEN `make ui-walk` 的 `desktop-light` project 在 journey 内统计 resourceType 为 `image|font|stylesheet|script` 的 `requestfailed`（导航/SSE 取消的 `net::ERR_ABORTED` 不计）与非 `baseURL` 源的请求，并在受控回合运行中对 `.ui-pulse` 元素先 `emulateMedia({reducedMotion:"reduce"})` 再恢复 `no-preference`；`web/test` 静态读取 `motion.css`
- THEN 全 journey 零静态资源 `requestfailed`、零跨源请求（图标离线可用）；reduce 下 `animationName` 为 `none`、恢复后非 `none`；`motion.css` 的 reduced-motion 块把每个 `ui-*` 动效类置为 `animation: none` 且 `transition: none`；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目
