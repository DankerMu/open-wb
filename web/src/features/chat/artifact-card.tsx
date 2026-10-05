/* Artifact cards adapted from resource/workbuddy-live-demo.html:2419-2466 (artifactHTML) and :502-515 (their frame), issue 536: the card never embeds the file (no iframe, image or code body) and has no 在编辑器中打开; the content is fetched through the preview API only when its action is clicked. The html action uses chevron-right (the demo's externalLink is not registered). Built from the copied-layer Button and Dialog and Tailwind classes; outcomes are shown in the card, never as a toast (design D8). */
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ApiClient } from "../../lib/api.js";
import { Icon, type IconName, useEscapeFallback } from "../../ui/index.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { artifactKind, summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { Workspace } from "./workspace-list.js";

type Artifact = NonNullable<ReturnType<typeof artifactKind>>;
type FilePreview = Awaited<ReturnType<ApiClient["fetchPreview"]>>;
type HtmlPreview = { text: string; truncated: boolean };
/** How an action ended, when there is something to tell: the code was copied, or it failed. */
type ArtifactOutcome = { kind: "copied" } | { kind: "failed"; message: string };

const COPIED_MS = 2000;

const TRAITS: Record<
  Artifact["kind"],
  { action: string; actionIcon: IconName; icon: IconName; tint: string }
> = {
  html: {
    action: "打开网页预览",
    actionIcon: "chevron-right",
    icon: "globe",
    tint: "bg-(--wb-status-warning-soft-bg) text-(--wb-status-warning-text)",
  },
  image: {
    action: "下载",
    actionIcon: "download",
    icon: "image",
    tint: "bg-(--wb-bg-tertiary) text-(--wb-text-secondary)",
  },
  code: {
    action: "复制代码",
    actionIcon: "copy",
    icon: "file-code",
    tint: "bg-(--wb-brand-primary-subtle) text-(--wb-brand-primary)",
  },
};

/** Gives back the Blob URL of a preview that will not be used; a text preview holds none. */
function discard(result: FilePreview) {
  if (result.kind === "image") URL.revokeObjectURL(result.url);
}

type ArtifactActionProps = {
  artifact: Artifact;
  client: ApiClient;
  path: string;
  workspaceId: string;
};

/**
 * The action of one artifact, without markup: shared by its card and by a 产物面板 row. It owns at
 * most one preview request at a time (`controller`): the request starts on a click, sets `busy`
 * while in flight and is aborted on unmount, after which its late result has no effect except that
 * a Blob URL it brought is revoked. `report` is called with `null` when an action starts and with
 * the outcome when it copied or failed; a download and an opened preview report nothing, an aborted
 * request and a 401 neither. `preview` is the fetched page while the html preview is open,
 * `opener` the button that was clicked last.
 */
export function useArtifactAction(
  { artifact, client, path, workspaceId }: ArtifactActionProps,
  report: (outcome: ArtifactOutcome | null) => void,
) {
  const opener = useRef<HTMLButtonElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<HtmlPreview | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  // A browser moves focus to `body` when the focused button is disabled by `busy`; once the request
  // ended, hand it back to the clicked button unless focus has gone elsewhere (issue 537).
  useEffect(() => {
    if (!busy && document.activeElement === document.body) {
      opener.current?.focus({ preventScroll: true });
    }
  }, [busy]);
  const failed = (message: string) => report({ kind: "failed", message });

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
      failed("文件过大，无法复制");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      report({ kind: "copied" });
    } catch {
      failed("复制失败");
    }
  }

  async function deliver(result: FilePreview) {
    if ((result.kind === "image") !== (artifact.kind === "image")) {
      discard(result);
      failed(errorMessage(undefined));
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
    report(null);
    try {
      const result = await client.fetchPreview(workspaceId, path, { signal: own.signal });
      if (own.signal.aborted) {
        discard(result);
        return;
      }
      await deliver(result);
    } catch (error) {
      if (!own.signal.aborted && !isUnauthorized(error)) {
        failed(errorMessage(error));
      }
    } finally {
      if (!own.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  const traits = TRAITS[artifact.kind];
  return {
    busy,
    icon: traits.actionIcon,
    label: `${traits.action} ${artifact.name}`,
    onAction(event: MouseEvent<HTMLButtonElement>) {
      opener.current = event.currentTarget;
      void run();
    },
    opener,
    preview,
    closePreview: () => setPreview(null),
  };
}

/**
 * The body of the html preview dialog: the fetched page in an iframe that may run scripts and
 * nothing else, under a note when the server cut it. Fetched pages are written for a white canvas:
 * a transparent iframe would put their default dark text on the dark-theme dialog, hence `bg-white`.
 */
export function ArtifactPreview({ name, preview }: { name: string; preview: HtmlPreview | null }) {
  if (preview === null) return null;
  return (
    <div className="min-w-0">
      {preview.truncated ? (
        <p className="m-0 mb-2 text-[12.5px] text-(--wb-text-secondary)">
          文件超过 1 MiB，仅预览前 1 MiB
        </p>
      ) : null}
      <iframe
        className="block h-[60vh] w-full border-0 bg-white"
        sandbox="allow-scripts"
        srcDoc={preview.text}
        title={name}
      />
    </div>
  );
}

/**
 * The html preview of a card, in the copied-layer dialog. That dialog has no trigger element, so
 * closing it would leave focus on `body`: focus goes back to `opener` here, without scrolling the
 * thread to a card that has left the viewport meanwhile. Escape is also handled on the content
 * itself, because a toast on screen takes the Escape of every Radix layer below it.
 *
 * Opening focuses the dialog's 关闭 button. Left to Radix, focus would go to the first tabbable
 * element, and the copied content puts its children before that button: the iframe. Focus inside
 * the sandboxed page means the fetched content holds the keyboard before the user did anything and
 * this document sees no keydown, so Escape would not close the preview. Tab order is then 关闭 →
 * the iframe → 关闭 (the two tabbable elements, wrapping).
 */
function PreviewDialog({
  name,
  onClose,
  opener,
  preview,
}: {
  name: string;
  onClose(): void;
  opener: { readonly current: HTMLButtonElement | null };
  preview: HtmlPreview | null;
}) {
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open={preview !== null}>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="sm:max-w-[520px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          fallback.ref.current
            ?.querySelector<HTMLElement>('[data-slot="dialog-close"]')
            ?.focus({ preventScroll: true });
        }}
        ref={fallback.ref}
      >
        <DialogTitle className="truncate pr-8 font-mono leading-5">{name}</DialogTitle>
        <ArtifactPreview name={name} preview={preview} />
      </DialogContent>
    </Dialog>
  );
}

/** The outcome a card shows: 已复制 lasts about two seconds, a failure until the next action. */
function useOutcome() {
  const [outcome, setOutcome] = useState<ArtifactOutcome | null>(null);
  useEffect(() => {
    if (outcome?.kind !== "copied") return;
    const timer = setTimeout(() => setOutcome(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  return [outcome, setOutcome] as const;
}

/**
 * One card: file icon, name, type label and the action; an html card repeats the action in its
 * foot. A copy swaps the action icon for a check and adds a hidden 已复制 status; a failure is one
 * line under the head, below the action button.
 */
function ArtifactCard(props: ArtifactActionProps) {
  const { artifact } = props;
  const headId = useId();
  const [outcome, setOutcome] = useOutcome();
  const { busy, icon, label, onAction, opener, preview, closePreview } = useArtifactAction(
    props,
    setOutcome,
  );
  const traits = TRAITS[artifact.kind];
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset 的禁用语义与默认边框都用不上，这里只要分组。 */}
      <div
        aria-labelledby={headId}
        className="min-w-0 overflow-hidden rounded-xl border border-(--wb-border-default) bg-(--wb-bg-secondary)"
        data-slot="artifact-card"
        role="group"
      >
        <div className="flex items-center gap-2 px-3 py-[9px]" data-slot="artifact-head">
          <span
            className={`inline-flex size-[22px] flex-none items-center justify-center rounded-md ${traits.tint}`}
            data-kind={artifact.kind}
            data-slot="artifact-icon"
          >
            <Icon name={traits.icon} size={14} />
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold"
            data-slot="artifact-title"
            id={headId}
          >
            {artifact.name}
          </span>
          <span
            className="rounded border border-(--wb-border-default) px-1.5 py-px text-[10.5px] leading-[14px] text-(--wb-text-secondary)"
            data-slot="artifact-label"
          >
            {artifact.label}
          </span>
          <Button
            aria-label={label}
            className="size-[26px] rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-(--wb-text-secondary) dark:hover:bg-accent"
            disabled={busy}
            onClick={onAction}
            size="icon-xs"
            title={label}
            type="button"
            variant="ghost"
          >
            <Icon name={outcome?.kind === "copied" ? "check" : icon} size={12} />
          </Button>
          {outcome?.kind === "copied" ? (
            <span className="sr-only" role="status">
              已复制
            </span>
          ) : null}
        </div>
        {outcome?.kind === "failed" ? (
          <p
            className="m-0 px-3 pb-2 text-right text-xs text-(--wb-status-error-text)"
            data-slot="artifact-error"
            role="alert"
          >
            {outcome.message}
          </p>
        ) : null}
        {artifact.kind === "html" ? (
          <div
            className="flex items-center gap-2 border-t border-(--wb-border-default) px-3 py-2 text-xs text-(--wb-text-secondary)"
            data-slot="artifact-foot"
          >
            <span>可交互预览</span>
            <button
              aria-label={label}
              className="ml-auto cursor-pointer text-xs text-(--wb-brand-primary-deep) hover:underline disabled:cursor-default disabled:text-(--wb-text-tertiary) disabled:no-underline"
              disabled={busy}
              onClick={onAction}
              type="button"
            >
              打开网页预览
            </button>
          </div>
        ) : null}
      </div>
      <PreviewDialog
        name={artifact.name}
        onClose={closePreview}
        opener={opener}
        preview={preview}
      />
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
