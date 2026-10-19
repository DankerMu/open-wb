// 助手正文源 HTML 的处理步骤与消毒白名单（epic-acceptance-followups design D1；chat-web「消息线程」的「正文」规则）。
// 管线顺序在 markdown-body.tsx：rehype-raw → inertUnsafeTargets → literalUnknownTags（markdown-literal.ts）→
// rehype-sanitize → styleGuard。
import type { Options as SanitizeSchema } from "rehype-sanitize";

/** 语法树节点的最小结构（hast 的子集）：只读写这里用到的字段，不引入 `hast` 类型包。 */
export type TreeNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/**
 * 可点链接与可加载图片只认这几个协议；按字面前缀比对，与 sanitize 的协议表（区分大小写）同一口径。http(s) 后必须是
 * `//`：`https:evil`、`https:/api/x` 会被浏览器按相对地址解析成同源请求。
 */
const LINK_TARGET = /^(?:https?:\/\/|mailto:)/;
const IMAGE_SOURCE = /^https?:\/\//;

function stringProperty(node: TreeNode, name: string): string {
  const value = node.properties?.[name];
  return typeof value === "string" ? value : "";
}

export function mapChildren(node: TreeNode, step: (child: TreeNode) => TreeNode[]) {
  if (node.children) node.children = node.children.flatMap(step);
}

/** 先处理子树，再决定本节点：不安全目标的 `a` 换成其子节点，`img` 换成 alt（没有 alt 时为地址）文本。 */
function inert(node: TreeNode): TreeNode[] {
  mapChildren(node, inert);
  if (node.type !== "element") return [node];
  if (node.tagName === "a" && !LINK_TARGET.test(stringProperty(node, "href"))) {
    return node.children ?? [];
  }
  if (node.tagName === "img" && !IMAGE_SOURCE.test(stringProperty(node, "src"))) {
    const text = stringProperty(node, "alt") || stringProperty(node, "src");
    return text ? [{ type: "text", value: text }] : [];
  }
  if (node.tagName === "input" && stringProperty(node, "type").toLowerCase() !== "checkbox") {
    return [];
  }
  return [node];
}

/**
 * 在 sanitize 之前跑：这时还拿得到原始地址（sanitize 与 react-markdown 的 urlTransform 会先删掉
 * `javascript:`/`data:`，之后就无法按规则显示无 alt 图片的地址）。另外整个删掉 `type` 不是 checkbox 的
 * `input`：sanitize 的取值元组只丢掉 `type`，`required` 又会把它补成禁用的 checkbox。
 */
export function inertUnsafeTargets() {
  return (tree: TreeNode) => {
    mapChildren(tree, inert);
  };
}

/**
 * 白名单 schema，显式写全：`hast-util-sanitize` 以 `{...defaultSchema, ...schema}` 浅合并，这里给出的键整体取代
 * 缺省（缺省会留下 `style` 元素的 CSS 文本、给 `id`/`name` 加前缀保留）。`protocols`、`required`、`ancestors`
 * 沿用缺省。`target`、`rel` 不在这里，由 markdown-body.tsx 的链接组件统一写出。
 */
export const SANITIZE_SCHEMA: SanitizeSchema = {
  // chat-web「正文」的元素白名单逐项照抄；缺省里的 picture/source/samp/var/section 等不在其内（去元素留文字）。
  tagNames: (
    "p h1 h2 h3 h4 h5 h6 b strong i em u s del ins mark kbd code pre sub sup span br hr div blockquote q " +
    "ul ol li dl dt dd table thead tbody tfoot tr th td details summary a img input"
  ).split(" "),
  strip: ["script", "style", "noscript", "textarea", "iframe", "object", "embed"],
  attributes: {
    "*": ["style", "title", "lang", "dir"],
    a: ["href"],
    img: ["src", "alt", "width", "height"],
    td: ["colSpan", "rowSpan", "align"],
    th: ["colSpan", "rowSpan", "align"],
    ol: ["start", ["className", "contains-task-list"]],
    ul: [["className", "contains-task-list"]],
    li: [["className", "task-list-item"]],
    code: [["className", /^language-./]],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
  },
  clobber: [],
};

/** 借 CSS 函数外连的取值（A2：只剥这些，布局声明放行）。 */
const RESOURCE_FUNCTIONS =
  "url( image( image-set( -webkit-image-set( cross-fade( src( expression(".split(" ");

/** CSS 转义：`\` 后 1–6 位十六进制（可跟一个空白）或任意单个字符。越界码位按规范换成 U+FFFD。 */
function decodeEscapes(css: string): string {
  return css.replace(
    /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/giu,
    (_, hex?: string, char?: string) => {
      if (hex === undefined) return char ?? "";
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(code);
    },
  );
}

const normalized = (css: string) => decodeEscapes(css).toLowerCase().replace(/\s+/gu, "");

/**
 * 含 `/*` 即判外连：渲染器（inline-style-parser）先按 `;` 切声明再逐值去注释，整串去注释的判法会跨声明配对
 * （`content:'/*';background:u/**\/rl(…)` 渲染后是 `url(`）；CSS 转义造不出 `/*`，一刀切不误伤布局声明。
 * 否则解码转义、小写、去空白后含任一资源函数即判外连。
 */
function loadsResource(style: string): boolean {
  const css = normalized(style);
  return style.includes("/*") || RESOURCE_FUNCTIONS.some((fn) => css.includes(fn));
}

function guardStyle(node: TreeNode): TreeNode[] {
  mapChildren(node, guardStyle);
  const { style, ...rest } = node.properties ?? {};
  if (typeof style === "string" && loadsResource(style)) node.properties = rest;
  return [node];
}

/** 在 sanitize 之后跑：外连的 `style` 整个属性丢弃，元素保留。 */
export function styleGuard() {
  return (tree: TreeNode) => {
    mapChildren(tree, guardStyle);
  };
}
