# markdown-literal-dedupe — 白名单外格式元素被 parse5 克隆时起始标签原文只显示一次（#1535）

## Why

`web/src/features/chat/markdown-literal.ts:46-67` `literal()` 对每个白名单外元素按自己的 `position.start.offset` 从 raw 段取起始标签原文，再返回 `[起始标签文字, ...children, 结束标签文字]`——假设一个元素对应一个源起始标签。parse5 对 HTML 格式元素（`font`/`small`/`big`/`strike`/`tt`/`nobr`，都不在 `SANITIZE_SCHEMA` 白名单里）在跨段落 / 列表项或被块元素截断（adoption agency）时会克隆，克隆体沿用原起始标签的 token 与位置（`parser/index.js:475-482` `_reconstructActiveFormattingElements` → `:302-304` `_insertElement`），于是同一源起始标签被显示两次或更多：`<font color="red">彩\n\n下一段` → textContent `<font color="red">彩<font color="red">\n下一段`。spec 要求「起始标签按原文（含其属性字节）显示」，源文本里只有一个。白名单内的格式元素（`b`/`i`/`a`）克隆成真实元素、不经 literal，是浏览器标准行为，不在此列；`<task>`/`<file>` 占位符不是格式元素、不会被重建。只影响显示正确性，输出仍是文本节点并经 sanitize。

## What

- `markdown-literal.ts`：`literalUnknownTags()` 一次运行内维护 `Set<number>`（已输出起始标签的 `start.offset`）；`literal()` 遇到已记录的偏移只省掉起始标签文字，返回 `[...children, ...(owned ? text(close) : [])]`——结束标签的 `owned` 判定仍按元素各自处理（adoption agency 里 `</font>` 由 `div` 内的克隆体持有，不能丢）。约 3 行，文件仍 ≤ 80 行（design 预算）。
- 测试（`web/test/chat-markdown.test.tsx` 或同目录新文件，`mountReply`，精确比较 `body.textContent`）：四个输入（`<font color="red">彩\n\n下一段`、`<small>a\n\nb`、`- <small>a\n- b`、`<font>a<div>b</font>c`）各一条，`body.querySelector("font, small")` 为 null。
- 顺带（同一批文件的小修）：`markdown-html.ts:2-3` 头注释补 `recordRawSegments`；`chat-markdown-html.test.tsx:20` 的 `SANITIZE` 注释改为说明与 spec 场景的差异（或补全常量）；`chat-markdown.test.tsx:144` 的 `toContain` 改精确比较。
- 不做：parse5 名单耦合的去重、自写分词、白名单取舍。

`design.md` 省略：compact 级，一个纯函数插件的去重 + 测试。

## Triage

```text
Issue type: bug
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; S)
Blast radius: one rehype plugin in the chat body pipeline; a wrong dedupe either still duplicates (new tests red) or drops a legitimately distinct start tag with the same offset (impossible: offsets are unique per source tag) or drops a close tag (adoption-agency test red); existing markdown tests guard the rest
Selected risk packs: XSS face of Auth / secrets (the literalised start tag must stay a text node through sanitize: asserted by querySelector("font, small") === null and exact textContent); not selected — Error handling (no new failure path), Public API / CLI, Config, File IO, Schema, Resource limits, Release / packaging. Must preserve: existing chat-markdown*.test.tsx unchanged and green; <task>/<file> placeholder handling unaffected
Evidence floor: npm test --workspace web (full web suite green incl. the new cases); the four new cases red before the dedupe; markdown-literal.ts ≤ 80 lines; typecheck; make check; no server/ change
```
