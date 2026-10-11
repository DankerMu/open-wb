/**
 * The preview half of `WorkspaceBrowser`: the selected file with the state of its preview request,
 * and what the pane shows for each state. The request itself lives in the browser.
 */
import { ApiError } from "../../lib/api.js";
import { EmptyPreview, STATUS_TEXT } from "./columns.js";
import { errorMessage } from "./errors.js";
import { PreviewPane } from "./preview.js";
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
