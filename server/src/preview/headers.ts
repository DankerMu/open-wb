/**
 * 预览监听器的响应头与内容类型表（preview-origin「预览响应头与内容类型」）。纯函数，没有 import。
 * 预览来源的隔离性质全在这里：非 PDF 的文档一律带 CSP `sandbox`（不含 `allow-same-origin`，
 * 文档是不透明来源），谁能把它嵌进页面由 `frame-ancestors` 决定。类型只看文件名，不看内容。
 * 状态码与失败正文的文案是监听器的事，不在本模块。
 */

const OCTET_STREAM = "application/octet-stream";
const PDF = "application/pdf";
const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";
const JSON_TEXT = "application/json; charset=utf-8";
const PLAIN = "text/plain; charset=utf-8";

// 只经 Map 查：`a.constructor`、`a.__proto__` 不得从原型上捡到一个类型。
// 值是写死的字面量，不从 workspaces 的分类器导入；`xml` 是纯文本，表里没有任何 XML 类型。
const TYPES: ReadonlyMap<string, string> = new Map([
  ["html", HTML],
  ["htm", HTML],
  ["css", "text/css; charset=utf-8"],
  ["js", JAVASCRIPT],
  ["mjs", JAVASCRIPT],
  ["json", JSON_TEXT],
  ["map", JSON_TEXT],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["pdf", PDF],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["txt", PLAIN],
  ["md", PLAIN],
  ["csv", PLAIN],
  ["tsv", PLAIN],
  ["xml", PLAIN],
]);

/** 在 CSP 里有语法含义的字符：通配、指令分隔、策略分隔、关键字引号。主机名里出现它们的不算来源。 */
const CSP_SYNTAX = ["*", ";", ",", "'"];

/** 最后一个 `.` 之后的小写扩展名；没有 `.` 的名字（`README`、`html`）没有扩展名。 */
function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return OCTET_STREAM;
  }
  return TYPES.get(name.slice(dot + 1).toLowerCase()) ?? OCTET_STREAM;
}

/**
 * `embedOrigin` 是签发请求的 `Origin` 头，非浏览器客户端可以写任何东西。只有恰是一个序列化来源
 * （`scheme://host[:port]`，解析后原样往返）且不含 CSP 语法字符时才写进头，否则与没有一样取 `'none'`。
 */
function frameAncestors(embedOrigin: string | null): string {
  const isOrigin =
    embedOrigin !== null &&
    URL.canParse(embedOrigin) &&
    new URL(embedOrigin).origin === embedOrigin &&
    !CSP_SYNTAX.some((syntax) => embedOrigin.includes(syntax));
  return `frame-ancestors ${isOrigin ? embedOrigin : "'none'"}`;
}

/** 每个响应都带的三项。每次调用给新对象，调用方可以往里加头。 */
function commonHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * `/w/` 与 `/o/` 成功响应的全部头。`name` 可以是带 `/` 的相对路径。
 * 是否带 `sandbox` 只看算出的类型是不是 PDF（浏览器自带的查看器在 sandbox 里不工作），不看原始文件名。
 * 不设任何取源指令：预览加载外部资源是被允许的。
 */
export function previewHeaders(name: string, embedOrigin: string | null): Record<string, string> {
  const contentType = contentTypeOf(name);
  const ancestors = frameAncestors(embedOrigin);
  return {
    ...commonHeaders(contentType),
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy":
      contentType === PDF
        ? ancestors
        : `sandbox allow-scripts allow-forms allow-modals; ${ancestors}`,
  };
}

/** 失败响应（404 / 403 / 416）的全部头：纯文本加三项公共头，没有 ACAO、CORP 与 CSP。 */
export function previewFailureHeaders(): Record<string, string> {
  return commonHeaders(PLAIN);
}
