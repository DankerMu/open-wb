/* Read-only project config entry of the session header (issue 816, design D4 of issue 773): the files of
   `GET /api/project-config` for the selected session's workspace, a header button that exists only
   while that list is non-empty and the dialog it opens. A list of files present at the locations
   the assistant reads, not of files in effect; no content is read and nothing can be edited.
   Built from the copied-layer Dialog and Tailwind classes (issue 861). */
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ApiClient } from "../../lib/api.js";
import type { ProjectConfigFile } from "../../lib/api-commands.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { useEscapeFallback } from "../../ui/index.js";
import { useClipped } from "./use-clipped.js";

const TITLE = "助手会读取的项目配置文件";
const NOTE = "以下位置存在配置文件；同一层有多个说明文件时只有一个生效";

const KIND_LABELS: Record<ProjectConfigFile["kind"], string> = {
  instructions: "说明",
  system: "系统提示",
  agent: "智能体",
};

/** The list of one selection: the call was made by `client` for this session and workspace id. */
type Held = {
  client: ApiClient;
  sessionId: string;
  workspaceId: string | null;
  files: ProjectConfigFile[];
};

type ConfigGroup = { depth: number; label: string; files: ProjectConfigFile[] };

/** The accessible name of the header button for a list of `count` files. */
function projectConfigLabel(count: number): string {
  return `项目配置 ${count}`;
}

/**
 * `files` grouped by `depth`, the groups in ascending depth and the files of a group in the order
 * received: `当前目录` for depth 0, `上 <n> 级目录` for the directory `n` levels above it.
 */
export function groupByDepth(files: readonly ProjectConfigFile[]): ConfigGroup[] {
  const groups = new Map<number, ConfigGroup>();
  for (const file of files) {
    const group = groups.get(file.depth) ?? {
      depth: file.depth,
      label: file.depth === 0 ? "当前目录" : `上 ${file.depth} 级目录`,
      files: [],
    };
    group.files.push(file);
    groups.set(file.depth, group);
  }
  return [...groups.values()].sort((left, right) => left.depth - right.depth);
}

/**
 * The groups as headed lists; `path` comes from the workspace and is rendered as text only. A long
 * path wraps inside its row and a long list scrolls inside the dialog. While that scroll container
 * clips its content it is keyboard-focusable so the clipped rows can be scrolled to; it is not a
 * control.
 */
function ConfigList({ files }: { files: readonly ProjectConfigFile[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const clipped = useClipped(scrollerRef, [files]);
  return (
    <div
      className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto"
      data-slot="project-config-list"
      ref={scrollerRef}
      tabIndex={clipped ? 0 : undefined}
    >
      {groupByDepth(files).map((group) => (
        <section aria-label={group.label} key={group.depth}>
          <h3 className="m-0 mb-1 text-[11px] font-medium text-(--wb-text-secondary)">
            {group.label}
          </h3>
          {/* biome-ignore lint/a11y/noRedundantRoles: list-none drops the list semantics in Safari; the explicit role restores them. */}
          <ul className="m-0 flex list-none flex-col gap-1 p-0" role="list">
            {group.files.map((file) => (
              <li
                className="flex items-center gap-2 rounded-lg border border-(--wb-border-default) px-2 py-1.5"
                key={file.path}
              >
                <span
                  className="min-w-0 flex-1 font-mono text-xs leading-[18px] wrap-anywhere text-(--wb-text-primary)"
                  data-slot="project-config-path"
                >
                  {file.path}
                </span>
                <span
                  className="flex-none rounded border border-(--wb-border-default) px-1.5 py-px text-[10.5px] leading-[14px] text-(--wb-text-secondary)"
                  data-slot="project-config-kind"
                >
                  {KIND_LABELS[file.kind]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The read-only list in the copied-layer dialog; its only control is the dialog's own 关闭, which
 * holds the focus from the moment it opens.
 *
 * That dialog has no trigger element, so closing it would leave focus on `body`: focus goes back
 * to `opener` (the header button) while it is still in the document, without scrolling. Escape is
 * also handled on the content itself, because a toast on screen (the session list's) takes the
 * Escape of every Radix layer below it.
 */
function ConfigDialog({
  files,
  onClose,
  open,
  opener,
}: {
  files: readonly ProjectConfigFile[];
  onClose(): void;
  open: boolean;
  opener: { readonly current: HTMLElement | null };
}) {
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-modal="true"
        className="sm:max-w-[400px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
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
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{TITLE}</DialogTitle>
          <DialogDescription>{NOTE}</DialogDescription>
        </DialogHeader>
        <ConfigList files={files} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The project config entry of the session page. `selected` is the session the top bar shows,
 * undefined in the welcome state and while a requested session is not resolved: nothing is asked
 * then. One `listProjectConfig(workspaceId)` call is issued per client, session id and workspace
 * id, and each such call is one selection: selecting a session again is a new selection. When the
 * selection changes its call is aborted and the list held and the open dialog are dropped, so
 * nothing answered before the current selection can render, whatever the new call does. `slot` is
 * the top-bar slot, present only once the current selection's own call answered a non-empty list:
 * a pending call, a failed one (silent, no retry until the selection changes) and an empty list
 * yield no button. `dialog` is the read-only list, closed with its selection and closed when its
 * session is selected again; closing hands the focus back to the header button.
 */
export function useProjectConfig(
  client: ApiClient,
  selected: ChatSession | undefined,
): {
  slot: { label: string; expanded: boolean; onSelect(trigger: HTMLElement): void } | undefined;
  dialog: ReactNode;
} {
  const sessionId = selected?.id;
  const workspaceId = selected?.workspaceId ?? null;
  const [held, setHeld] = useState<Held | null>(null);
  /** The answer whose dialog is open: dropped with it when the selection changes. */
  const [opened, setOpened] = useState<Held | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (sessionId === undefined) return;
    const controller = new AbortController();
    void client.listProjectConfig(workspaceId, { signal: controller.signal }).then(
      (files) => {
        if (!controller.signal.aborted) setHeld({ client, sessionId, workspaceId, files });
      },
      () => undefined,
    );
    return () => {
      controller.abort();
      setHeld(null);
      setOpened(null);
    };
  }, [client, sessionId, workspaceId]);

  // The comparisons cover the one render between a change of the selection and the cleanup above.
  if (
    held === null ||
    held.client !== client ||
    held.sessionId !== sessionId ||
    held.workspaceId !== workspaceId ||
    held.files.length === 0
  ) {
    return { slot: undefined, dialog: null };
  }
  const { files } = held;

  const open = opened === held;
  return {
    slot: {
      label: projectConfigLabel(files.length),
      expanded: open,
      onSelect(button) {
        trigger.current = button;
        setOpened(held);
      },
    },
    dialog: (
      <ConfigDialog files={files} onClose={() => setOpened(null)} open={open} opener={trigger} />
    ),
  };
}
