/**
 * Which previewer a file name gets (file-previewers「类别判定与预览器选择」). Pure functions of the
 * name: whether a `text` file really is text stays the server's call.
 */

type PreviewKind = "image" | "pdf" | "office" | "audio" | "video" | "notebook" | "archive" | "text";

type TextView = "markdown" | "table" | "web" | "svg" | "code";

const KIND_BY_EXTENSION = new Map<string, PreviewKind>([
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["bmp", "image"],
  ["ico", "image"],
  ["pdf", "pdf"],
  ["docx", "office"],
  ["xlsx", "office"],
  ["pptx", "office"],
  ["mp3", "audio"],
  ["wav", "audio"],
  ["mp4", "video"],
  ["webm", "video"],
  ["ipynb", "notebook"],
  // `.tar.gz` 的最后一段也是 `gz`，不必另列。
  ["zip", "archive"],
  ["tar", "archive"],
  ["tgz", "archive"],
  ["gz", "archive"],
]);

const TEXT_VIEW_BY_EXTENSION = new Map<string, TextView>([
  ["md", "markdown"],
  ["csv", "table"],
  ["tsv", "table"],
  ["html", "web"],
  ["htm", "web"],
  ["svg", "svg"],
]);

/** 最后一个 `.` 之后、小写；没有 `.` 或唯一的 `.` 在开头（`.env`）时为空串。 */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKind(name: string): PreviewKind {
  return KIND_BY_EXTENSION.get(fileExtension(name)) ?? "text";
}

/** `previewKind(name) === "text"` 之内的呈现细分。 */
export function textView(name: string): TextView {
  return TEXT_VIEW_BY_EXTENSION.get(fileExtension(name)) ?? "code";
}
