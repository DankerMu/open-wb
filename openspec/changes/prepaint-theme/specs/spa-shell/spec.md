## ADDED Requirements

### Requirement: 首帧前主题
`web/index.html` SHALL 在 `<head>` 内（构建后位于样式表 `<link>` 之前）含一段经典（非 module）内联脚本：读取 `localStorage["workbuddy-theme"]`，按 `web/src/lib/theme.ts` 的规则解析（`light`/`dark`/`system`，非法值与读取抛错回落为 `system`；`system` 按 `matchMedia("(prefers-color-scheme: dark)")` 解析，`matchMedia` 不可用或抛错时按 `light`），并在首次样式解析前写入 `document.documentElement.dataset.theme`。脚本 SHALL 用 try/catch 包住全部存储与媒体查询访问，任何异常都不得阻断页面加载。挂载后的同步（设置页切换、跨标签页 `storage` 事件、`system` 下系统配色变化）仍由 `ThemeProvider` 负责，行为不变；对同一输入，内联脚本与 `theme.ts` 的解析结果 SHALL 一致，因此挂载时根元素主题不再变化。

#### Scenario: 冷加载首帧即为目标主题
- **WHEN** `make ui-walk` 的 `desktop-light` project 在独立 test 中为三种输入各开一个全新 context 打开 `/files`（未登录，由守卫渲染登录页）：存储 `dark` + 系统浅色、存储 `system` + 系统深色、存储 `light` + 系统深色；经 `addInitScript` 预置存储，并以同一 `MutationObserver`（`document` 子树 childList + `data-theme` 属性，从文档创建起记录）记录变更顺序；等到登录页标题 `登录 WorkBuddy` 可见（守卫只在 `/api/auth/me` 响应后才离开 loading，故此时 React 已挂载且该响应已到）后读取记录
- **THEN** 写入 `data-theme` 的属性记录先于插入 `rel="stylesheet"` 的 `<link>` 与 `#root` 的记录出现，写入值依次为 `dark`、`dark`、`light`；之后所有 `data-theme` 记录都保持该值；无 `pageerror`，console error 至多为该次 `/api/auth/me` 401 的 Chromium 网络日志一条（与 ui-walk oracle 的放行规则相同）

#### Scenario: 内联脚本与 theme.ts 解析一致
- **WHEN** 在 jsdom 中取出 `web/index.html` 的内联脚本，对用例表中的每个输入执行它（存储值 `light`/`dark`/`system`/非法值/`null`/读取抛错 × 系统深色/浅色/`matchMedia` 抛错/`matchMedia` 未定义），并用 `loadTheme` + `resolveTheme` 计算同一输入的期望值
- **THEN** 每个输入下脚本写入的 `data-theme` 都与期望值相等，且没有异常逸出
