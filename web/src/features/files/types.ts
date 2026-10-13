import type { ApiClient } from "../../lib/api.js";

export type Workspace = {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
};

export type TreeEntry = {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
};

export type DirectoryListing = {
  path: string;
  entries: TreeEntry[];
};

type FilePreview =
  | {
      kind: "text";
      text: string;
      size: number;
      truncated: boolean;
    }
  | {
      kind: "image";
      url: string;
      size: number;
      truncated: boolean;
    }
  | {
      /**
       * 音视频：`url` 是交给媒体元素的地址，由它自己去取，页面不读它的字节。首次选中时恰为文件
       * 本身的地址（`fileUrl`），重取之后其后追加 `&v=<n>`。`reload` 每加一，媒体元素换一个新的。
       */
      kind: "media";
      url: string;
      reload: number;
      /** 树条目的大小；条目没有它时缺（#1372）。 */
      size?: number | undefined;
      truncated: false;
    };

/** 一次 `file` 请求的结局：取回的正文，或失败后的三种呈现之一。 */
export type FetchedPreview =
  | { status: "success"; data: FilePreview }
  | { status: "error"; message: string }
  | { status: "unsupported" }
  | { status: "too-large" };

export type PreviewState =
  | FetchedPreview
  /**
   * 压缩包：没有预取的正文，成员由预览器自己调 `load` 列出。每次选中或刷新给一个新的 `load`，
   * 预览器据此重新列出。
   */
  | {
      status: "archive";
      load: (signal: AbortSignal) => Promise<Awaited<ReturnType<ApiClient["listArchive"]>>>;
    }
  /**
   * 网页（html / htm）：选中即有，不发 `file` 请求。`view` 是当前视图；`reload` 每加一，渲染视图的
   * 框换一个新的；`source` 是源码视图那一次 `file` 请求的结局，没取过或正在取第一次时为 `null`。
   * 预览令牌与它的地址前缀不在这里。
   */
  | { status: "web"; view: "rendered" | "source"; reload: number; source: FetchedPreview | null }
  /**
   * PDF 与办公文档（docx / xlsx / pptx）：选中即有，不发 `file` 请求，正文由预览器的框从隔离预览
   * 来源加载。`reload` 每加一，框换一个新的。预览令牌与它的地址前缀不在这里。
   */
  | { status: "document"; reload: number };
