# Proposal: artifacts-panel（#537，父 tasks 7.6）

## Why
7.5a/7.5b 只在单条助手消息里汇总文件变更、派生产物卡。长会话里要找「这个任务到底产出了哪些文件」得翻整段转录。父 change 的 turn-artifacts「产物面板」规定顶栏给一个入口，把当前会话全部已结束步骤的变更按路径聚合进一个右侧抽屉。

## What Changes
- 新建 `web/src/features/chat/artifacts-panel.tsx`：`useArtifactsPanel(...)`（面板的全部状态与分支）与抽屉内容。
- `web/src/features/chat/topbar-actions.ts`：`chatTopbar()` 多收一个 `openArtifacts(trigger)`，填入 `CHAT_TOPBAR_ACTIONS` 的 `产物面板` 槽。
- `web/src/features/chat/page.tsx`：接线（把 `workspace` 提成常量、调 hook、把 `open` 交给 `chatTopbar`、渲染 `panel`）。
- `web/src/features/chat/file-changes-card.tsx`：把「一行」与「空间前缀推导」抽成可复用导出，卡片自己改用它们；DOM 与行为不变。
- `web/src/features/chat/artifact-card.tsx`：把操作逻辑（拉取纪律、预览 Dialog、下载、复制）抽成可复用导出，卡片自己改用它；DOM 与行为不变。
- `web/src/features/chat/messages.css`：抽屉内列表的样式。
- 新建 `web/test/chat-page-artifacts-panel.test.tsx`（P1–P12）、`web/test/chat-page-artifacts-panel-focus.test.tsx`（P13 与评审后追加的 Q1、Q3、Q5；Q2、Q4 在前一个文件里）与共用的 `chat-page-artifacts-panel-support.tsx`。
- ADDED `turn-artifacts`「产物面板」；MODIFIED `turn-artifacts`「产物卡」（拉取结束后的焦点归还）；MODIFIED `chat-web`「会话页」（顶栏 actions 句与新增 Scenario「顶栏入口」）；MODIFIED `session-sidebar`「会话条目菜单与重命名」与 `spa-shell`「路由 IA 与侧栏」（槽位现状句）。

## Non-goals
- `对话内搜索` 槽与三按钮全序（7.7）；ui-walk 的产物面板步骤（8.2a）。
- `web/src/ui/**`（`Drawer`、`Dialog` 只消费）、shell、`stream.ts`、`stream-artifacts.ts`、`stream-steps.ts`、server 不动。
- 产物卡与文件变更卡的其余可观察行为（7.5a/7.5b 的两套测试是回归网，零 diff）；唯一的行为变化是偏差 11 的焦点归还。
- #731（代码卡的剪贴板写入在网络往返之后，Safari 预期失败）：面板的 `复制代码` 复用同一实现，原样继承，不在本刀处理。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **一个既有测试文件有改动**：issue 写「既有测试零 diff」。`web/test/chat-page-session-rename-pin.test.tsx` 有四处对 banner 按钮的整表断言：`:470,487,527` 的 `["重命名"]` → `["重命名", "产物面板"]`，`:539`（≤760px）的 `["打开导航", "重命名"]` → `["打开导航", "重命名", "产物面板"]`。只改这四处期望。
2. **`file-changes-card.tsx` 与 `artifact-card.tsx` 有改动**：issue 的 PR Boundary 只列了 `artifacts-panel.tsx`、`topbar-actions.ts`、`page.tsx`。规格要求「行内容同文件变更卡行」「行为同产物卡」，issue 的 Review priority 要求「不复制第二份拉取逻辑」；行与操作在 7.5a/7.5b 里是组件内联的私有实现，只能先抽出来再复用（7.5a、7.5b 的归档 PR 都预告过）。
3. **聚合包含所有消息的步骤**（规格「全部已结束步骤」的字面读法）：`summarizeChanges(view.messages.flatMap((m) => m.steps))`，不按角色过滤。服务端只给助手消息记步骤，user 消息的 `steps` 恒为空；与「user 消息不渲染文件变更卡」不冲突。
4. **空间不可解析但有变更时照常开抽屉**：父文只写了「结果为空（含未绑定空间的会话）→ Toast」。未绑定空间的会话不会有 `changes`（服务端只在绑定空间内判定归属），所以括号里的情况自然落在「结果为空」。会话空间不在列表里、列表读取中或失败而视图里有变更时，转录里的文件变更卡照常显示这些行；面板若弹「暂无产物」与之矛盾，所以同文件变更卡的降级：只显示相对路径、无 `查看详情`、无操作按钮。
5. **抽屉有两个 `关闭`**：`Drawer` 基元头部自带 `关闭` 图标按钮（不改基元），父文另述脚部 `关闭` 按钮；两者都渲染。
6. **不带 `aria-expanded`**：父 design D8 只让 `对话内搜索` 用 `aria-expanded` 反映搜索框；`产物面板` 打开的是模态抽屉，同 `重命名`。
7. 子 delta 另加父文未写的可观察行为：抽屉宽 420（父 design D10 的值写进规格）；操作按钮的名字带文件名（`打开网页预览 index.html`，同产物卡）、在 `查看详情` 之后且仅在空间可解析时出现；html 预览叠在抽屉之上、关闭后焦点回到该行按钮、预览打开时 Escape 只关预览；抽屉关闭时在途拉取被 abort；当前视图不可用时（切换会话、换账号、历史重新读取）抽屉关闭且不自动重开；不出现空间绝对根；历史还在读取或读取失败时点击同样弹「当前任务暂无产物」；新增 Scenario「打开期间更新与行操作」。
8. **chat-web「顶栏入口」Scenario 是两按钮版**（`重命名`、`产物面板`）；父文是三按钮，`对话内搜索` 归 7.7。
9. **多两个现状句 delta（`session-sidebar`、`spa-shell`）**：主规格 `spa-shell`「路由 IA 与侧栏」里「`对话内搜索`、`产物面板` 两个槽位……当前不产出按钮」同样不再成立，MODIFIED 只改这个括号。`session-sidebar`「会话条目菜单与重命名」里有一句「当前只有 `重命名` 槽位产出按钮」，本刀合入后不再成立，MODIFIED 改这一句（7.2a 归档时写下的现状句；父 delta 里没有对应文字）。
10. **chat-web「顶栏入口」的措辞**：父文「banner 内在面包屑之外恰有…按钮」在 ≤760px 不成立（banner 里还有 `打开导航`），子 delta 改成「顶栏的 actions 区恰有…」。
11. **改了产物卡（7.5b）的一条行为：拉取结束时焦点回到操作按钮**。实现后在 Chromium 里观察到：行内 `复制代码` 完成后焦点落在 `body`（按钮在拉取中被禁用，浏览器把焦点移走——7.5b 残留 8），成功 Toast 在屏的 2.4 秒内按 Escape 关不掉抽屉（Toast 是 Radix 的最高层，抽屉的 Escape 兜底只认目标在抽屉内的按键），违反本 issue 的验收点「Escape 关闭抽屉」。修在共用的操作 hook 里：拉取结束时若焦点在 `body`，把焦点还给被点的按钮（`focus({ preventScroll: true })`：不带它的话，转录里的卡片在慢拉取结束时会把滚动位置拽回卡片并解除贴底跟随——评审第 1 轮指出）。产物卡因此同样受益（7.5b 残留 8 消失），所以 MODIFIED `turn-artifacts`「产物卡」补一句。
12. 只并入父 delta 的产物面板部分。

## Impact
- web：一个新产品文件、五个既有产品文件改动（其中两个是不改行为的抽取）、两个新测试文件加一个 support、一个既有测试文件的四处期望。server 无改动。
- 运行时：选中会话时顶栏多一个按钮；面板不发任何新请求，行操作与产物卡一样只在点击时请求预览 API。#522 合入前服务端不产生 `changes`，面板在真实链路上只会弹「暂无产物」。
- 依赖：#536、#531、#529 已合并。
