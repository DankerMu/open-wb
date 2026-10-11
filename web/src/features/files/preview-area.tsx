/**
 * The preview half of `WorkspaceBrowser`: the selected file with the state of its preview request,
 * and what the pane shows for each state. The request itself lives in the browser.
 */
import { ApiError } from "../../lib/api.js";
import { EmptyPreview, STATUS_TEXT } from "./columns.js";
import { errorMessage } from "./errors.js";
import { PreviewPane } from "./preview.js";
import { previewKind } from "./previewers/index.js";
import type { PreviewState, TreeEntry } from "./types.js";

export type SelectedFile = {
  entry: TreeEntry;
  path: string;
  preview: PreviewState | null;
};

type PreviewAreaProps = {
  loading: boolean;
  selectedFile: SelectedFile | null;
  workspaceId: string;
};

/** 取预览失败后的呈现：不支持与超限按信封的 code 认，其余显示信封 message 或安全文案。 */
export function failedPreview(error: unknown): PreviewState {
  const code = error instanceof ApiError ? error.code : null;
  if (code === "preview_unsupported") {
    return { status: "unsupported" };
  }
  if (code === "preview_too_large") {
    return { status: "too-large" };
  }

  return { status: "error", message: errorMessage(error) };
}

type ArchiveLoad = Extract<PreviewState, { status: "archive" }>["load"];

/**
 * 选中即有、不发 `file` 请求的预览；`null` 表示这个文件照常请求。音视频：把文件自己的地址 `url`
 * 交给媒体元素，由浏览器去取。压缩包：把 `listArchive`（对这个文件的一次成员列表请求）交给压缩包
 * 预览器，由它在挂上之后调用。
 */
export function immediatePreview(
  entry: TreeEntry,
  url: string,
  listArchive: ArchiveLoad,
): PreviewState | null {
  const kind = previewKind(entry.name);
  if (kind === "archive") {
    return { status: "archive", load: listArchive };
  }
  if (kind === "audio" || kind === "video") {
    return {
      status: "success",
      data: { kind: "media", url, size: entry.size, truncated: false },
    };
  }

  return null;
}

export function PreviewArea({ loading, selectedFile, workspaceId }: PreviewAreaProps) {
  if (!selectedFile) {
    return <EmptyPreview />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {selectedFile.preview ? (
        <PreviewPane
          mtime={selectedFile.entry.mtime}
          name={selectedFile.entry.name}
          path={selectedFile.path}
          preview={selectedFile.preview}
          size={selectedFile.entry.size}
          workspaceId={workspaceId}
        />
      ) : (
        <p className={STATUS_TEXT} role="status">
          正在读取文件
        </p>
      )}
      {loading && selectedFile.preview ? (
        <p className={STATUS_TEXT} role="status">
          正在读取文件
        </p>
      ) : null}
    </div>
  );
}
