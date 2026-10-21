# Tasks — markdown-literal-dedupe (#1535)

Fixture level: compact. Risk packs: selected — Auth / secrets 的 XSS 面（输出仍是文本节点、经 sanitize）；not selected — Error handling、Public API / CLI、Config、File IO、Schema、Resource limits、Release / packaging（无运行时面变化）。

Must preserve: `markdown-literal.ts` ≤ 80 行；`REHYPE_PLUGINS` 顺序不变；白名单内格式元素（`b`/`i`/`a`）的克隆行为不变（对照用例 `<b>a\n\nb`）；`<task>x</task>\n\ny` 对照不变；`server/` 零改动。

- [ ] 1.1 开工核对：`markdown-literal.ts:46-67`（`literal()` 的起始 / 结束标签取法、`owned` 判定）、`markdown-html.ts:67-71`（白名单）、`markdown-body.tsx` 的 `REHYPE_PLUGINS` 顺序；`web/test/chat-markdown.test.tsx` 的 `mountReply` 与 `:128-147`（P1-A 用例）；`chat-markdown-html.test.tsx:20` 的 `SANITIZE` 注释与 spec 场景「链接、图片与源 HTML 的渲染与消毒」的实际差异（`注`/`配` 两个 span、三个不带 `//` 的目标）；hast-util-raw 自带的 parse5 版本（`node_modules/hast-util-raw/node_modules/parse5/`）。出入先改本 fixture 再继续。
- [ ] 1.2 测试先行：按 chat-web delta「消息线程」新增 Scenario「白名单外格式元素被克隆时起始标签只显示一次」逐字——四个输入的精确 `textContent`（`<font color="red">彩\n\n下一段` → `<font color="red">` 恰一次且含 `彩`、`下一段`；`<small>a\n\nb`、`- <small>a\n- b` 同理 `<small>` 恰一次；`<font>a<div>b</font>c` → `<font>`、`</font>` 各一次，去空白后 `<font>ab</font>c`）；`body.querySelector("font, small")` 为 null；对照 `<b>a\n\nb` 渲染两个 `b` 元素（不经 literal）。先红再绿。
- [ ] 1.3 实现：`literalUnknownTags()` 内 `const seen = new Set<number>()`，`literal()` 对已见偏移省掉起始标签文字、保留 children 与 `owned` 的结束标签。
- [ ] 1.4 顺带小修：`markdown-html.ts:2-3` 注释补 `recordRawSegments`；`chat-markdown-html.test.tsx:20` 注释改为说明差异；`chat-markdown.test.tsx:144` 改精确比较。
- [ ] 1.5 验证：`npm test --workspace web`；typecheck；`wc -l markdown-literal.ts` ≤ 80；`make check`；`git diff --stat` 只含 `web/src/features/chat/{markdown-literal.ts,markdown-html.ts}` 与 `web/test/**`。
