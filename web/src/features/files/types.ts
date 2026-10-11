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
      /** 音视频：`url` 是文件本身的地址（`fileUrl`），由媒体元素自己去取，页面不读它的字节。 */
      kind: "media";
      url: string;
      size: number;
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
  | { status: "web"; view: "rendered" | "source"; reload: number; source: FetchedPreview | null };
