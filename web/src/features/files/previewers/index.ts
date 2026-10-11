/**
 * The one place in `web/src` that splits code (ADR-0013 增补; guarded by
 * web/test/previewers-code-split.test.ts): each previewer is its own chunk, fetched the first
 * time its kind is shown. `loadPreviewer` is stateless on purpose — the caller (`preview.tsx`)
 * owns the cache, so 「同一类别不再加载」 is counted as calls to `loadPreviewer`. `loadHighlighter`
 * keeps its own promise: no requirement counts its calls, and every source view shares one load.
 */
import type { ReactElement, ReactNode } from "react";
import type { PreviewState } from "../types.js";

export { previewKind, textView } from "./kind.js";

export type PreviewerId =
  | "markdown"
  | "table"
  | "code"
  | "image"
  | "svg"
  | "media"
  | "archive"
  | "notebook";

/**
 * `content` is the text for text previewers, the caller-owned Blob URL for the image one and the
 * file's own address for the media one; the archive one gets none and lists the members itself
 * through `load`.
 * `truncated` says the text is only the head of the file; previewers that show it as is ignore it.
 */
export type Previewer = (props: {
  name: string;
  content: string;
  truncated: boolean;
  load?: Extract<PreviewState, { status: "archive" }>["load"] | undefined;
}) => ReactElement;

const LOADERS: Record<PreviewerId, () => Promise<Previewer>> = {
  markdown: () => import("./markdown.js").then((module) => module.MarkdownPreviewer),
  table: () => import("./table.js").then((module) => module.TablePreviewer),
  code: () => import("./code.js").then((module) => module.CodePreviewer),
  image: () => import("./image.js").then((module) => module.ImagePreviewer),
  svg: () => import("./svg.js").then((module) => module.SvgPreviewer),
  media: () => import("./media.js").then((module) => module.MediaPreviewer),
  archive: () => import("./archive.js").then((module) => module.ArchivePreviewer),
  notebook: () => import("./notebook.js").then((module) => module.NotebookPreviewer),
};

export function loadPreviewer(id: PreviewerId): Promise<Previewer> {
  return LOADERS[id]();
}

/**
 * One node per line of `text`, coloured for `language`. Spelled out here instead of derived from
 * `highlight.ts`: this file may only reach that module through the dynamic import below.
 */
export type Highlighter = (text: string, language: string) => ReactNode[];

let highlighter: Promise<Highlighter> | null = null;

/**
 * 高亮库所在的按需块；在途与已就绪的加载共用一个 promise。被拒绝后清空，下次调用重新执行
 * `import()`——浏览器是否为它重新发请求由浏览器决定，这里不保证。
 */
export function loadHighlighter(): Promise<Highlighter> {
  if (highlighter === null) {
    const loading = import("./highlight.js").then((module) => module.highlightLines);
    loading.catch(() => {
      if (highlighter === loading) highlighter = null;
    });
    highlighter = loading;
  }
  return highlighter;
}
