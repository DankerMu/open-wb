/* Artifact cards adapted from resource/workbuddy-live-demo.html:2419-2466 (artifactHTML), issue 536: the card never embeds the file (no iframe, image or code body) and has no 在编辑器中打开; the content is fetched through the preview API only when its action is clicked. The html action uses chevron-right (the demo's externalLink is not registered). */
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { Button, Dialog, Icon, type IconName, useToast } from "../../ui/index.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { artifactKind, summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { Workspace } from "./workspace-list.js";

type Artifact = NonNullable<ReturnType<typeof artifactKind>>;
type FilePreview = Awaited<ReturnType<ApiClient["fetchPreview"]>>;

const TRAITS: Record<Artifact["kind"], { action: string; actionIcon: IconName; icon: IconName }> = {
  html: { action: "打开网页预览", actionIcon: "chevron-right", icon: "globe" },
  image: { action: "下载", actionIcon: "download", icon: "image" },
  code: { action: "复制代码", actionIcon: "copy", icon: "file-code" },
};

/** Gives back the Blob URL of a preview that will not be used; a text preview holds none. */
function discard(result: FilePreview) {
  if (result.kind === "image") URL.revokeObjectURL(result.url);
}

/**
 * One card. It owns at most one preview request at a time (`controller`): the request starts on a
 * click, disables every action of the card while in flight and is aborted on unmount, after which
 * its late result has no effect except that a Blob URL it brought is revoked.
 */
function ArtifactCard({
  artifact,
  client,
  path,
  workspaceId,
}: {
  artifact: Artifact;
  client: ApiClient;
  path: string;
  workspaceId: string;
}) {
  const toast = useToast();
  const headId = useId();
  const opener = useRef<HTMLButtonElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  /** Clicks a temporary link; the URL is revoked a task later so the browser can still read it. */
  function download(url: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copy(text: string, truncated: boolean) {
    if (truncated) {
      toast.show({ type: "error", message: "文件过大，无法复制" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ type: "success", message: "已复制到剪贴板" });
    } catch {
      toast.show({ type: "error", message: "复制失败" });
    }
  }

  async function deliver(result: FilePreview) {
    if ((result.kind === "image") !== (artifact.kind === "image")) {
      discard(result);
      toast.show({ type: "error", message: errorMessage(undefined) });
    } else if (result.kind === "image") {
      download(result.url);
    } else if (artifact.kind === "html") {
      setPreview({ text: result.text, truncated: result.truncated });
    } else {
      await copy(result.text, result.truncated);
    }
  }

  async function run() {
    if (controller.current) return;
    const own = new AbortController();
    controller.current = own;
    setBusy(true);
    try {
      const result = await client.fetchPreview(workspaceId, path, { signal: own.signal });
      if (own.signal.aborted) {
        discard(result);
        return;
      }
      await deliver(result);
    } catch (error) {
      if (!own.signal.aborted && !isUnauthorized(error)) {
        toast.show({ type: "error", message: errorMessage(error) });
      }
    } finally {
      if (!own.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  const traits = TRAITS[artifact.kind];
  const label = `${traits.action} ${artifact.name}`;
  const onAction = (event: MouseEvent<HTMLButtonElement>) => {
    opener.current = event.currentTarget;
    void run();
  };
  return (
    <>
      <fieldset aria-labelledby={headId} className="artifact-card">
        <div className="artifact-head">
          <span className={`artifact-file-icon artifact-file-icon--${artifact.kind}`}>
            <Icon name={traits.icon} size={14} />
          </span>
          <span className="artifact-title" id={headId}>
            {artifact.name}
          </span>
          <span className="artifact-lang">{artifact.label}</span>
          <Button
            aria-label={label}
            className="chat-msg-action"
            disabled={busy}
            onClick={onAction}
            size="icon"
            title={label}
            variant="ghost"
          >
            <Icon name={traits.actionIcon} size={12} />
          </Button>
        </div>
        {artifact.kind === "html" ? (
          <div className="artifact-foot">
            <span>可交互预览</span>
            <button
              aria-label={label}
              className="artifact-link"
              disabled={busy}
              onClick={onAction}
              type="button"
            >
              打开网页预览
            </button>
          </div>
        ) : null}
      </fieldset>
      <Dialog
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        open={preview !== null}
        returnFocus={opener}
        size="md"
        title={artifact.name}
      >
        {preview?.truncated ? (
          <p className="artifact-preview-note">文件超过 1 MiB，仅预览前 1 MiB</p>
        ) : null}
        {preview === null ? null : (
          <iframe
            className="artifact-preview-frame"
            sandbox="allow-scripts"
            srcDoc={preview.text}
            title={artifact.name}
          />
        )}
      </Dialog>
    </>
  );
}

/**
 * The artifact cards of one assistant message: one per path of the file-change summary (same rows,
 * same order as the 文件变更 card) whose extension is previewable. `workspace` is the session's
 * workspace resolved in the workspace list; while it is `null` nothing is rendered, because the
 * preview request needs the workspace id. Calls no hook: every hook lives in `ArtifactCard`.
 */
export function ArtifactCards({
  client,
  steps,
  workspace,
}: {
  client: ApiClient;
  steps: readonly ChatStepView[];
  workspace: Workspace | null;
}) {
  if (workspace === null) {
    return null;
  }
  return summarizeChanges(steps).map((change) => {
    const artifact = artifactKind(change.path);
    return artifact === null ? null : (
      <ArtifactCard
        artifact={artifact}
        client={client}
        key={change.path}
        path={change.path}
        workspaceId={workspace.id}
      />
    );
  });
}
