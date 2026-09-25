# Design: settings-page-parity（#300）

Fixture level: expanded（父 tasks 组 2 声明；呈现面由 jsdom 结构断言 + 本地 ui-walk 证明）。
Risk packs: Public API / CLI / script entry（可访问名是 ui-walk 与 6.1 定位面）；Legacy compatibility（迁移用例不弱化）；Documentation / migration notes（测试改写规则）。

Change surface:
- 修改：`web/src/features/settings/page.tsx`、`web/src/styles.css`、`web/src/ui/ui.css`。
- 新增：`web/src/features/settings/settings.css`、`web/test/settings-page.test.tsx`、`web/test/settings-support.tsx`。
- 测试修改：`web/test/settings-footer.test.tsx`（迁出 `describe("settings route")` 与只被它用的 helper；`迁移静态契约` 的 radix-platform 清单加入新文件）。
- 不改：`features/theme/**`、`features/auth/**`、`web/src/lib/**`、`web/src/ui/*.tsx`、`web/e2e/**`、服务端。

Must preserve:
- 主题行为：`useTheme()` 的 `selectedTheme`/`resolvedTheme`/`setTheme` 语义、`workbuddy-theme` 持久化、`data-theme`、跨 tab 与 system change。
- 关于卡数据流：Provider-owned `loadServiceInfo(signal)`、`active` 守卫、cleanup abort、loading 文案 `正在读取服务信息`、失败文案（非 401 信封 message / `请求失败，请稍后重试`）、supersede 后收敛为失败、current 401 转登录页。不得出现 `WorkBuddy`/`5.3.11` 作为 name/version 回退。
- `describe("settings route")` 每个既有用例的行为意图与数量不变；只替换改写规则列出的锚点。
- 页面级：h2 恰为 `["外观","关于"]`，无 `通用`；radiogroup 名 `主题`；`当前生效：浅色|深色` 可由 `getByText(…, { exact: true })` 找到；ui-walk（`web/e2e/ui-walk.spec.ts:92,381-382`）不改且全绿。
- `settings-footer.test.tsx`、`settings-page.test.tsx`、`settings-support.tsx` 都 ≤ 800 行；jscpd 在阈值内。
- ui-guardrails：feature css/tsx 无字面颜色或 palette，基元只经 `ui/index.js`；注释不含 `#NNN`。

Must add/change:
- `page.tsx` 结构（示意，类名为契约）：
  ```tsx
  function SettingsRow({ children, control }: { children: ReactNode; control?: ReactNode }) {
    return (
      <div className="settings-row">
        <div className="settings-row-text">{children}</div>
        {control ? <div className="settings-row-control">{control}</div> : null}
      </div>
    );
  }
  // AppearanceCard
  <section aria-labelledby={headingId} className="settings-section">
    <h2 className="settings-sec-h" id={headingId}>外观</h2>
    <div className="settings-card">
      <SettingsRow control={<SegmentedControl label="主题" options={THEME_OPTIONS} value={selectedTheme} onValueChange={setTheme} />}>
        <div className="settings-row-title">主题</div>
        <div className="settings-row-desc">浅色 / 深色 / 跟随系统 · 即时生效并持久保存</div>
      </SettingsRow>
      <SettingsRow>
        <div aria-hidden="true" className="settings-row-title">当前生效</div>
        <div aria-hidden="true" className="settings-row-desc">{`${current} · 持久保存于 localStorage`}</div>
        <span className="ui-sr-only">{`当前生效：${current}`}</span>
      </SettingsRow>
    </div>
  </section>
  // AboutCard：同样 section/h2/card；一行，BrandMark 放在 settings-row-text 之前
  <div className="settings-row">
    <BrandMark size={32} />
    <div className="settings-row-text">
      {loading ? <div className="settings-row-desc">正在读取服务信息</div> : null}
      {error ? <p className="ui-alert" role="alert">{error}</p> : null}
      {serviceInfo ? (<><div className="settings-row-title">{serviceInfo.name}</div><div className="settings-row-desc">{`版本 ${serviceInfo.version}`}</div></>) : null}
    </div>
  </div>
  ```
  - `THEME_OPTIONS` 为模块常量 `[{value:"light",label:"浅色"},{value:"dark",label:"深色"},{value:"system",label:"跟随系统"}] as const`。
  - `useId()` 生成两个 heading id。`SettingsRow` 可按实现取舍，但类名与 DOM 次序是契约。
  - `BrandMark` 无字标，任何状态（loading/成功/失败）都渲染；它的 `role="img"` 名 `WorkBuddy` 是品牌标识，不是 name 回退。
- `settings.css`（头注释 `adapted from resource/workbuddy-live-demo.html:818-824（.set-card/.set-row/.set-t/.set-d/.sec-h）`，只用语义 token）：
  ```css
  .settings-page { overflow: auto; padding: 24px 28px 40px; }
  .settings-section { max-width: 860px; }
  .settings-sec-h { margin: 22px 0 12px; font-size: 13.5px; font-weight: 700; }
  .settings-section:first-child .settings-sec-h { margin-top: 0; }
  .settings-card { padding: 4px 16px; border: 1px solid var(--wb-border-default); border-radius: 12px; background: var(--wb-bg-secondary); }
  .settings-row { display: flex; align-items: center; gap: 16px; padding: 13px 0; }
  .settings-row + .settings-row { border-top: 1px solid var(--wb-border-default); }
  .settings-row-text { position: relative; min-width: 0; }
  .settings-row-title { font-size: 13.5px; font-weight: 650; overflow-wrap: anywhere; }
  .settings-row-desc { margin-top: 2px; font-size: 12px; color: var(--wb-text-secondary); overflow-wrap: anywhere; }
  .settings-row-control { flex-shrink: 0; margin-left: auto; }
  .settings-row .ui-alert { margin: 0; }
  @media (max-width: 760px) {
    .settings-page { padding-left: 16px; padding-right: 16px; }
    .settings-row { flex-wrap: wrap; }
  }
  ```
- `styles.css`：删除 `.settings-page`、`.settings-card*`、`.theme-options`、`.theme-option*`、`.theme-swatch*`、`.service-identity*` 全部规则（含 ≤760 块中的 `.theme-options` 与 `.settings-page`），`@import "./features/settings/settings.css";` 放在 `auth.css` 之后。
- `ui/ui.css`：
  ```css
  /* 视觉隐藏但保留可访问文本与非空几何（Playwright 可见性按非空 bounding box 判定）；不得改为 display:none/visibility:hidden。 */
  .ui-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  ```

测试迁移与改写规则：
1. `settings-support.tsx` 导出两文件共用的 helper：`authenticatedRoutes`、`createAuthenticatedFetch`、`renderApp`、`currentRouter()`（返回当前 router，供 `navigate`）、`disposeRouter()`（afterEach 调用）、`expectAuthenticatedShell`、`expectLoginAt`、`getFooter`、`openLogoutDialog`。只被一个文件用的 helper 留在原文件。两文件各自 `import "./radix-platform.js"` 与 `"./dialog-platform.js"`（按需），afterEach 保持原清理（cleanup、disposeRouter、restoreAllMocks、unstubAllGlobals、localStorage.clear、body 清空、删 `data-theme`、`setBrowserPath("/")`），由 `settings-support.tsx` 导出单个 `resetSettingsTestState()` 供两文件调用，避免 jscpd 重复。
2. radio 选中态：`(… as HTMLInputElement).checked` 一律改为 `getByRole("radio", { name, checked: true })` 存在或 `getAttribute("aria-checked") === "true"`；未选中项断言 `"false"`。点击用 `fireEvent.click(radio)`（同 `web/test/ui-segmented-control.test.tsx` G2）。
3. 关于卡容器：`getByRole("heading", { level: 2, name: "关于" }).closest("section")` 一律改为 `getByRole("region", { name: "关于" })`（`section[aria-labelledby]` 的隐式角色）。
4. 迁出用例其余断言原样保留；`requestOptionsAt(fetchMock, n)` 这类位置型断言本刀不动（LoginForm 不在这些用例中挂载）。若新用例先渲染登录页再进 `/settings`，`/api/info` 必须以数组或函数注册（#299 改写规则 1）。

Sketch seams under test（`web/test/settings-page.test.tsx`）：
- 前置：S1–S5 都先 `renderApp("/settings")` 并 `await expectAuthenticatedShell("/settings")`，保证先红记录的是结构缺失而不是外壳未挂载。
- (S1) 外观结构：`getByRole("region", { name: "外观" })` 内
  - 恰一个 radiogroup，名 `主题`，`className === "ui-seg"`；radio 文本次序 `["浅色","深色","跟随系统"]`，每个 `tagName === "BUTTON"`；默认 `跟随系统` 的 `aria-checked="true"`，另两项 `"false"`。
  - 区内无 `input[type="radio"]`、无 `fieldset`、无 `.theme-swatch`。
  - 行标题文本依次含 `主题`、`当前生效`（`.settings-row-title` 的 textContent 列表恰为 `["主题","当前生效"]`）；`getByText("浅色 / 深色 / 跟随系统 · 即时生效并持久保存", { exact: true })` 存在。
  - 页面 h2 恰为 `["外观","关于"]`，且两个 h2 都不在 `.settings-card` 内（`closest(".settings-card") === null`）。
  - 行布局：`group.closest(".settings-row")` 就是 `.settings-row-title` 为 `主题` 的那一行；`group.closest(".settings-row-control")` 非空，且在同一行的 `.settings-row-text` 之后（`compareDocumentPosition` 为 FOLLOWING）；`主题` 行与 `当前生效` 行位于同一个 `.settings-card`。
- (S2) 当前生效（显式 light 起步，`localStorage` 预置 `light`）：
  - 可见说明 `getByText("浅色 · 持久保存于 localStorage", { exact: true })`，其元素与标题 `当前生效` 元素 `aria-hidden="true"`。
  - `getByText("当前生效：浅色", { exact: true })` 的元素 `className === "ui-sr-only"`，与可见说明位于同一 `.settings-row`。
  - 点击 `深色` radio 后：`深色` `aria-checked="true"`、`浅色` `"false"`，`data-theme=dark`，storage `dark`，`当前生效：深色` 与 `深色 · 持久保存于 localStorage` 同时出现，`浅色 · …` 消失。
  - 重新挂载：`cleanup(); disposeRouter(); vi.stubGlobal("fetch", createAuthenticatedFetch()); renderApp("/settings")`（新 fetch mock 保证 Response 未被读过），`await expectAuthenticatedShell` 后 `深色` 仍选中，`当前生效：深色`。
- (S3) 跟随系统：预置 `workbuddy-theme=light`；建一个共享 `const dark = createMediaQuery(true)`，`installMatchMedia((q) => q === "(prefers-color-scheme: dark)" ? dark : createMediaQuery(false))`。
  - 起步 `浅色` 选中、`当前生效：浅色`。
  - `fireEvent.click` `跟随系统` radio → `跟随系统` `aria-checked="true"`，storage 为 `"system"`，`当前生效：深色`、`data-theme=dark`。
  - `act(() => { dark.emit(false); })`（先例 `web/test/theme-provider.test.tsx:167`）→ `当前生效：浅色`、`浅色 · 持久保存于 localStorage`、`data-theme=light`，storage 仍为 `"system"`。
  - afterEach `uninstallMatchMedia()`。
- (S4) 关于卡成功：`getByRole("region", { name: "关于" })` 内
  - `getByRole("img", { name: "WorkBuddy" })` 存在且为 `svg`（`BrandMark`），区内无 `<img>` 元素；
  - `.settings-row-title` textContent 恰为 `serviceInfo.name`，`getByText("版本 " + serviceInfo.version, { exact: true })` 存在；
  - 区 textContent 不含 `serviceInfo.auth.provider`、`5.3.11`、`Live Demo`；BrandMark、`.settings-row-title`（name）与 `版本 …` 三者 `closest(".settings-row")` 为同一元素，且 BrandMark 在该行 `.settings-row-text` 之前（`compareDocumentPosition`）。
- (S5) 关于卡 loading 与失败：info 挂起时区内有 BrandMark 与 `正在读取服务信息`；malformed（旧两键）时区内有 BrandMark、alert `请求失败，请稍后重试`、无 `.settings-row-title`、textContent 不含 `版本`。
- (S6) 静态契约（`readRepoFile`）：
  - `web/src/features/settings/page.tsx` 含 `SegmentedControl`、`BrandMark`、`ui-sr-only`，不含 `type="radio"`、`fieldset`、`theme-swatch`、`@radix-ui`。
  - `web/src/styles.css` 不含 `.theme-option`、`.theme-swatch`、`.service-identity`、`.settings-card`、`.settings-page`，含 `@import "./features/settings/settings.css";`。
  - `settings.css` 含 `demo.html:818-824`，不含 `#` 后接十六进制色值（正则 `/#[0-9a-fA-F]{3,8}\b/`）；≤760 块内含 `flex-wrap: wrap`；`.settings-row {` 规则块含 `display: flex`。
  - `web/src/ui/ui.css` 的 `.ui-sr-only` 规则块含 `position: absolute`、`width: 1px`、`clip: rect(0 0 0 0)`，不含 `display: none`、`visibility: hidden`。
- (S7) 迁移完整：迁移前 `web/test/settings-footer.test.tsx:140-346` 的 `describe("settings route")` 有 8 个声明（6 个 `it`、2 个 `it.each`）。S7 用 `readRepoFile` 读 `settings-page.test.tsx`，以完整开头 `describe("settings route", () => {` 定位块首、以下一个行首 `\ndescribe(` 或 EOF 为块尾，按正则抽出 `it("…"` 与 `it.each(...)(\s*"…"`（`it.each` 标题在 `)(` 的下一行，正则需 `\)\(\s*"`）的标题字符串，断言恰为这 8 个标题（逐字取迁移前标题，次序不限）；`settings-footer.test.tsx` 不再含 `describe("settings route"`。`迁移静态契约` 的 radix-platform 清单包含 `web/test/settings-page.test.tsx`。

Required evidence:
- 迁移先行且保持全绿：先只做测试迁移（规则 1–4 中不依赖新结构的部分，即 helper 抽取与 describe 迁移），在现实现上跑绿，记录迁移前后用例数。
- S1–S6 在现实现上先红（记录每项失败原因），实现后转绿。
- 反向注入各自变红并回退（记录失败的测试名）：
  1. `.ui-sr-only` 改为 `display: none` → S6 红；本地 ui-walk `当前生效：深色` 可见断言红。
  2. `当前生效` 行只保留 `span.ui-sr-only`，删掉可见说明 → S2 红。
  3. 可见说明写成 `当前生效：深色 · 持久保存于 localStorage` → S2 红。
  4. 外观卡恢复原生 radio + fieldset → S1 与 S6 红。
  5. `当前生效` 文本不随主题更新（写死 `浅色`）→ S2 点击后断言红。
  6. 关于卡说明追加 provider（`版本 0.0.0 · dev-stub`）→ S4 与迁移用例红。
  7. 去掉 section 的 `aria-labelledby` → S1/S4 region 查询红。
  8. 失败态不渲染 BrandMark → S5 红。
  9. 删掉 ≤760 的 `flex-wrap: wrap` → S6 红。
  10. `styles.css` 保留 `.theme-swatch-light { background: #ffffff; }` → S6 红。
  11. `SegmentedControl` 移出 `.settings-row`（放到卡片下方）→ S1 行布局断言红。
  12. 删掉一个迁移用例 → S7 红。
- `make check` exit 0（size-guard ≤800；jscpd 在阈值内；knip；biome；ui-guardrails；naming-guard 需先 `git add -N` 新文件）。
- `npm run build --workspace web` exit 0。
- `(cd web && npx vitest run)` 全绿。
- CI 形态 ui-walk exit 0（证明 Radix radio 上 `.check()`/`toBeChecked()` 与 `.ui-sr-only` 的可见性）。

Not yet specified:
- 主题行在 ≤760 换行后控件是否需要撑满整行：本刀只保证不横向溢出（换行后仍 `margin-left:auto` 右对齐）；视觉细调归 6.1 #295 截图签收。
