/**
 * File preview shell: header (with the download link every file gets), truncation line,
 * unsupported, too-large and error states render here, synchronously. The body of a successful
 * preview comes from a previewer module under `previewers/`, loaded on first use through
 * `previewers/index.ts` (the app's only code split); this module owns the cache of loaded previewers.
 * An archive has no fetched body: its previewer is loaded the same way and lists the members itself.
 * A web page has none either: its previewer gets the preview token, the view and, as its source
 * view, the body this module renders for the outcome of the source request. The token only passes
 * through here on its way from the host's prop to that previewer.
 * A PDF or an office document has no fetched body either: its previewer gets the token, the path
 * and the entry's size, and decides there whether a frame is built.
 * `size` and `mtime` are the tree entry's and may be missing together (a row of the session
 * sidebar's filtered view whose parent directory was never listed, issue 1372): the header then has no
 * size / time line and the unsupported and too-large lines are the file name alone. Nothing stands
 * in for them. The size in the truncation line is the response's own and is always there.
 * Blob URLs are caller-owned; this module never allocates or revokes them.
 * Markdown mode is keyed by `path`; callers must remount across workspaces
 * if the same relative path can name different files.
 * The `data-slot` names are the stable hooks tests and the UI walk select by.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadUrl } from "../../lib/api.js";
import { Icon } from "../../ui/index.js";
import { ALERT_BOX, STATUS_TEXT } from "./columns.js";
import { EmptyState } from "./empty-state.js";
import { fileIcon, formatMtime, formatSize, withSize } from "./file-meta.js";
import {
  loadPreviewer,
  type Previewer,
  type PreviewerId,
  previewKind,
  textView,
} from "./previewers/index.js";
import type { PreviewState } from "./types.js";
import type { usePreviewToken } from "./use-preview-token.js";

type FilePreviewSuccess = Extract<PreviewState, { status: "success" }>["data"];
type WebPreview = Extract<PreviewState, { status: "web" }>;
type DocumentPreview = Extract<PreviewState, { status: "document" }>;

type PreviewPaneProps = {
  workspaceId: string;
  path: string;
  name: string;
  size?: number | undefined;
  mtime?: number | undefined;
  preview: PreviewState;
  /** The host's `usePreviewToken` result; a web page's rendered view, a PDF and an office document read it. */
  previewToken: ReturnType<typeof usePreviewToken>;
  /** 查看源码 / 渲染视图 of a web page: the view is the host's. Without it the button does nothing. */
  onWebViewChange?: ((view: WebPreview["view"]) => void) | undefined;
};

/**
 * Previewers for the page's lifetime. `previewerLoads` holds one `loadPreviewer` call per kind,
 * shared by every mount waiting on it (StrictMode's double effect included); a rejected load
 * drops its entry, so 重试 starts over. `readyPreviewers` lets a loaded kind render on the first
 * frame instead of after an effect.
 */
const previewerLoads = new Map<PreviewerId, Promise<Previewer>>();
const readyPreviewers = new Map<PreviewerId, Previewer>();

function acquirePreviewer(id: PreviewerId): Promise<Previewer> {
  const started = previewerLoads.get(id);
  if (started) return started;
  const load = loadPreviewer(id).then(
    (previewer) => {
      readyPreviewers.set(id, previewer);
      return previewer;
    },
    (error: unknown) => {
      previewerLoads.delete(id);
      throw error;
    },
  );
  previewerLoads.set(id, load);
  return load;
}

/** The data's shape wins over the name: an image payload is an image whatever the file is called. */
function previewerFor(name: string, data: FilePreviewSuccess): PreviewerId {
  if (data.kind === "image") return "image";
  if (data.kind === "media") return "media";
  const kind = previewKind(name);
  if (kind === "notebook") return "notebook";
  if (kind !== "text") return "code";
  const view = textView(name);
  return view === "markdown" || view === "table" || view === "svg" ? view : "code";
}

export function PreviewPane({
  workspaceId,
  path,
  name,
  size,
  mtime,
  preview,
  previewToken,
  onWebViewChange = ignoreViewChange,
}: PreviewPaneProps) {
  // 网页的渲染视图不受预览上限约束：截断行只属于它的源码视图。
  const shown = preview.status === "web" && preview.view === "source" ? preview.source : preview;
  const truncatedSize =
    shown?.status === "success" && shown.data.truncated ? shown.data.size : null;
  const meta =
    size === undefined || mtime === undefined
      ? null
      : `${formatSize(size)} · ${formatMtime(mtime)}`;
  return (
    <article className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header
        className="flex min-w-0 shrink-0 items-center gap-3 border-b border-(--wb-border-default) px-4 py-[0.65rem] narrow:flex-wrap narrow:items-start"
        data-slot="preview-header"
      >
        <span className="inline-flex flex-none text-(--wb-text-secondary)">
          <Icon name={fileIcon(name)} size={16} />
        </span>
        <p
          className="min-w-0 font-(family-name:--wb-mono) text-[0.75rem] [overflow-wrap:anywhere]"
          data-slot="preview-path"
        >
          {path}
        </p>
        {meta === null ? null : (
          <p
            className="ml-auto shrink text-[0.7rem] text-(--wb-text-tertiary) [overflow-wrap:anywhere] narrow:ml-0"
            data-slot="preview-meta"
          >
            {meta}
          </p>
        )}
        {/* 浏览器直接导航下载：文件名由服务端的 Content-Disposition 给，这里不经 fetch。 */}
        <a
          aria-label={`下载 ${name}`}
          // 没有大小与时间那一段时由下载链接自己靠右。
          className={`inline-flex shrink-0 rounded-[6px] p-1 text-(--wb-text-secondary) hover:bg-(--wb-brand-primary-subtle) hover:text-(--wb-text-primary) ${meta === null ? "ml-auto" : ""}`}
          download
          href={downloadUrl(workspaceId, path)}
          title={`下载 ${name}`}
        >
          <Icon name="download" size={16} />
        </a>
      </header>
      {truncatedSize === null ? null : (
        <p className="px-4 pt-[0.65rem] text-[13px] text-muted-foreground">{`文件超过预览上限，仅显示开头部分 · 共 ${formatSize(truncatedSize)}`}</p>
      )}
      {preview.status === "web" ? (
        <LoadedPreview
          content=""
          id="web"
          key={path}
          name={name}
          truncated={false}
          web={{
            path,
            token: previewToken,
            view: preview.view,
            reload: preview.reload,
            onViewChange: onWebViewChange,
            source: preview.source ? (
              <PreviewBody name={name} preview={preview.source} size={size} />
            ) : null,
          }}
        />
      ) : preview.status === "document" ? (
        <LoadedPreview
          content=""
          doc={{
            path,
            token: previewToken,
            reload: preview.reload,
            size,
            office: previewKind(name) === "office",
          }}
          id="document"
          key={path}
          name={name}
          truncated={false}
        />
      ) : (
        <PreviewBody key={path} name={name} preview={preview} size={size} />
      )}
    </article>
  );
}

function ignoreViewChange() {}

function PreviewBody({
  name,
  preview,
  size,
}: {
  name: string;
  preview: Exclude<PreviewState, WebPreview | DocumentPreview>;
  size: number | undefined;
}) {
  if (preview.status === "unsupported" || preview.status === "too-large") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          description={withSize(name, size)}
          title={preview.status === "unsupported" ? "该类型不支持预览" : "文件过大，无法预览"}
        />
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <p
        className="rounded-lg bg-(--wb-status-error-soft-bg) px-2.5 py-2 text-[12px] text-(--wb-status-error-text)"
        role="alert"
      >
        {preview.message}
      </p>
    );
  }
  if (preview.status === "archive") {
    return (
      <LoadedPreview
        content=""
        id="archive"
        key="archive"
        load={preview.load}
        name={name}
        truncated={false}
      />
    );
  }
  const id = previewerFor(name, preview.data);
  return (
    <LoadedPreview
      content={preview.data.kind === "text" ? preview.data.text : preview.data.url}
      id={id}
      // 媒体另带 `reload`：刷新或再点同一行换一个新的挂载，媒体元素与它的失败态随之换新。
      key={preview.data.kind === "media" ? `media:${preview.data.reload}` : id}
      name={name}
      truncated={preview.data.truncated}
    />
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; Previewer: Previewer };

/** Keyed by `id` by the caller, so one mount only ever waits on one previewer. */
function LoadedPreview({
  id,
  name,
  content,
  truncated,
  load,
  web,
  doc,
}: {
  id: PreviewerId;
  name: string;
  content: string;
  truncated: boolean;
  load?: Parameters<Previewer>[0]["load"];
  web?: Parameters<Previewer>[0]["web"];
  doc?: Parameters<Previewer>[0]["doc"];
}) {
  const [loaded, setLoaded] = useState<Loaded>(() => {
    const Previewer = readyPreviewers.get(id);
    return Previewer ? { status: "ready", Previewer } : { status: "loading" };
  });
  const loading = loaded.status === "loading";

  // 只在加载态发起：首帧命中已就绪表时不经这里；「重试」把状态拨回加载态即重新发起。
  useEffect(() => {
    if (!loading) return;
    let cancelled = false;
    acquirePreviewer(id).then(
      (Previewer) => {
        if (!cancelled) setLoaded({ status: "ready", Previewer });
      },
      () => {
        if (!cancelled) setLoaded({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, loading]);

  if (loaded.status === "ready") {
    return (
      <loaded.Previewer
        content={content}
        doc={doc}
        load={load}
        name={name}
        truncated={truncated}
        web={web}
      />
    );
  }
  if (loading) {
    return (
      <p className={`${STATUS_TEXT} px-4 pt-3`} role="status">
        正在加载预览…
      </p>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3">
      <p className={`${ALERT_BOX} text-[12px]`} role="alert">
        预览组件加载失败
      </p>
      <Button
        onClick={() => setLoaded({ status: "loading" })}
        size="sm"
        type="button"
        variant="secondary"
      >
        重试
      </Button>
    </div>
  );
}
