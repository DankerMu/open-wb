# Design: files-empty-states-layout（#294）

Fixture level: expanded（父 tasks 组 5 声明；三档像素布局只能在真实浏览器证明，归 6.1）。
Risk packs: Public API / CLI / script entry（条目按钮可访问名是 jsdom 与 ui-walk 定位面）；Legacy compatibility（既有空态/不支持态断言）；Error handling（不支持态不发请求）。

Change surface:
- 修改：`web/src/features/files/{tree.tsx,page.tsx,preview.tsx,types.ts,files.css}`。
- 测试：新增 `web/test/files-empty-layout.test.tsx`。改写 `web/test/files-page.test.tsx:530-531`（F4）与 `web/test/preview.test.tsx:469-499`（不支持态两例）。
- 不改：`web/src/ui/**`、`web/e2e/**`、`web/src/lib/**`、服务端、`dialogs.tsx`、`md-render.ts`、`csv.ts`、`file-meta.ts`。

Must preserve:
- 文件行按钮可访问名恰为 `entry.name`。目录行按钮 `aria-label` 仍为 `展开|折叠 <label>`。`aria-current`、`aria-expanded`、选中类名不变。
- `未选择文件` 仍可按 exact 文本命中（`main.test.tsx:74`、`files-page.test.tsx:372`）；`该类型不支持预览` 仍可按文本命中（`files-page.test.tsx:146`、`preview.test.tsx`）。
- 不支持类型不发 file 请求（`tree.tsx:450-454` 行为不变）。预览头 `91 B · <ISO>` 元数据文本不变。
- 无空间态：`未选择工作空间`、`＋` 菜单可新建工作空间、`新建文件夹` 提示 `当前工作空间没有可写目录` 均不变。
- ui-walk 全绿、不改。
- ui-guardrails：feature css/tsx 无字面颜色或 palette；基元只经 `../../ui/index.js` 导入；注释不含 `#NNN`。size-guard：各文件 ≤ 800 行。

Must add/change:
- `tree.tsx`：
  - `import { EmptyState, Icon } from "../../ui/index.js"`（与既有 `Icon` 导入合并）。
  - `DirectoryNode` 空列表分支：
    ```tsx
    {entries.length === 0 ? (
      <li className="files-tree-item">
        {path === "" ? (
          <EmptyState description="点击左上角 ＋ 新建文件夹" title="该工作空间暂无目录" />
        ) : (
          <p className="files-tree-folder-empty ui-muted">空目录</p>
        )}
      </li>
    ) : ( … )}
    ```
  - 目录按钮加 `title={label}`；文件按钮加 `title={entry.name}`。两者都把 `title` 放在按钮上：6.1 断言的"行"就是按钮，且按钮有内容，`title` 只作可访问描述。
  - `EmptyPreview`：
    ```tsx
    <div className="files-preview-empty">
      <EmptyState description="在左侧目录树中选择一个文件进行预览" title="未选择文件" />
    </div>
    ```
- `page.tsx`：无空间 `directory` 改为 `<EmptyState description="使用左上角 ＋ 新建工作空间" title="先选择或创建工作空间" />`（文案不变，去掉手写 `files-tree-empty ui-empty` 段落）。
- `preview.tsx`：
  - 本地 `PreviewState` 与 `types.ts` 的 unsupported 分支都改为 `{ status: "unsupported" }`。
  - `PreviewBody` 增 `size: number` 参数，由 `PreviewPane` 传入；不支持分支：
    ```tsx
    <div className="files-preview-empty">
      <EmptyState description={`${name} · ${formatSize(size)}\u3000二进制或未识别格式`} title="该类型不支持预览" />
    </div>
    ```
    源码可写 `\u3000` 转义，也可写字面全角空格；测试一律用 `\u3000` 转义断言 `textContent`。
- `files.css`：
  - `.files-tree-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`（删 `overflow-wrap:anywhere`）。
  - 在既有 `@media (max-width: 760px)` 之前新增：
    ```css
    @media (max-width: 900px) {
      .files-layout {
        grid-template-columns: 210px minmax(0, 1fr);
      }
    }
    ```
    760 块把 `.files-layout` 改为 `display:flex; flex-direction:column`，`grid-template-columns` 不再生效，两块无冲突。
  - （审查后顺带，PR #356 第二提交）`.files-preview-empty .ui-empty-state { min-width: 0; }` 与 `.files-preview-empty .ui-empty-state-desc { overflow-wrap: anywhere; }`：居中横向 flex 中长名副行可收缩换行；E5 钉住。
  - 删除 `.files-tree-empty` 与 `.files-tree-empty p`、`.files-preview-empty p`。`.files-preview-empty` 改为 `flex:1; min-height:0; display:flex; align-items:center; justify-content:center;`（padding 与 gap 由 `.ui-empty-state` 提供）。
  - 更新文件头来源注释：补 `resource/workbuddy-live-demo.html:3854,3877,3910,3919`（空态文案）与 900 断点 `demo:723`（`@media (max-width:900px){ .fs-tree{width:210px} }`）。

Sketch seams under test（`web/test/files-empty-layout.test.tsx`，沿用 `files-fixture.tsx` 的 `renderFiles`/`authenticatedFilesRoutes`/`workspace`/`cleanupFilesFixture` 与 `support.ts` 的 `jsonResponse`）：
- (E1) 空根：根路由 `{ path: "", entries: [] }`。
  - `findByText("该工作空间暂无目录", { exact: true })` 与 `getByText("点击左上角 ＋ 新建文件夹", { exact: true })` 命中，且二者同在一个 `.ui-empty-state` 内（`closest(".ui-empty-state")` 相同且非空），该节点位于 `nav[aria-label="工作空间目录树"]` 内。
  - `queryByText("空目录")` 与 `queryByText("此文件夹为空")` 为 null。
  - 预览区（`getByRole("region", { name: "文件预览" })`，即 `tree.tsx` 的 `section[aria-label="文件预览"]`）内 `未选择文件` 与 `在左侧目录树中选择一个文件进行预览` 同在一个 `.ui-empty-state` 内。
- (E2) 空目录与不支持态：根含 `{ name: "out", type: "dir", size: 0, mtime: 101 }` 与 `{ name: "归档.zip", type: "file", size: 90492109, mtime: 102 }`，`out` 路由 `{ path: "out", entries: [] }`。
  - 点 `展开 out` 后 `findByText("空目录", { exact: true })` 命中；`queryByText("该工作空间暂无目录")` 为 null。
  - 点 `getByRole("button", { name: "归档.zip" })` 后 `findByText("该类型不支持预览", { exact: true })` 命中，其 `closest(".ui-empty-state")` 内 `.ui-empty-state-desc` 的 `textContent` 严格等于 `"归档.zip · 86.3 MB\u3000二进制或未识别格式"`（`toBe`）。不用 `getByText`：testing-library 默认把 DOM 文本的 `\s`（含 U+3000）规整为半角空格，而匹配串不规整，全角空格断言永远对不上。
  - fetchMock 调用中无路径含 `/file?` 的请求。
- (E3) 无空间：`authenticatedFilesRoutes([])`，`findByText("先选择或创建工作空间", { exact: true })` 与 `getByText("使用左上角 ＋ 新建工作空间", { exact: true })` 同在一个 `.ui-empty-state` 内。
- (E4) 长名：`LONG_DIR = "d".repeat(52)`、`LONG_FILE = "f".repeat(52) + ".md"` 放在根层。
  - `getByRole("button", { name: \`展开 ${LONG_DIR}\` })` 的 `title` 恰为 `LONG_DIR`。
  - `getByRole("button", { name: LONG_FILE })`（exact，唯一命中）的 `title` 恰为 `LONG_FILE`。
  - 根行按钮（`折叠 root`）的 `title` 为 `root`。
- (E5) 静态契约（`readRepoFile`/`stripComments`/`blockBody`）：
  - `.files-layout {` 块含 `grid-template-columns: 280px minmax(0, 1fr)`。
  - `@media (max-width: 900px) {` 块内含 `.files-layout` 且含 `grid-template-columns: 210px minmax(0, 1fr)`。
  - `@media (max-width: 760px) {` 块内含 `flex-direction: column`。
  - `.files-tree-name {` 块含 `min-width: 0`、`overflow: hidden`、`text-overflow: ellipsis`、`white-space: nowrap`，不含 `overflow-wrap`。
  - `.files-code,\n.files-table {` 块与 `.files-md {` 块均含 `overflow: auto`。
  - `tree.tsx` 与 `page.tsx` 不含 `此文件夹为空`、`files-tree-empty`、`ui-empty"`（字面，含结尾引号，以免误伤 `ui-empty-state`）；`preview.tsx` 与 `types.ts` 不含 `status: "unsupported"; message`（error 分支的 `preview.message` 保留）。
  - 无 `COLOR_LITERAL_PATTERNS` 命中。
- `files-page.test.tsx:530-531`（F4，#293 移交反转）：改为 `expect(nameRule).toContain("text-overflow: ellipsis")` 与 `expect(nameRule).not.toContain("overflow-wrap")`。
- `preview.test.tsx`：
  - `:469-483`：保留 `该类型不支持预览` 与 `91 B · ${FILE_MTIME_ISO}`；把 `queryByText("二进制或未识别格式")).toBeNull()` 反转为：`document.querySelector(".ui-empty-state-desc")?.textContent` 严格等于 `"归档.zip · 91 B\u3000二进制或未识别格式"`。
  - `:485-499` 改写：`message` 字段已删，改为用含标记的文件名钉字面语义。`name` 与 `path` 取 `<img src=x onerror="alert(1)">.zip`，`preview={{ status: "unsupported" }}`，断言 `.ui-empty-state-desc` 的 `textContent` 严格等于 `\`${name} · 91 B\u3000二进制或未识别格式\``，且 `document.querySelector("img")` 为 null。

Required evidence：
- E1–E5 与两处改写在现实现上先红，记录原因；实现后转绿。
- 反向注入，各自变红后回退（记录失败的测试名）：
  1. 空根仍显示 `空目录`（去掉 `path === ""` 分支）→ E1 红。
  2. 非根空目录仍显示 `此文件夹为空` → E2 红。
  3. 不支持态副行用字节原值（`${size} B`）→ E2 红（`preview.test.tsx` 的 91 B 两种写法结果相同，不红）。
  4. 副行用半角空格 → E2 红。
  5. 文件按钮去掉 `title` → E4 红。
  6. 目录按钮去掉 `title` → E4 红。
  7. 删除 900 断点块 → E5 红。
  8. `.files-tree-name` 去掉 `min-width: 0` → E5 红。
  9. `EmptyPreview` 回退为手写段落 → E1 红（不在 `.ui-empty-state` 内）。
- `make check`、`npm run build --workspace web`、`(cd web && npx vitest run)`、CI 形态 ui-walk 全部 exit 0。

Not yet specified:
- 树区 `EmptyState` 在 210px 窄栏中的内边距是否需要收紧（`.ui-empty-state` 默认 `56px 20px`）。本刀不覆盖基元样式；是否收紧由 6.3a 截图对比决定。
