# Tasks — markdown-literal-adoption-known-form (#1604)

Fixture level: compact. Risk packs: none selected (see proposal Triage).

Must preserve: `web/src/features/chat/markdown-literal.ts` 不改；`chat-markdown.test.tsx` 现有用例不改。

- [ ] 1.1 开工核对：`web/test/chat-markdown.test.tsx:149-168`（#1535 那组用例与 `mountReply`）；`markdown-literal.ts:46-70`。
- [ ] 1.2 在 #1535 那组 describe 之后新增 describe「被块元素截断的白名单外格式元素按解析器重排显示（已知形态，issue 1604）」，用 `it.each` 写 spec Scenario 的四个输入和一个对照输入，断言 `textContent` 精确相等，并断言正文段内没有 `font, small`。用一句注释说明这是登记的已知形态，不是期望的源顺序。
- [ ] 1.3 变异（只在本地跑，不提交）：把 `literal()` 返回值里的 `...(owned ? text(close) : [])` 临时改成 `[]`，确认四个已知形态用例都变红，然后撤销；输出存到 `.workplans/1604/evidence/`。
- [ ] 1.4 验证：`npx vitest run --root web test/chat-markdown` ×3；`npm test --workspace web`；`make check`；`git diff --stat` 只包含 change 目录和 `web/test/chat-markdown.test.tsx`。
