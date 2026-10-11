/**
 * The one place in `web/src` that splits code (ADR-0013 增补; guarded by
 * web/test/previewers-code-split.test.ts): each previewer is its own chunk, fetched the first
 * time its kind is shown. Stateless on purpose — the caller (`preview.tsx`) owns the cache, so
 * 「同一类别不再加载」 is counted as calls to `loadPreviewer`.
 */
import type { ReactElement } from "react";

export { previewKind, textView } from "./kind.js";

export type PreviewerId = "markdown" | "table" | "code" | "image" | "svg";

/**
 * `content` is the text for text previewers and the caller-owned Blob URL for the image one.
 * `truncated` says the text is only the head of the file; previewers that show it as is ignore it.
 */
export type Previewer = (props: {
  name: string;
  content: string;
  truncated: boolean;
}) => ReactElement;

const LOADERS: Record<PreviewerId, () => Promise<Previewer>> = {
  markdown: () => import("./markdown.js").then((module) => module.MarkdownPreviewer),
  table: () => import("./table.js").then((module) => module.TablePreviewer),
  code: () => import("./code.js").then((module) => module.CodePreviewer),
  image: () => import("./image.js").then((module) => module.ImagePreviewer),
  svg: () => import("./svg.js").then((module) => module.SvgPreviewer),
};

export function loadPreviewer(id: PreviewerId): Promise<Previewer> {
  return LOADERS[id]();
}
