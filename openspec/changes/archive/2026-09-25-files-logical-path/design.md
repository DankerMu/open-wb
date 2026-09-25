# Design: files-logical-path（#292）

Fixture level：expanded（父组 5 声明：逻辑路径涉及信息暴露面）。Review priority：decision-dense——绝对路径不出现在 UI 的边界。

Risk packs：Auth/permissions/secrets（服务器沙箱绝对路径属内部布局信息，不得出现在界面文本/title/aria）、Legacy compatibility（files 既有断言与 ui-walk 定位）、Schema/field names（`Workspace.root` 保留但不渲染；逻辑路径由 `account` + `dir` 拼接）。

## Governing invariant

文件页任何渲染状态下（切换器卡、切换器弹层列表、树根行、`新建文件夹` 位置下拉、`新建工作空间` 对话框），`document.body.textContent` 与所有元素的 `title`、`aria-label`、`aria-description`、`placeholder`、`<option>` 文本 SHALL 不含任一 workspace 的 `root` 值（也不含其沙箱前缀）；需要表达"在哪"的位置一律显示逻辑路径 `<account>/<dir>` 或空间名。

## Sibling surfaces

- 生产：`web/src/features/files/page.tsx:72-81`（过滤）、`:98`（卡副行）、`:128`（列表项副行）、`:141`（无匹配文案）、`:184-185`（`FilesPage` 取 `useAuth`）；`web/src/features/files/tree.tsx:221-227`（`DirectoryTree` 根 `label="root"`）、`:116-149`（`DirectoryNode` 按钮：`aria-label`/`title`/`folder` 图标）、`:298`（`WorkspaceBrowser` props）、`:599`/`:616`（`DirectoryTree`/`DirectoryDialog` 挂载）；`web/src/features/files/dialogs.tsx:203`（位置根项）；`web/src/features/files/file-meta.ts`（`fileIcon`/`formatSize` 所在，`logicalPath` 放这里）；`web/src/features/files/files.css`。
- 其它渲染 `root` 的地方：`grep -rn "\.root\b" web/src` 只有 `page.tsx:98,128`（chat/settings 不渲染 workspace）。预览头显示的是相对路径（`preview.tsx`），不变。
- 测试（jsdom）：
  - `web/test/files-fixture.tsx:106`（`折叠 root` 等待根列表）；
  - `web/test/files-page.test.tsx:49`（`workspace.root` 文本）、`:173`（位置选项 `["根目录　root","out"]`）、`:376,409,411,417`（按 `root` 文本等待空间切换）；
  - `web/test/files-empty-layout.test.tsx:103`（根按钮 `折叠 root` 的 `title`）；
  - D5 之后空间名与逻辑路径各在两处出现（切换器卡 `strong`/副行 与 树根 `.files-tree-name`/根副行），以下 `getByText(…, { exact: true })` 会多重命中而抛错（`waitFor` 内即超时）：`files-page.test.tsx:48`（`设计文档`）、`:116`（`.files-tree-name` 列表首项由 `root` 变空间名）、`:300`（`新空间`）；`files-errors.test.tsx:118`（`可重试空间`）；`web/test/auth-session-client.test.tsx:369`（`李四文档`；该文件 `:89-107` 直接挂载 `FilesPage`，不在 `files-*` 命名内）；
  - `web/test/files-overlays.test.tsx`、`files-concurrency.test.tsx`、`files-errors.test.tsx` 经 fixture helper 间接依赖根按钮名。
- e2e：`web/e2e/ui-walk.spec.ts:496`（`selectOption({ label: "根目录　root" })`）；walkFiles 的树按钮定位（`readme.md` 等）不依赖根名。
- smoke：`smoke/files.hurl` 只测 API，`root` 字段保留，不变。

## Decisions

- **D1 `logicalPath(account: string, dir: string): string`** 返回 `` `${account}/${dir}` ``，无前导 `/`，不做规范化（`dir` 由服务端生成/校验，单段）。放 `file-meta.ts`，与 `fileIcon`/`formatSize` 同为呈现纯函数。
- **D2 account 来源**：`FilesPage` 从 `useAuth()` 取 `principal`；`principal` 为 null 时 `FilesPage` 返回 `null`（与 `auth/footer.tsx:30` 同口径；`/files` 只在认证路由下渲染，此分支不可达，不造回退文案）。`account` 以 prop 下传给 `WorkspaceSwitcher` 与 `WorkspaceBrowser`（或下传已拼好的逻辑路径，由实现取最小接线）。
- **D3 切换器卡**：`Icon name="layout-grid" size={16}` + 空间名 + 副行逻辑路径；无当前空间时 `未选择工作空间` / `—`（现状保留）。列表项：空间名 + 副行逻辑路径 + 当前项 `当前工作空间` 勾（现状保留）。
- **D4 过滤**：`query.trim().toLocaleLowerCase()` 为空时全列；否则保留空间名或逻辑路径（均 `toLocaleLowerCase()`）包含该子串的项。无匹配时列表为空并显示 `无匹配的工作空间`（替换 `没有匹配的工作空间`）。搜索框可见标签与 placeholder `搜索工作空间` 不变。
- **D5 树根行**：根 `DirectoryNode` 以空间名为 `label`（可访问名 `展开|折叠 <空间名>`、`title` 空间名），图标由 `folder` 改为 `shield`（仅根）；按钮之后（仍在根 `li` 内、子列表之前）渲染副行 `p.files-tree-root-path`，文本为逻辑路径。子目录节点不变。与根同名的子目录会与根共享可访问名前缀——根恒为树内第一个节点，接受，不加消歧文本。
- **D6 位置下拉**：根项文案 `根目录　<空间名>`（全角空格保留），其余项仍为相对路径。`DirectoryDialog` 新增必需 prop（如 `rootLabel`/`workspaceName`），由 `WorkspaceBrowser` 传入。
- **D7 样式**：`.files-tree-root-path` 用 token（`--wb-text-tertiary` 一类既有语义色）、小号字、单行 `text-overflow: ellipsis`；切换器卡图标沿用 `.files-switcher-trigger` 的 flex 对齐。不引入 hex/rgba。

## Must preserve

- `?ws=` 选择/纠正/历史语义、空间切换清空展开态与当前文件、代际守卫（`files-page`、`files-concurrency`、`files-errors` 断言意图不变，只改定位文本）。
- 切换器 `dialog` 名 `工作空间切换器`、`搜索工作空间`、`当前工作空间`、`＋ 新建工作空间`；`＋` 菜单与两个对话框行为（#302）不变。
- 子目录/文件条目的可访问名、图标、大小、`title`（5.2/5.3）不变；空根 `EmptyState` 文案不变。
- API 客户端与 `Workspace` 类型不变；`root` 仍被解析（`api.ts` 严格校验不动）。
- ui-walk：两次 `/api/auth/me` 401、零非预期 console/page error；walk-out 挂起焦点断言（#302）不变。

## Must add/change

- 新 `web/test/files-logical-path.test.tsx`（`files-page.test.tsx` 已 ~540 行）：
  - L1 `logicalPath` 表驱动：`("zhangsan","smoke-fixture")` → `zhangsan/smoke-fixture`；中文 `dir` 原样；结果不以 `/` 开头。
  - L2 不外泄：两个空间的 `root` 取带私有前缀的值（如 `/srv/private-sandbox/user-1/<dir>`），依次在 初始页（卡 + 树根）、切换器打开、`新建文件夹` 对话框打开、`新建工作空间` 对话框打开 四个状态下断言：`document.body.textContent` 与所有带 `title`/`aria-label`/`aria-description`/`placeholder` 属性的元素的属性值都不含任一 `root` 值，也不含 `/srv/private-sandbox`；另在每个状态断言 `document.body.innerHTML` 不含任一 `root` 值与私有前缀（覆盖 `value`/`data-*`/`href` 等全部属性）；同时卡与列表中出现 `zhangsan/<dir>`。
  - L3 切换器卡：含 `lucide-layout-grid` svg、空间名、`zhangsan/<dir>`。
  - L4 树根行：根按钮可访问名 `折叠 <空间名>`（初始展开）、`title` 为空间名、含 `lucide-shield` 且不含 `lucide-folder`；副行文本 `zhangsan/<dir>`；树内无文本恰为 `root` 的节点。
  - L5 过滤：两空间 `数据分析`（dir `analytics`）与 `设计文档`（dir `design-docs`）：输入 `数据` 只剩前者；输入 `DESIGN`（大写）只剩后者（逻辑路径大小写无关命中）；输入 `zhangsan/ana` 只剩前者；输入 `不存在` 列表无项且显示 `无匹配的工作空间`。
  - L6 位置下拉：选项文本首项为 `根目录　<空间名>`，其余为已加载目录相对路径。
- 既有测试按 Sibling surfaces 改定位文本，断言意图不变：`折叠 root` → `折叠 <空间名>`；`根目录　root` → `根目录　<空间名>`；`files-page.test.tsx:376,409,411,417` 的 `findByText(x.root)` 改为在切换器卡内（`within(getByRole("button", { name: "选择工作空间" }))`）查逻辑路径；上一条列出的多重命中点同样改为作用域查询（卡用上述 `within`，树用 `within(getByRole("navigation", { name: "工作空间目录树" }))`），不得改用 `getAllByText` 放松断言；切换空间会按 `key` 重挂 `WorkspaceBrowser`（`page.tsx:383-409`），切换器卡随之重挂，故作用域须在每次重试时重新查询（如 `await waitFor(() => within(screen.getByRole("button", { name: "选择工作空间" })).getByText(lp))`），不得先取一次元素再对其 `findByText`；`files-fixture.tsx:106` 的等待改为按当前空间名。`files-page.test.tsx:448` 的私有 `hasLucideGlyph` 移到 `files-fixture.tsx` 导出供新文件复用，不复制。
- ui-walk：`:496` label → `根目录　smoke-fixture`（`SMOKE_FIXTURE` 常量）。
- 反向注入（各自单独施加、观察红、回退）：
  1. 列表项副行改回 `workspace.root` → L2 红。
  2. 过滤谓词只看空间名 → L5 `DESIGN`/`zhangsan/ana` 用例红。
  3. 树根 `label` 改回 `"root"` → L4 红。
  4. 位置根项改回 `根目录　root` → L6 红；本地 CI-env ui-walk 在 `selectOption` 红。
  5. `logicalPath` 加前导 `/` → L1 红。
  6. 根行图标改回 `folder` → L4 红。

## Required evidence

- 先红：L1–L6 迁移前运行（L1 因函数不存在红；L2–L6 红），记录。
- `make check` exit 0；`npm run build --workspace web` exit 0；CI-env 本地 ui-walk exit 0。
- 反向注入 1–6 各红（ui-walk 仅注入 4 需要）。
- 行数：新 test 文件、`page.tsx`、`tree.tsx` ≤ 800，`wc -l` 记入 PR。

## Not yet specified

- 在线点/只读/卸载与挂载目录（S1b），根行副行在远端挂载时的 `host:path` 形态（S1b）。
