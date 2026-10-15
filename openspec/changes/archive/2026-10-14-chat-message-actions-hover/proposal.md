# Proposal: chat-message-actions-hover

## Why

#908：owner 在 2026-10-06 验收会话页时提出用户消息的气泡不好看——操作行（今天是 `撤回`、`从此处分叉`）渲染在气泡的 `article` 里并且常驻，一句「hello」的气泡被撑成两行高、底下挂着图标。参照是「操作图标在气泡外、鼠标移上去才显示」。现状是按规格实现的（chat-web「消息线程」只规定了按钮与次序，没有规定位置与显隐），所以要改的是规格本身。

## What Changes

- **用户消息的操作行移到气泡外**：消息的 `article` 仍是整条消息（可访问名、`data-message-id`、`aria-current` 与当前匹配高亮留在它上面）；气泡的底色、圆角与内边距移到内层容器，气泡只包消息内容；操作行在气泡下方、靠右。
- **用户消息加 `复制`**：复制该消息的原文，反馈规则与助手消息的 `复制` 相同（成功只换图标，失败就地显示 `复制失败`，不弹提示）。次序 `复制`、`撤回`、`从此处分叉`（design D1：#908 正文写于 `撤回` 上线之前，次序以 #907 的 owner 裁定为准）。文本为空的用户消息（只发附件）没有 `复制`；已归档会话里用户消息只剩 `复制`；输入框锁定不禁用 `复制`（与助手消息一致）。
- **悬停才显示**：用户消息与**全部**助手消息的操作行默认不可见（不透明度 0），鼠标悬停该消息、行内按钮获得焦点、或行内有 `复制失败` 时显示；按钮始终留在 Tab 顺序与无障碍树里，隐藏时仍占位、显隐不改变布局。主指针不能悬停（`(hover: none)`）的设备上常显（owner 2026-10-13）。末条助手消息不做特殊处理（owner 2026-10-06）。不透明度过渡遵守 `prefers-reduced-motion`。
- **证据**：jsdom 断言结构、类名、次序与复制行为；真实显隐在 `make ui-walk` 里量计算样式（悬停前后、键盘聚焦、`复制失败`、触屏上下文）。既有走查里点 `重新生成` 与 `从此处分叉` 的步骤先悬停并断言该行显现。
- **验收清单**：改写期望已不成立的行，在涉及点消息按钮的行里补「鼠标移到该消息上」，新增悬停显示、键盘显示、触屏常显与用户消息复制的行，一律 `待签`。
- **不做**：消息编辑、点赞 / 点踩、分支切换（规格明文不提供）；`撤回` 的行为不变（message-undo）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `chat-web`：「消息线程」（用户消息的结构、`复制` 与按钮次序；操作行的显隐；「复制助手原文」「用户消息操作行的按钮与次序」「只有附件的用户消息」三个场景改写，新增五个场景）。
- `chat-harness`：新增「UI 走查消息操作行显隐」一条要求（既有对话步骤的悬停前置、计算不透明度的测量、键盘与触屏上下文）。

message-undo「web 撤回」（`撤回` 在 `从此处分叉` 之前）、message-attachments「用户气泡中的附件」（只发附件的消息操作行为 `撤回`、`从此处分叉`）与 conversation-search「跳转与消息级高亮」（高亮在根元素上）的条文在本 change 之后仍成立，不改（design「规格影响」）。

## Impact

- **web 代码**：`web/src/features/chat/message-thread.tsx`（`UserMessage` 的结构与 `UserActions` 的调用）、`web/src/features/chat/message-action-row.tsx`（`Row` 的显隐类名、`UserActions` 加 `复制`）。不改 `web/src/styles/theme.css`，不新增全局规则（design D3）。
- **测试**：`web/test/chat-copy.test.tsx`、`chat-thread-attachments.test.tsx`、`chat-archive.test.tsx`、`chat-fork-button.test.tsx`、`chat-undo.test.tsx` 等以操作行为范围的 jsdom 用例；`web/e2e/` 新增一步并改 `ui-walk-stop.ts` 的两处点击。
- **文档**：`docs/acceptance/functional-checklist.md`。
- **线协议、服务端、数据**：无。
- **依赖**：无新增。

## 流程记录

```text
Issue type: feature
Fixture level: compact
Upstream suggested level: absent
Blast radius: 会话页每条消息的操作行——按钮被藏到点不到或读屏 / 键盘够不着、触屏上永远看不见、`复制失败` 一闪即逝；既有以 article 为范围找按钮的测试与走查
Selected risk packs: 见 tasks.md「风险包」
Evidence floor: make check、make test-guardrails、make ui-walk（两个 project）；ui-walk 量计算不透明度
```

- **fixture 级别**：逐条对照 issue-risk-contract 的 `expanded` 触发项——不改共享入口、公开 API、格式、持久化、鉴权、并发，范围由 owner 定死——取 `compact`。**偏离 contract 的产物集**：`compact` 本应省略 `design.md`，这里仍附一份短 design，因为显隐的测量方法不显然（Playwright 把不透明度 0 的元素当作可见、`emulateMedia` 模拟不了 `hover`，见 design D5），不写下来实现者会写出量不到东西的测试。
- **跟踪**：直接在 #908 上实现，不拆子 issue；tasks 只有一个组，一个 PR。
- **owner 裁定**：2026-10-06（issue 需求 1–3、末条助手消息不做特殊处理）、2026-10-13（触屏以 `(hover: none)` 判定，带鼠标的触屏笔记本按悬停处理）。起草者自定的事项见 design D1–D8，其中 D1（次序含 `撤回`）、D2（空文本与归档下的 `复制`）、D4（焦点显示用 `focus-within`）、短渐变与当前匹配高亮包住整条消息已由 owner 于 2026-10-14 裁决，见 design「Owner 裁决（2026-10-14，起草后）」。
