/**
 * The preview half of `WorkspaceBrowser`: the selected file with the state of its preview request,
 * and what the pane shows for each state. The request itself lives in the browser.
 */
import { ApiError } from "../../lib/api.js";
import { ALERT_BOX, EmptyPreview, STATUS_TEXT } from "./columns.js";
import { errorMessage } from "./errors.js";
import { PreviewPane } from "./preview.js";
import { previewKind, textView } from "./previewers/index.js";
import type { FetchedPreview, PreviewState, TreeEntry } from "./types.js";
import type { usePreviewToken } from "./use-preview-token.js";

export type SelectedFile = {
  entry: TreeEntry;
  path: string;
  preview: PreviewState | null;
};

type PreviewAreaProps = {
  loading: boolean;
  selectedFile: SelectedFile | null;
  /** 没有选中文件时代替空态显示的失败文案（当前路径没有定位到文件）。 */
  notice?: string | null | undefined;
  workspaceId: string;
  /** 宿主那一次 `usePreviewToken` 的结果，原样交给预览面板。 */
  previewToken: ReturnType<typeof usePreviewToken>;
  onWebViewChange(view: WebView): void;
};

/** 取预览失败后的呈现：不支持与超限按信封的 code 认，其余显示信封 message 或安全文案。 */
export function failedPreview(error: unknown): FetchedPreview {
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
type WebPreview = Extract<PreviewState, { status: "web" }>;
type WebView = WebPreview["view"];

/**
 * 把一次 `file` 请求的结局放进当前预览：网页的源码视图收进 `source`，视图与 `reload` 不动（所以
 * 源码请求失败后仍是网页预览，切换按钮还在）；其余类别结局就是预览本身。
 */
export function withFetched(current: PreviewState | null, fetched: FetchedPreview): PreviewState {
  return current?.status === "web" ? { ...current, source: fetched } : fetched;
}

/** 文档预览的 `reload`：同一路径上一次也是文档预览时加一，否则从 0 起。 */
function documentReload(previous: PreviewState | null): number {
  return previous?.status === "document" ? previous.reload + 1 : 0;
}

/**
 * 选中即有、不发 `file` 请求的预览；`null` 表示这个文件照常请求。`previous` 是同一路径上一次的
 * 预览（换了文件为 `null`）。
 * 音视频：把文件自己的地址 `url` 交给媒体元素，由浏览器去取；再次选中或刷新时 `reload` 加一，
 * 预览面板据此换一个新的媒体元素（地址不变）。压缩包：把 `listArchive`（对这个文件的一次成员列表
 * 请求）交给压缩包预览器，由它在挂上之后调用。
 * 网页：默认是渲染视图，由预览器把隔离预览来源的地址交给框，页面不为它发 `file` 请求。换了文件
 * 视图回到渲染；再次选中或刷新时，渲染视图 `reload` 加一并丢掉取过的源码（下次看源码重新取）；
 * 源码视图返回 `null`，照常请求一次，结局由 `withFetched` 收进 `source`。
 * PDF 与办公文档：同样不请求 `file`，由预览器的框从隔离预览来源加载；再次选中或刷新时 `reload`
 * 加一，预览器据此换一个新的框。
 */
export function immediatePreview(
  entry: TreeEntry,
  url: string,
  listArchive: ArchiveLoad,
  previous: PreviewState | null,
): PreviewState | null {
  const kind = previewKind(entry.name);
  if (kind === "text" && textView(entry.name) === "web") {
    if (previous?.status !== "web") {
      return { status: "web", view: "rendered", reload: 0, source: null };
    }
    return previous.view === "source"
      ? null
      : { ...previous, reload: previous.reload + 1, source: null };
  }
  if (kind === "pdf" || kind === "office") {
    return { status: "document", reload: documentReload(previous) };
  }
  if (kind === "archive") {
    return { status: "archive", load: listArchive };
  }
  if (kind === "audio" || kind === "video") {
    const reload =
      previous?.status === "success" && previous.data.kind === "media"
        ? previous.data.reload + 1
        : 0;
    return {
      status: "success",
      data: { kind: "media", url, reload, size: entry.size, truncated: false },
    };
  }

  return null;
}

export function PreviewArea({
  loading,
  notice,
  onWebViewChange,
  previewToken,
  selectedFile,
  workspaceId,
}: PreviewAreaProps) {
  if (!selectedFile) {
    return notice ? (
      <p className={`${ALERT_BOX} mx-4 mt-3 shrink-0 text-[12px]`} role="alert">
        {notice}
      </p>
    ) : (
      <EmptyPreview />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {selectedFile.preview ? (
        <PreviewPane
          mtime={selectedFile.entry.mtime}
          name={selectedFile.entry.name}
          onWebViewChange={onWebViewChange}
          path={selectedFile.path}
          preview={selectedFile.preview}
          previewToken={previewToken}
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
