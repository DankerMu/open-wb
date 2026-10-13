/* Artifact cards adapted from resource/workbuddy-live-demo.html:2419-2466 (artifactHTML) and :502-515 (their frame), issue 536: the card never embeds the file (no iframe, image or code body) and has no 在编辑器中打开. Each kind has one action (s1f-files-page 25.2): html opens the workspace sidebar on the page in its rendered view, an image is a link to the download endpoint, code is fetched through the preview API when 复制代码 is clicked and copied. The html action uses chevron-right (the demo's externalLink is not registered). Built from the copied-layer Button and Tailwind classes; the outcome of a copy is shown in the card, never as a toast (design D8). */
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ApiClient, downloadUrl } from "../../lib/api.js";
import { Icon, type IconName } from "../../ui/index.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { artifactKind, summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { SessionSpace } from "./workspace-list.js";

type Artifact = NonNullable<ReturnType<typeof artifactKind>>;
type FilePreview = Awaited<ReturnType<ApiClient["fetchPreview"]>>;
/**
 * 打开网页预览: `path` is workspace-relative, `opener` the button that was clicked; the sidebar
 * selects the file and shows its rendered view (`useWorkspaceSidebar().reveal`).
 */
type Reveal = (path: string, opener: HTMLElement, options: { view: "rendered" }) => void;
/** How a copy ended, when there is something to tell: the code was copied, or it failed. */
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

const ACTION_BUTTON =
  "size-[26px] rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-(--wb-text-secondary) dark:hover:bg-accent";

/**
 * Gives back the Blob URL of a preview that will not be used; a text preview holds none. Only a
 * code card fetches, so the image here is one the server answered for a path with a code extension.
 */
function discard(result: FilePreview) {
  if (result.kind === "image") URL.revokeObjectURL(result.url);
}

type CopySource = { client: ApiClient; path: string; workspaceId: string };

/**
 * 复制代码 of a code card, without markup. It owns at most one preview request at a time
 * (`controller`): the request starts on a click, sets `busy`
 * while in flight and is aborted on unmount, after which its late result has no effect except that
 * a Blob URL it brought is revoked. `report` is called with `null` when the action starts and with
 * the outcome when it copied or failed; an aborted request and a 401 report nothing. `opener` is the
 * button that was clicked last.
 */
function useCopyAction(
  { client, path, workspaceId }: CopySource,
  report: (outcome: ArtifactOutcome | null) => void,
) {
  const opener = useRef<HTMLButtonElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  // A browser moves focus to `body` when the focused button is disabled by `busy`; once the request
  // ended, hand it back to the clicked button unless focus has gone elsewhere (issue 537).
  useEffect(() => {
    if (!busy && document.activeElement === document.body) {
      opener.current?.focus({ preventScroll: true });
    }
  }, [busy]);
  const failed = (message: string) => report({ kind: "failed", message });

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
    if (result.kind === "image") {
      discard(result);
      failed(errorMessage(undefined));
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

  return {
    busy,
    onAction(event: MouseEvent<HTMLButtonElement>) {
      opener.current = event.currentTarget;
      void run();
    },
  };
}

/** The outcome shown in place: 已复制 lasts about two seconds, a failure until the next action. */
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
 * 复制代码: the icon button and, after a copy, the hidden 已复制 status beside it; the icon is a check
 * while that status lasts, and the button is disabled while the file is being fetched.
 */
function CopyAction({
  copied,
  label,
  report,
  source,
}: {
  copied: boolean;
  label: string;
  report: (outcome: ArtifactOutcome | null) => void;
  source: CopySource;
}) {
  const { busy, onAction } = useCopyAction(source, report);
  return (
    <>
      <Button
        aria-label={label}
        className={ACTION_BUTTON}
        disabled={busy}
        onClick={onAction}
        size="icon-xs"
        title={label}
        type="button"
        variant="ghost"
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </Button>
      {copied ? (
        <span className="sr-only" role="status">
          已复制
        </span>
      ) : null}
    </>
  );
}

type ArtifactCardProps = CopySource & { artifact: Artifact; onReveal: Reveal };

/**
 * One card: file icon, name, type label and the action; an html card repeats the action in its
 * foot. The action by kind:
 * - html: both buttons call `onReveal` with the clicked button. Nothing is fetched here and the
 *   buttons are never disabled; what the page looks like, and a file that is gone, show in the
 *   sidebar.
 * - image: a plain link to the download endpoint with `download` — the browser saves the file
 *   itself (same as the preview head of the files page), so the card learns nothing of the outcome.
 * - code: `CopyAction`. A copy swaps its icon for a check and adds a hidden 已复制 status; a
 *   failure is one line under the head, below the action button.
 */
function ArtifactCard({ artifact, onReveal, ...source }: ArtifactCardProps) {
  const headId = useId();
  const [outcome, setOutcome] = useOutcome();
  const traits = TRAITS[artifact.kind];
  const label = `${traits.action} ${artifact.name}`;
  const openPreview = (event: MouseEvent<HTMLButtonElement>) =>
    onReveal(source.path, event.currentTarget, { view: "rendered" });
  const glyph = <Icon name={traits.actionIcon} size={12} />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset 的禁用语义与默认边框都用不上，这里只要分组。
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
        {artifact.kind === "code" ? (
          <CopyAction
            copied={outcome?.kind === "copied"}
            label={label}
            report={setOutcome}
            source={source}
          />
        ) : artifact.kind === "image" ? (
          <Button asChild className={ACTION_BUTTON} size="icon-xs" variant="ghost">
            <a
              aria-label={label}
              download
              href={downloadUrl(source.workspaceId, source.path)}
              title={label}
            >
              {glyph}
            </a>
          </Button>
        ) : (
          <Button
            aria-label={label}
            className={ACTION_BUTTON}
            onClick={openPreview}
            size="icon-xs"
            title={label}
            type="button"
            variant="ghost"
          >
            {glyph}
          </Button>
        )}
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
            className="ml-auto cursor-pointer text-xs text-(--wb-brand-primary-deep) hover:underline"
            onClick={openPreview}
            type="button"
          >
            打开网页预览
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The artifact cards of one assistant message: one per path of the file-change summary (same rows,
 * same order as the 文件变更 card) whose extension is previewable. `space` is the session's
 * resolved workspace (`resolveSessionSpace`; a temporary one counts); while it is `null` nothing is
 * rendered, because every action needs its id. `onReveal` is absent only while the session has no
 * workspace, which is when `space` is `null` too (both come from the selected session; 读代码推出,
 * no test reaches a `space` without it): nothing is rendered then either. Calls no hook: every hook
 * lives in `ArtifactCard`.
 */
export function ArtifactCards({
  client,
  onReveal,
  space,
  steps,
}: {
  client: ApiClient;
  onReveal: Reveal | undefined;
  space: SessionSpace | null;
  steps: readonly ChatStepView[];
}) {
  if (space === null || onReveal === undefined) {
    return null;
  }
  return summarizeChanges(steps).map((change) => {
    const artifact = artifactKind(change.path);
    return artifact === null ? null : (
      <ArtifactCard
        artifact={artifact}
        client={client}
        key={change.path}
        onReveal={onReveal}
        path={change.path}
        workspaceId={space.id}
      />
    );
  });
}
