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

export type PreviewState =
  | { status: "success"; data: FilePreview }
  | { status: "error"; message: string }
  | { status: "unsupported" }
  | { status: "too-large" };
