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
    };

export type PreviewState =
  | { status: "success"; data: FilePreview }
  | { status: "error"; message: string }
  | { status: "unsupported"; message?: string };
