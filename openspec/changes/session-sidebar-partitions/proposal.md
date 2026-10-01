# Proposal: session-sidebar-partitions（#530）

## Why
父 change `s1c-session-metadata-presentation` tasks 7.1（epic #509，design D7）。5.1 合入后会话视图已含 `pinnedAt`/`workspaceId`，但侧栏仍是 `session-nav.tsx` 的平铺列表，没有消费者。本刀把列表换成「置顶任务 / 任务 / 空间」三分区互斥列表，加纯前端的状态×时间筛选，并让会话页在读取会话列表时并行读取工作空间列表（供分组，以及后续 7.3、7.5a 消费）。纯函数分区/筛选与侧栏渲染是同一不变量的计算端与呈现端，`session-nav.tsx` 的取代与删除必须同刀，否则页面出现两个列表。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: 所有视口的侧栏列表区（文档流侧栏与 `≤760px` 导航覆盖层）；被 jsdom 与 ui-walk 依赖的既有 DOM 钩子；会话页每次列表刷新多一个 `GET /api/workspaces`；`page.tsx` 行数预算（基线 659，本刀起每刀至多 +10）。
Selected risk packs: Legacy compatibility / examples（既有 DOM 钩子不变，既有测试只做 design D7 封闭清单的改动）；Concurrency / shared state / ordering（两个并行请求互不等待、迟到响应、槽位节点卸载后筛选状态保留）；Error handling / rollback / partial outputs（工作空间读取失败只影响归组）；Schema / columns / units / field names（`updatedAt` 毫秒与本地日历日边界、分区计数）；Documentation / migration notes（`session-nav.tsx` 删除后的引用）
Evidence floor: 新建 `web/test/session-groups.test.ts` 与 `web/test/chat-page-sidebar.test.tsx` 覆盖 design「Required evidence」；既有测试只做 design D7 封闭清单的改动后全绿；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；CI `ui-walk` job 两个 project 全绿（不改动的既有走查，回归门）。真实浏览器 + 视口矩阵的验收由组 8（8.2a/8.2b）承担；本刀另附一次 390×844 的一次性真实浏览器观察（不入库），用于确认 design「已知残留」1。

## What Changes
- 新建 `web/src/features/chat/session-groups.ts`：筛选与分区纯函数、筛选值类型与默认值。
- 新建 `web/src/features/chat/session-sidebar.tsx`：取代 `session-nav.tsx`；分区/子组 `role="group"`、空态、既有钩子。
- 新建 `web/src/features/chat/session-filter.tsx`：`筛选任务` 按钮 + `Popover` + 两个 `SegmentedControl`。
- 新建 `web/src/features/chat/workspace-list.ts`：`useWorkspaceList(client)`——带 fence 的工作空间读取与「沿用上次成功结果」。
- 删除 `web/src/features/chat/session-nav.tsx`。
- `web/src/features/chat/page.tsx`：筛选 state、工作空间 hook、`refreshList` 一行并行触发、侧栏槽位改挂 `SessionSidebar`（659 → ≤669）。
- `web/src/features/chat/chat.css`：滚动容器由 `.chat-session-list` 上移到包住全部分区的容器，加分区/子组标签、工具行与空态样式。
- 新建两个测试文件；既有测试只做 design D7 封闭清单的改动（改引用、补映射、`listTitles` 选择器收窄）。

## Capabilities
- ADDED `session-sidebar`「分区侧栏」「状态与时间筛选」。
- MODIFIED `spa-shell`「路由 IA 与侧栏」：只改列表区一句（平铺 → 三分区，内容归属加 session-sidebar）。
- MODIFIED `chat-web`「会话页」：只改 List 一句（按 session-sidebar 的分区与筛选渲染）。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **第四个产品文件 `workspace-list.ts`**：issue 的 PR Boundary 写「新建三个产品文件」。带 fence 的并行读取（abort、代际、client 归属、401 忽略）写进 `page.tsx` 要二十行以上，超出 +10 预算；它也不属于纯函数文件或侧栏组件的职责，且 7.3（composer footer）与 7.5a（文件变更卡）要消费同一状态，不该从侧栏组件文件导入。
2. **`web/src/features/chat/chat.css` 有改动**：PR Boundary 未列样式文件。多个分区后 `.chat-session-list` 不能再各自滚动，滚动容器必须上移（含覆盖层 `flex: none` 规则），否则 `≤760px` 出现嵌套滚动条。
3. **`nav` 类名不改**：仍为 `chat-session-nav`，所以 `chat-composer.test.tsx:228` 的选择器与 `sidebar.css:45` 的注释不动；issue 写的 `:226` 改引用以改名为前提，本刀不改名。`:202` 的源文件路径改为 `session-sidebar.tsx`。
4. **「分区侧栏」裁掉 7.2a 的部分**：父文「并在行尾增加「更多」触发按钮（见「会话条目菜单」）」与 Scenario「置顶与取消置顶后的移动」不并入（菜单属 7.2a）。chat-web List 句裁掉 `and entry menus`。spa-shell 只并入列表区一句；父 delta 该 Requirement 的其余改动（会话页上报 `actions`、删去「无重命名/搜索/更多按钮直到对应阶段」、插槽段末句）属 7.2a 起的后续刀。
5. **「已读取空间列表」写明语义**：父文「`workspaceId` 不在已读取空间列表中（含空间列表读取中或失败）」没有区分首次读取与重新读取。每个回合结束都会 `refreshList`；若重新读取期间也算「读取中」，绑定会话会在 `未知空间` 与空间名子组之间来回跳。子 delta 写明：首次读取完成前与最近一次读取失败后归 `未知空间`，重新读取进行中沿用上一次成功结果；并补「两个请求互不等待」与对应场景分支。父文应同步采纳。
6. **外点关闭不归还焦点**：父文「Escape 或点击外部关闭并把焦点还给 `筛选任务`」对外点不成立——`Popover` 是 Radix 非模态弹层，外部交互关闭时不把焦点拉回 trigger（`@radix-ui/react-popover` `PopoverContentNonModal.onCloseAutoFocus`）。子 delta 写成「Escape 关闭并归还焦点；外点关闭、不归还焦点」。父文应同步采纳。
7. **筛选呈现用 `SegmentedControl`**：两个单选组直接用既有基元（Radix RadioGroup：`radiogroup`/`radio`/`aria-checked`、方向键），而非 demo:1828-1851 的竖排菜单项；feature 不得绕过 `web/src/ui/index.ts` 直接引 Radix。已写进子 delta 作为有意偏差。
8. 子 delta 另写明三处父文未写的可观察行为：筛选按钮与单选项不关闭导航覆盖层；筛选状态在折叠/展开侧栏与关闭/重开覆盖层后保留（状态归会话页而非槽位节点）；「今天」的当前时间取渲染时刻、不设定时器。新增 Scenario「筛选跨覆盖层保留」。

## Impact
- web：四个新产品文件、一个删除、`page.tsx` 接线、`chat.css`、两个新测试文件、design D7 封闭清单内的既有测试改动。server 与 `web/e2e/**` 无改动。
- 运行时：会话页每次 `refreshList` 多一个 `GET /api/workspaces`。
- 依赖：#517（5.1）、#529（7.0）、A #489 已合并。

## Non-goals
- 条目「更多」菜单、重命名、置顶、删除（7.2a/7.2b）；composer footer 与工作空间读取状态/错误文案的暴露（7.3）；文件变更卡（7.5a）；新的 ui-walk 步骤（8.2a/8.2b）；`Popover` 层级（#715）；筛选生效中的按钮提示态（规格与 demo 均无）；`docs/acceptance/demo-parity-checklist.md` CH-14/CH-15 的实现位置列（带 `@#424`/`@#654` 的历史取证，S1e 签收文档，不在本刀更新）。
