/**
 * Issue 1974 WORKBUDDY_KB_SEARCH:<kbId> (omp-test-harness「受控上游知识库检索标记」): the stage is
 * the count of `role:"tool"` messages after the turn's last user message — 0 is the first
 * `kb_search` call, 1 the second, 2 or more the fixed answer. The marker counts only when the
 * request's `tools` names `kb_search`. Zero-dependency sibling of fake-upstream.mjs, which counts
 * the tool messages (whatever its `toolRoundScope`), dispatches before its other tool / text
 * markers, and writes the frames.
 *
 * The spec has the kbId run to the next whitespace, empty being no marker. Decided here: the first
 * occurrence decides; whitespace is `\s` (so also U+3000, as HOLD_AT) or the end of the text;
 * malformed `tools` is no marker; the question keeps every other marker spelling untouched.
 */
const KB_MARKER = "WORKBUDDY_KB_SEARCH:";
const KB_TOOL = "kb_search";

/** `undefined` (no marker), `{ call: { name, arguments } }` or `{ parts }` of the answer. */
export function kbSearchReply(text, tools, toolCount) {
  if (!Array.isArray(tools) || !tools.some((item) => item?.function?.name === KB_TOOL)) {
    return undefined;
  }
  const index = text.indexOf(KB_MARKER);
  if (index === -1) {
    return undefined;
  }
  const [kbId] = text.slice(index + KB_MARKER.length).split(/\s/u, 1);
  if (kbId === "") {
    return undefined;
  }
  if (toolCount >= 2) {
    return { parts: ["已根据知识库检索结果作答。"] };
  }
  const end = index + KB_MARKER.length + kbId.length;
  const asked = (text.slice(0, index) + text.slice(end)).trim();
  const question = toolCount === 0 ? asked : `${asked} 详细说明`;
  const i = `第 ${toolCount + 1} 轮`;
  return { call: { name: KB_TOOL, arguments: JSON.stringify({ question, kb_ids: [kbId], i }) } };
}
