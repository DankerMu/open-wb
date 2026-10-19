// 白名单外标签按源文本原样显示（epic-acceptance-followups design D1 `literalUnknownTags`；owner 2026-10-18：`<task>`
// 这类占位符不丢）。管线位置见 markdown-body.tsx：recordRawSegments 在 rehype-raw 之前，literalUnknownTags 在
// inertUnsafeTargets 之后、sanitize 之前。
import { mapChildren, SANITIZE_SCHEMA, type TreeNode } from "./markdown-html.js";

type Segment = { start: number; value: string };
type File = { data: Record<string, unknown> };
const SEGMENTS = "workbuddyRawSegments";
const KEPT = new Set([...(SANITIZE_SCHEMA.tagNames ?? []), ...(SANITIZE_SCHEMA.strip ?? [])]);
/** 起始标签原文（粘在 lastIndex 上）：到第一个不在属性值引号里的 `>`；引号只在 `=` 之后开启（HTML 分词同一规则），分支互斥、线性。 */
const START_TAG = /<(?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=(?!\s*["'])|["'])*>/uy;

/**
 * rehype-raw 在每个 `raw` 节点起点重设位置后按该节点的值计数（remark 已剥掉列表缩进、`> ` 等逐行前缀），所以
 * 源 HTML 元素的偏移是「raw 起点 + 在值内的下标」，不能拿去切整份源文本。在 rehype-raw 之前只读地记下各 raw 段。
 */
export function recordRawSegments() {
  return (tree: TreeNode, file: File) => {
    const segments: Segment[] = [];
    const visit = (node: TreeNode) => {
      const start = node.position?.start?.offset;
      if (node.type === "raw" && start !== undefined)
        segments.push({ start, value: node.value ?? "" });
      node.children?.forEach(visit);
    };
    visit(tree);
    file.data[SEGMENTS] = segments.sort((a, b) => a.start - b.start);
  };
}

/** 含 `offset` 的 raw 段：各段按值计的区间 `[start, start + value.length)` 互不重叠，二分查找。 */
function segmentAt(segments: Segment[], offset: number): Segment | undefined {
  let [low, high] = [0, segments.length - 1];
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (!segment) return undefined;
    if (offset < segment.start) high = middle - 1;
    else if (offset >= segment.start + segment.value.length) low = middle + 1;
    else return segment;
  }
  return undefined;
}

/** 先处理子树；白名单外、源 HTML 写出的元素换成「起始标签原文、子节点、自己的结束标签原文」（无结束标签时结束位置收在末个子节点尾上，故先取 tailEnd）。 */
function literal(segments: Segment[], node: TreeNode): TreeNode[] {
  const tailEnd = node.children?.at(-1)?.position?.end?.offset;
  mapChildren(node, (child) => literal(segments, child));
  if (node.type !== "element" || !node.tagName || KEPT.has(node.tagName)) return [node];
  const children = node.children ?? [];
  // 起始标签只认起始位置（段尾未闭合又没有内容的 `<file>`，rehype-raw 给的结束位置是 0）。
  const from = node.position?.start?.offset ?? -1;
  const segment = segmentAt(segments, from);
  if (!segment) return children;
  START_TAG.lastIndex = from - segment.start;
  const open = START_TAG.exec(segment.value)?.[0];
  const name = node.tagName.toLowerCase();
  if (!open?.toLowerCase().startsWith(`<${name}`)) return children;
  // 结束位置只用来认结束标签：早于起始标签的尾即视为没有；结束标签取自含 `end - 1` 的 raw 段。
  const to = node.position?.end?.offset ?? 0;
  const closing = to >= from + open.length ? segmentAt(segments, to - 1) : undefined;
  const after = closing === segment ? from - segment.start + open.length : 0;
  const head = closing ? closing.value.slice(after, to - closing.start) : "";
  const close = head.slice(head.lastIndexOf("</"));
  const owned = /^<\/(\S+?)\s*>$/u.exec(close)?.[1]?.toLowerCase() === name && tailEnd !== to;
  const text = (value: string): TreeNode[] => [{ type: "text", value }];
  return [...text(open), ...children, ...(owned ? text(close) : [])];
}

/** 找不到所在 raw 段、没有位置或该处不以该标签起头（GFM 脚注的 `section` 等 Markdown 自己生成的）换成其子节点，与 sanitize 去壳留文字相同。 */
export function literalUnknownTags() {
  return (tree: TreeNode, file: File) => {
    const segments = (file.data[SEGMENTS] as Segment[] | undefined) ?? [];
    mapChildren(tree, (node) => literal(segments, node));
  };
}
