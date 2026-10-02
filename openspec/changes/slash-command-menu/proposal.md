# Proposal: slash-command-menu（#556，父 change `s1c-session-metadata-presentation` tasks 10.5）

## Why
服务端已有 slash 白名单与命令目录（`GET /api/commands`，#551；prompt 路由的白名单与转义，#555），但会话页输入 `/` 没有任何提示：用户不知道有哪些命令可用，也不知道 skill 的名字。

## What Changes
- `web/src/lib/api-commands.ts`（新）：`listCommands()`，GET `/api/commands`，严格解析；`api.ts` 接线。
- `web/src/features/chat/slash-menu-state.ts`（新，纯函数）：打开条件、前缀过滤、选中文本、高亮/关闭的归约。
- `web/src/features/chat/slash-menu.tsx`（新）：`useSlashMenu` hook（目录的惰性拉取与缓存、按键拦截、选中）与模块私有的 `SlashMenu` 面板（`role="listbox"`）。
- `web/src/features/chat/composer.tsx`：两个可选 prop——`slashMenu` 插槽与 `interceptKeyDown`；都不传时渲染与行为逐字同现状。
- `web/src/features/chat/conversation-view.tsx` 与 `page.tsx`：接线。
- `web/src/features/chat/chat.css`：面板样式。
- 规格：chat-web MODIFIED「API 客户端扩展」「会话页」。

## Non-goals
- 服务端白名单、转义与命令目录（#551/#555 已合入）；ui-walk 与真实浏览器走查（#557，父 tasks 10.6）；skill 中文化；欢迎态与会话态 composer 之外的输入框。
- 把输入框做成完整的 ARIA combobox（`role="combobox"`、`aria-controls`、`aria-expanded`、输入框上的 `aria-activedescendant`）：父规格只给 `Composer` 加两个 prop，见「偏差」5 与 design「已知残留」。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **`conversation-view.tsx` 在改动路径上**（issue 的 PR 边界没有列）：`Composer` 挂在 `conversation-view.tsx:288`，不在 `page.tsx`。新增一个 `slash` prop 透传给 `Composer`，做法同 #538 的 `search` prop。
2. **`api.ts` 不是「只加一行」**：需要 `ApiClient` 类型成员、`createCommandMethods(...)` 的展开与 import，共 3 处。issue 写的基线「749 → ≤750」已过时，现为 722 行。子 delta 把父文的「`api.ts` 只加一行接线」写成「由 `api.ts` 接线」。
3. **响应体形状写明**：父文只写「200 返回按五键严格解析的数组」。服务端实际返回 `{commands:[…]}`（`server/src/sessions/rest-commands.ts:47`）；子 delta 写明响应体恰为 `{commands}`，`listCommands()` 的返回值是其中的数组。
4. **三个测试文件**（issue 写两个）：`listCommands()` 的严格解析放独立的 `web/test/api-commands.test.ts`（同 `api-sessions-metadata.test.ts` 的先例）；页面用例过长时可再拆一个 `chat-page-slash-support.tsx`。
5. **`aria-activedescendant` 放在 listbox 上**：按父规格字面。焦点始终在输入框，而 `Composer` 只增两个 prop，输入框拿不到高亮项的 id。高亮项另带 `aria-selected="true"`。读屏器因此不会随 `↑/↓` 播报高亮项——记为已知残留，不在本刀扩 `Composer` 的 prop 面。
6. **子 delta 另加父文未写的可观察行为**：拉取是边沿触发（条件「变为成立」时才调用；失败后在条件保持成立期间的继续输入不重试；在途期间不重复调用；返回前面板隐藏、成功后若条件仍成立则出现）；目录随页面挂载保留；draft 任何变化都把高亮重置到首项；`Esc` 之后回到同一文本会重新出现；`Tab` 选中而 `Shift+Tab`、`Shift+Enter` 与带 `Ctrl/Alt/Meta` 的按键不拦截；点击选中后焦点留在输入框；面板有高度上限、高亮项滚入可视范围；候选按目录次序。新增 Scenario「候选目录的拉取时机」「点击与 Tab 选中」。
7. **面板是卡片内的静态元素，不用 Popover**：issue 的必读表提到 `web/src/ui/popover.tsx`。Radix Popover 会把焦点移出输入框，且其层级问题已有 #715；规格写的是「在卡片内、输入框上方」。
8. **`page.tsx` 的「纯页面状态」**：父文写「The panel is pure page state」。状态放在 `slash-menu.tsx` 的 hook 里（`page.tsx` 只有 +10 行预算，放不下拉取与归约的胶水），子 delta 写成「page state outside `page.tsx`」。

## Impact
- 新文件 3 个产品文件、3 个测试文件（必要时另加一个测试 support 文件）；`composer.tsx`、`conversation-view.tsx`、`page.tsx`、`api.ts`、`chat.css` 各有小改动。
- 既有测试零 diff（含 `chat-composer.test.tsx` 与全部 `chat-page*.test.tsx`）。
- 主规格：chat-web 两条 Requirement。
