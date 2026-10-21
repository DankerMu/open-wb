# markdown-literal-adoption-known-form — 被块元素截断的白名单外格式元素：结束标签显示位置登记为已知形态（#1604）

## Why

#1604 报告：助手正文里写在源 HTML 块中的白名单外格式元素（`font`、`small` 等）被另一个块元素截断时，`literalUnknownTags`（`web/src/features/chat/markdown-literal.ts:46-70`）显示的结束标签不在源中的位置。原因是 parse5 的 adoption agency 把截断处之后的内容移进新建的同名元素，新元素没有源位置；源中的结束标签记在原元素上，所以跟着原元素的内容显示。

2026-10-21 编排方用 `mountAssistantReply` 在本地实测，issue 的推演成立：

- `<div><font>a<div>b</font>c</div></div>` → `<font>a</font>bc`
- `<div><small>a<div>b</small>c</div></div>` → `<small>a</small>bc`
- `<div><font>a<small>x<div>b</font>c</div></div>` → `<font>a<small>x</font>bc`
- 紧凑列表项 `- <font>a<div>b</font>c` → `\n<font>a</font>bc\n`（标题 `# …` 同样如此）
- 对照：`<div><p><font>a<div>b</font>c</p></div>`、`<p><font>a<div>b</font>c</p>` → `<font>ab</font>c`（内层块元素先关闭 `p`，走 #1535 的克隆形态）

分界不在于是否处在源 HTML 块里，而在于截断用的块元素有没有先关闭外层段落。fixture 审查 r1 指出了这一点，随后编排方实测确认。

owner 2026-10-21 裁定**不修**，把这种情况登记为已知形态。理由有三：输入本身是非法嵌套；按解析器的重排来显示说得过去；只影响显示，而且很少见。要修，就得在 `literal()` 里跨节点延后结束标签，还要先定下多层嵌套的规则，不划算。

## What

- 在 chat-web「消息线程」源 HTML 那一段的结束标签条文之后，补一句已知形态的说明（附 owner 裁定和 #1604），并加一个 Scenario，钉住上面四个实测输出和一个对照。
- 在 `web/test/chat-markdown.test.tsx` 新增一组用例，断言这四个输入和对照的 `textContent` 与上面完全一致，且正文段里没有 `font`、`small` 元素。这组用例把现状钉住：以后改 `literal()` 时，这个形态如果变了，测试会变红，逼着同步更新 spec。
- 不做：改 `markdown-literal.ts`；改 #1535 那组用例；改白名单。

issue 原来的验收标准是按修复写的。owner 改为登记之后，以本 change 为准：精确的 `textContent` 断言和多层嵌套用例都保留下来，期望值从「源顺序」改为「解析器重排后的现状」。

## Triage

```text
Issue type: spec (known-form registration) + characterization test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; S, p3, needs-triage → owner 2026-10-21: register, don't fix)
Level rationale: compact — no product code; one test file gains one describe; the spec gains one clause and one Scenario.
Blast radius: none at runtime; a wrong expected string either fails CI on master or documents a form that is not what users see
Selected risk packs: none — rendering code untouched; output stays text nodes before sanitize (unchanged)
Evidence floor: the new cases pass on unchanged `markdown-literal.ts`; a mutation in `literal()` that drops `owned` close tags turns at least the first case red (local, not committed); `npx vitest run --root web test/chat-markdown` ×3; `npm test --workspace web`; `make check`; diff only the change dir and `web/test/chat-markdown.test.tsx`
```
