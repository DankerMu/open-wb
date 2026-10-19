# Design: workspace-path-stale-echo

## Context（核对于 origin/master 473b6ecf）

- `web/src/features/files/workspace-browser.tsx`（780 行，size-guard 上限 800）：
  - `:622-636` `path` effect：`appliedPathRef.current !== path` 时记下 `path`、丢掉进行中的定位；`path` 与当前选中逐字相同就不动；否则 `normalizedPath`，空的 `clearSelection()`，`..` 显示 `文件不存在`，其余发起定位。之后每次都 `continueReveal()`。
  - `:615` `usePathReapply(appliedPathRef, pathSeq)`：`pathSeq` 换新值时把 `appliedPathRef` 置 `undefined`，同一次提交里 `path` effect 把同值当新值再套用。挂载与卸载清理（`:256`）同样置 `undefined`。
  - 组件自己的上报点：`dropMissing`（`:323`，404 → `null`）、`chooseFile`（`:479`，点击）、`land`（`:542`，`reveal` 落地）、`landFiltered`（`:561`，`reveal` 落空 → `null`）、`useFollowEntry` 的 `onPathChange` 参数（`follow-entry.ts:102,106`，删除 / 改名跟随）。
- 宿主写回：会话页侧边栏 `onPathChange={setPath}` / `path={path}`（`workspace-sidebar.tsx:185,187`）；文件页 `writePath` → `navigate(…, { replace: true })` → 地址的 `path`（`page.tsx:211-222,338-339`），提交走 router 的 transition。两者都原样写回上报值，不改写法。
- `host-channel.ts`：`useSelectionReport`、`usePathReapply`，即浏览器与宿主之间 `path` / `onPathChange` 之外的通道。

## 决策

- **D1 记账（issue 方案 A）**：新 hook（建议放在 `host-channel.ts`，例如 `usePathEcho(onPathChange)`）持有一个按上报顺序排列的「已上报、未见回声」值列表，返回：
  - `report(path)`：追加到列表，然后调 `onPathChange(path)`。组件里所有原先直接调 `onPathChange` 的地方（含传给 `useFollowEntry` 的那个）都改调它。
  - 一个供 `path` effect 用的判定，例如 `superseded(path)`。设列表为 `R`，`i = R.indexOf(path)`（**首个**匹配）：
    - `0 <= i < R.length - 1`（它之后还有上报）：按被取代的回声处理。丢掉 `R[0..i]`（回声按上报顺序到达，宿主可能合并跳过中间值，但不会倒序），返回真。
    - 其余（`i === R.length - 1`：只有最近一次上报等于它；或 `i < 0`：宿主自己的值）：清空 `R`，返回假。
  - 同值重复（如 `R=[x,y,x]` 收到 `x`）取首个匹配：它若其实是被合并跳到的最后一个 `x`，跳过也无害——选中本就是最近一次上报的 `x`，只在 `R` 里留下 `[y,x]`，下一次宿主的值（只能经 `pathSeq` 或重挂，见 Non-goals）或最近一次回声会清掉它；若取「最后一项相等即套用」，先到的那个 `x` 会清空 `R`，随后单独提交的 `y` 回声被当作宿主的值，复现本问题。
- **D2 effect 的用法**：`appliedPathRef.current !== path` 分支里，**仅当 `appliedPathRef.current !== undefined`**（不是挂载、重挂或 `pathSeq` 重新套用）时询问判定；判定为真就只写 `appliedPathRef.current = path`，不动 `revealRef`、选中、`pathNotice`，然后照常 `continueReveal()`。`appliedPathRef.current === undefined` 时一律按既有规则套用，并清空 `R`（宿主的主动下发优先于任何未见回声的上报）。
- **D3 不碰的东西**：宿主写回方式、`pathSeq` 语义、`useSelectionReport`、`onPathChange` 的调用时机与次数（记账不改变上报序列）。

## Change surface / 约束

- Change surface：`web/src/features/files/host-channel.ts`（新 hook 与说明）、`web/src/features/files/workspace-browser.tsx`（effect 一处判定、上报点改调 `report`、文件头注释补一句）、`web/src/features/files/follow-entry.ts`（只在它收到的回调换成 `report` 时可能不改；签名不变）、新测试文件 `web/test/workspace-browser-path-echo.test.tsx`。
- Must preserve：
  - 宿主主动下发的 `path`：地址深链、地址栏改写、会话卡片点击（`pathSeq`）照旧套用，含「下发的值恰好等于一条未见回声的旧上报」时经 `pathSeq` 的重新下发。
  - 点击已选中的文件照样重取预览（`chooseFile`）。`onPathChange` / `onSelectionChange` 在不触发本窗口的路径上的序列不变。
  - 既有 `workspace-browser*.test.tsx`、`files-deep-link*`、`chat-workspace-sidebar*`、`files-*` 用例不改即绿。
  - `workspace-browser.tsx` ≤800 行。
- Governing invariant：组件只执行宿主的新要求；自己上报过、又被自己更新的上报取代的值，回声晚到时不再改变选中、预览或定位。
- Sibling surfaces：五个上报点（`dropMissing`、`chooseFile`、`land`、`landFiltered`、`follow-entry`）；`usePathReapply` 与挂载 / 卸载对 `appliedPathRef` 的复位；`renderedSeq` effect（`:641-648`，比较 `selectedFileRef` 与 `path`，回声跳过后 `path` 仍是那一次的值，不影响它的判定次序）；两个宿主。
- Seams under test：直接渲染 `WorkspaceBrowser`，由测试宿主控制回声何时写回 `path`（`onPathChange` 只记账，测试显式 `setPath`）。观察 `fetch` 调用记录、`onPathChange` / `onSelectionChange` 的调用序列、选中行与预览区。
- Required evidence：
  - 用例 A（issue 验收，404 → 点击）：`onlyPaths={"deep/x.md","deep/y.md"}`，`deep/y.md` 答 404，`deep/x.md` 正常。点 y.md，写回 `deep/y.md`；404 后上报 `null`，先不写回；点 x.md；再写回 `null`（陈旧回声），然后写回 `deep/x.md`。断言：`file?path=deep/x.md` 恰一次；`onPathChange` 序列 `[["deep/y.md"],[null],["deep/x.md"]]`；`onSelectionChange` 序列 `[["deep/y.md"],[null],["deep/x.md"]]`（x.md 之后没有 `null`，即选中没被清过）；写回 `null` 之后 x.md 仍是选中行，最终显示 x.md 的正文。
  - 用例 B（`reveal` 落地 → 点击）：普通树（不给 `onlyPaths`）。`reveal("a.md")` 落地并上报 `a.md`，先不写回；点 `b.md`；再写回 `a.md`，然后写回 `b.md`。断言：选中始终是 b.md，`file?path=a.md` 与 `file?path=b.md` 各一次，`onSelectionChange` 在 b.md 之后没有变化。
  - 用例 C（宿主自己的值不被误判，两条）：
    - C1（`pathSeq`）：同 A 的 `onlyPaths` 与应答。点 y.md 并写回；404 上报 `null` 先不写回；点 x.md（`R=[null,"deep/x.md"]`）。宿主以 `pathSeq` 新值下发 `null`：选中被清除，`onSelectionChange` 末项为 `null`，x.md 不再是选中行。
    - C2（未上报过的值）：普通树（不给 `onlyPaths`），根列出 `a.md`、`b.md`、`c.md`。点 a.md、再点 b.md，两次都先不写回（`R=["a.md","b.md"]`）；宿主下发 `c.md`（不换 `pathSeq`）：c.md 被选中，`file?path=c.md` 恰一次，`onSelectionChange` 末项为 `c.md`。
  - 用例 D（同值重复，`R=[x,y,x]`）：普通树同 C2，初始 `path` 为 `null`。依次点 a.md、b.md、a.md，都先不写回（`R=["a.md","b.md","a.md"]`），然后依次写回 `a.md`、`b.md`、`a.md`，每次写回单独一个 `act`。断言：选中始终是最后点的 a.md；`file` 请求恰为三次点击各一次（a、b、a），回声没有带来多余请求；`onSelectionChange` 在第三次点击之后不再变化。改前红：写回 `b.md` 时选中是 a.md，按既有规则定位到 b.md 并多发一次 `file`。
  - 改前：A、B、D 在未改动代码上红（多出 `file` 请求，`onSelectionChange` 多出 `null`）；改后绿。C 改前改后都绿（守卫）。
  - 既有：上列 must-preserve 用例不改即绿；`make check` 0。有些既有测试的宿主不写回 `path`（`files-deep-link-component.test.tsx:36-55` 的 `onPathChange` 是 `vi.fn`、`files-ops-*` 的 `() => {}`），`R` 在其中只增不减；若有用例因此变红（上报两次后又以 props 下发更早上报过的值），停下报告，不改既有断言。
- Non-goals：宿主不原样写回上报值的情形（两个宿主都是原样写回）；宿主刻意下发一个等于「已被取代、未见回声」旧上报的值、又不换 `pathSeq`（与陈旧回声无法区分，按回声处理；两个宿主都没有这条路径：文件页地址栏改写是新值或经路由重挂，侧边栏的主动定位都经 `pathSeq`）；测试工具链的 Scheduler 排空（#1541）。
- Review focus：判定在回声被宿主合并跳过时、以及 `R` 里有同值重复时是否仍正确（D1 取首个匹配的理由）；`undefined` 分支是否覆盖 `pathSeq`、挂载与 StrictMode 重挂；`R` 在宿主不写回时（同值写回不触发 effect）的残留是否会把之后的宿主值误判成回声；800 行上限。
