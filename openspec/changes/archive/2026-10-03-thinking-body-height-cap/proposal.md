# Proposal: thinking-body-height-cap（#725，owner 决议 (a)）

## Why
转录贴底时展开一条长 `深度思考过程`，贴底重算把视口拽到底部，刚点的 summary 滚出视口（#725 表：120 行时位移 2406px）。贴底重算符合 chat-web 现行规格；缺口在 `.thinking-body` 没有高度上限，而同一路径上的步骤卡 `原始输出` 有 12rem。

## What Changes
- `web/src/features/chat/messages.css`：终态消息的 `.thinking-body` 加 `max-height: 12rem; overflow: auto`。
- `web/src/features/chat/thinking-block.tsx`：`<details>` 在 `running` 时带 `data-running` 属性，供样式区分。
- 规格：thinking-fold MODIFIED「深度思考折叠块呈现」一句 + 一个 Scenario。
- 测试：`web/test/chat-thinking.test.tsx`（属性随状态出现/消失）；`web/e2e/ui-walk-sessions.spec.ts` `step4ThinkingFold`（真实浏览器里的计算样式）。

## 对 owner 决议的细化（偏离说明）
决议是「`.thinking-body` 限高 + 内部滚动，不改贴底逻辑」。issue 已指出直接全量限高的代价：流式期间折叠块是展开的，盒内最新文本不会被跟随。本 change 把限高只作用于终态消息：running 期间保持现状（不限高、转录贴底跟随），终态消息的手动展开受限高约束；running 期间用户收起后再展开仍不限高、由贴底跟随（与现状相同，issue 已划为范围外）。不新增任何滚动逻辑，chat-web 规格不动。

## 界限（如实）
限高把位移上界从「thinking 全长」降到 12rem + 6px。summary 距滚动容器顶不足该值且转录贴底时，展开后 summary 仍会移出可视区——与步骤卡 `原始输出` 的既有行为同级，不在本 change 处理。

## Non-goals
- `scroll-follow.tsx`、chat-web「转录区尺寸变化触发贴底重算」不动。
- 折叠态规则（running 展开、终态收起、手动切换保留）不动。
