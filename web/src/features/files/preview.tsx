/**
 * File preview shell: header, truncation line, unsupported and error states render here,
 * synchronously. The body of a successful preview comes from a previewer module under
 * `previewers/`, loaded on first use through `previewers/index.ts` (the app's only code split);
 * this module owns the cache of loaded previewers.
 * Blob URLs are caller-owned; this module never allocates or revokes them.
 * Markdown mode is keyed by `path`; callers must remount across workspaces
 * if the same relative path can name different files.
 * The `data-slot` names are the stable hooks tests and the UI walk select by.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiClient } from "../../lib/api.js";
import { Icon } from "../../ui/index.js";
import { ALERT_BOX, STATUS_TEXT } from "./columns.js";
import { EmptyState } from "./empty-state.js";
import { fileIcon, formatMtime, formatSize } from "./file-meta.js";
import {
  loadPreviewer,
  type Previewer,
  type PreviewerId,
  previewKind,
  textView,
} from "./previewers/index.js";

type FilePreviewSuccess = Awaited<ReturnType<ApiClient["fetchPreview"]>>;

type PreviewState =
  | { status: "success"; data: FilePreviewSuccess }
  | { status: "error"; message: string }
  | { status: "unsupported" };

type PreviewPaneProps = {
  path: string;
  name: string;
  size: number;
  mtime: number;
  preview: PreviewState;
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
  if (previewKind(name) !== "text") return "code";
  const view = textView(name);
  return view === "markdown" || view === "table" ? view : "code";
}

export function PreviewPane({ path, name, size, mtime, preview }: PreviewPaneProps) {
  const truncatedSize =
    preview.status === "success" && preview.data.truncated ? preview.data.size : null;
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
        <p
          className="ml-auto shrink text-[0.7rem] text-(--wb-text-tertiary) [overflow-wrap:anywhere] narrow:ml-0"
          data-slot="preview-meta"
        >{`${formatSize(size)} · ${formatMtime(mtime)}`}</p>
      </header>
      {truncatedSize === null ? null : (
        <p className="px-4 pt-[0.65rem] text-[13px] text-muted-foreground">{`预览已截断（原始大小 ${truncatedSize} B）`}</p>
      )}
      <PreviewBody key={path} name={name} preview={preview} size={size} />
    </article>
  );
}

function PreviewBody({
  name,
  preview,
  size,
}: {
  name: string;
  preview: PreviewState;
  size: number;
}) {
  if (preview.status === "unsupported") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          description={`${name} · ${formatSize(size)}\u3000二进制或未识别格式`}
          title="该类型不支持预览"
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
  const id = previewerFor(name, preview.data);
  return (
    <LoadedPreview
      content={preview.data.kind === "image" ? preview.data.url : preview.data.text}
      id={id}
      key={id}
      name={name}
    />
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; Previewer: Previewer };

/** Keyed by `id` by the caller, so one mount only ever waits on one previewer. */
function LoadedPreview({ id, name, content }: { id: PreviewerId; name: string; content: string }) {
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
    return <loaded.Previewer content={content} name={name} />;
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
