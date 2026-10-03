## MODIFIED Requirements

### Requirement: 状态与时间筛选
`筛选任务` 按钮（demo:1787，`Icon filter`）SHALL 打开 `Popover`，内含两个单选组：`状态`（`全部` / `进行中` / `已完成`）与 `时间`（`全部时间` / `今天` / `更早`）（demo:1828-1851；呈现为两个 `SegmentedControl` 分段控件而非 demo 的竖排菜单项，为有意偏差），每组为 accessible name 同组名的 `role="radiogroup"`，选项为 `role="radio"` 并以 `aria-checked` 表示选中，默认 `全部` 与 `全部时间`。选择立即作用于列表且弹层保持打开；Escape 关闭弹层并把焦点还给 `筛选任务`；点击弹层外部同样关闭弹层，但不把焦点归还 `筛选任务`（`Popover` 基元的非模态行为）。`筛选任务` 按钮与单选项 SHALL NOT 触发 `≤760px` 导航覆盖层的关闭。筛选 SHALL 纯前端计算，不发请求：`进行中` 为 `status="running"`；`已完成` 为 `status ∈ {done, failed, stopped}`（`idle` 只在 `全部` 下出现——与 demo「非 running 即已完成」（demo:1844）的有意偏差）；`今天` 为 `updatedAt` 的本地日历日等于当前本地日历日（当前时间取列表渲染时刻，不设定时器），`更早` 为其余。两组取交集。筛选状态为会话页内存状态：切换会话、折叠再展开侧栏、关闭再打开导航覆盖层均保留，刷新或离开会话页复位，不写 storage。筛选只影响侧栏条目，不改变当前选中会话及其主区内容。

#### Scenario: 状态与时间交集
- **WHEN** 列表含今天更新的 `running`、`done`、`idle` 会话各一个与昨天更新的 `failed`、`stopped` 会话各一个，依次选择 `进行中`、`已完成`、`已完成`+`今天`、`全部`+`更早`
- **THEN** 依次只显示 running 那个；done、failed、stopped 三个；done 一个；failed 与 stopped 两个；`idle` 只在 `全部` 且 `全部时间`/`今天` 下出现；全程无网络请求

#### Scenario: 无匹配与键盘关闭
- **WHEN** 选择 `进行中` 而无 running 会话，然后按 Escape
- **THEN** 列表区只显示 `没有匹配的任务`；弹层关闭且焦点在 `筛选任务`；当前选中会话的主区内容不变

#### Scenario: 筛选跨覆盖层保留
- **WHEN** 在 `≤760px` 打开 `导航` 覆盖层，打开 `筛选任务` 选择 `已完成`，按 Escape，再选择列表中的一个会话（覆盖层关闭），随后重新打开覆盖层
- **THEN** 选择单选项与按 Escape 都不关闭覆盖层（Escape 只关闭弹层）；重新打开后列表仍只含 `done`/`failed`/`stopped` 会话，再次打开 `筛选任务` 时 `已完成` 为选中

#### Scenario: 覆盖层内的筛选弹层在覆盖层之上
- **WHEN** 在真实浏览器 390×844 打开 `导航` 覆盖层，再打开 `筛选任务`
- **THEN** 弹层画在覆盖层的遮罩与面板之上：两个单选组可见，单选项能被真实指针点中（命中测试不被遮罩或面板拦截），选择后 `aria-checked` 随之变化且覆盖层仍打开（取证：chat-harness「UI 走查会话元数据」第 6 步的 `mobile-dark`）
