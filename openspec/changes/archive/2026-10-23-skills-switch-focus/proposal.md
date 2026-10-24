# Proposal: skills-switch-focus

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: compact (agree)
Blast radius: 中心「技能」tab 的开关；做错时在途期间重复切换会多发 PUT 或开关状态错乱，或者焦点仍然丢失
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: web/test/center-skills.test.tsx 在途 + 失败回滚用例（焦点、aria-disabled）、chat-capability-popover.test.tsx 应答后焦点断言、npm test --workspace web、make check
```

design.md omitted (compact)：hook 不改，只去掉 DOM 层的 `disabled` 拦截；暴露出来的在途重入由已测过的 `state.pending || inFlight` 守卫拦下，所以 concurrency 不构成 expanded 触发。

## Why

Epic #1654 收尾时报给 owner 一条规格层面的问题：skill-switches「中心「技能」tab」要求「在途禁用全部开关」，实现照此给开关加了 `disabled`（`web/src/features/center/skills/list.tsx:96`）。用户按下开关时，这个开关立刻进入在途。`disabled` 让浏览器把焦点从它身上移走，焦点落到 `body`，键盘用户只能从页首重新 Tab 过来。输入框「能力」弹层（#1664）已经改用 `aria-disabled`，焦点不丢（`web/src/features/chat/capability-popover.tsx:31,169`），两处行为因此不一致。owner 2026-10-23 决定改规格解决。

## What Changes

- skill-switches「中心「技能」tab」：「在途禁用全部开关」改为「在途期间全部开关不可切换」。新增「不可切换的开关」一句：不可切换时带 `aria-disabled="true"`，不带 `disabled`，点击与键盘操作不发请求、不改状态，焦点留在原开关上。新增场景「在途期间焦点留在开关上」。
- skill-switches「输入框「能力」弹层」：场景里的「禁用」改写为「不可切换（`aria-disabled`）」，引用同一条规则。这是把已实现的行为写进规格。挂起期间的焦点已有测试（`web/test/chat-capability-popover.test.tsx:212-235`），应答后焦点仍在原开关这一句由本 change 补断言。
- 「技能」tab 实现：`Switch` 的 `disabled={pending}` 改为 `aria-disabled`，样式与弹层一致。在途拦截沿用 `useSkills.toggle` 已有的 `state.pending || inFlight` 守卫。
- 验收清单 CS-02 增加一步键盘操作，人工确认焦点不丢。

## Impact

- 规格：skill-switches 两条 requirement 修改，不增删 requirement。
- 代码：`web/src/features/center/skills/list.tsx`；`web/src/features/center/skills/use-skills.ts`（只改注释）；`web/test/center-skills.test.tsx`；`web/test/chat-capability-popover.test.tsx`（补应答后焦点断言）；`docs/acceptance/functional-checklist.md`（CS-02）。
- 不动：服务端、`use-skills.ts` 的状态机与守卫、弹层实现、API 客户端。
- 同类入口（不在本 change）：进行中的 `openspec/changes/s1d-connectors/specs/connectors/spec.md:87` 与 `tasks.md` 6.2 对「连接器」tab 的 `默认启用` 开关仍写「在途禁用」（#1675 未实现）。照写会再次丢焦点，那边实现前应改为沿用本条「不可切换的开关」规则。已报给 owner，不在此改。
