/* Artifacts panel adapted from resource/workbuddy-live-demo.html:2033-2046 (openArtifactsPanel), issue 537: the rows are the file-change rows of the whole session and a previewable path carries the action of its artifact card instead of the demo's static panels. Built from the copied-layer Sheet and Button and Tailwind classes; nothing is reported as a toast (design D8). */
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ApiClient } from "../../lib/api.js";
import { useEscapeFallback } from "../../ui/index.js";
import { ArtifactRowAction } from "./artifact-card.js";
import { FileChangeRow, useChangeSpace } from "./file-changes-card.js";
import type { ChatState } from "./stream.js";
import { artifactKind, summarizeChanges } from "./stream-artifacts.js";
import type { SessionSpace } from "./workspace-list.js";

type SessionChanges = ReturnType<typeof summarizeChanges>;

const NO_CHANGES: SessionChanges = [];

/**
 * The changes of every ended step of `view`, one per path: `view.messages` is in message order and
 * each `steps` in ordinal order, so the summary's "last step wins, first place kept" is "the later
 * message, then the larger ordinal, wins".
 */
function sessionChanges(view: ChatState): SessionChanges {
  return summarizeChanges(view.messages.flatMap((message) => message.steps));
}

/**
 * The panel's body: the empty state while there is no change, otherwise one file-change row per
 * change; while the workspace is resolved, a path that derives an artifact carries that artifact's
 * action after 查看详情 (a temporary workspace is resolved, yet its rows have no 查看详情).
 */
function ArtifactsList({
  changes,
  client,
  space: resolved,
}: {
  changes: SessionChanges;
  client: ApiClient;
  space: SessionSpace | null;
}) {
  const space = useChangeSpace(resolved);
  if (changes.length === 0) {
    return (
      <p
        className="m-0 py-8 text-center text-[13px] text-(--wb-text-secondary)"
        data-slot="artifacts-panel-empty"
      >
        当前任务暂无产物
      </p>
    );
  }
  return (
    <div
      className="min-w-0 overflow-hidden rounded-xl border border-(--wb-border-default) bg-(--wb-bg-secondary)"
      data-slot="artifacts-panel-list"
    >
      {changes.map((change) => {
        const artifact = artifactKind(change.path);
        return (
          <FileChangeRow change={change} key={change.path} space={space}>
            {resolved !== null && artifact !== null ? (
              <ArtifactRowAction
                artifact={artifact}
                client={client}
                path={change.path}
                workspaceId={resolved.id}
              />
            ) : null}
          </FileChangeRow>
        );
      })}
    </div>
  );
}

/**
 * The 产物面板 sheet of the session page. `view` is the current chat view, `null` while there is
 * none (history loading or failed, another session or account being read); `space` is the
 * session's resolved workspace (`resolveSessionSpace`); `sessionId` is the selected session.
 * `open(trigger)` always opens the panel: with no change of an ended step in the view, or no view
 * yet, it shows the empty state. The body is derived from `view` on every render while the panel
 * is open, never stored, so the empty state turns into the list with the first change. The panel
 * closes with the session it was opened for (another one selected, also before any view arrived)
 * and with the view it has shown: once it showed one, the view becoming `null` closes it (another
 * account, or the same session read again). Its body is unmounted the moment it closes, not after
 * the sheet's exit animation, which aborts the pending request of a row.
 *
 * The sheet has no trigger element, so closing would leave focus on `body`: it goes back to
 * `trigger` while that button is still in the document. Escape is also handled on the content
 * itself, because a toast on screen (the session list's) takes the Escape of every Radix layer
 * below it.
 */
export function useArtifactsPanel(
  client: ApiClient,
  view: ChatState | null,
  space: SessionSpace | null,
  sessionId: string | undefined,
): { open(trigger: HTMLElement): void; panel: ReactNode } {
  /** Open for `sessionId`; `shown` once a view of it was shown. `null` while closed. */
  const [opened, setOpened] = useState<{ sessionId: string | undefined; shown: boolean } | null>(
    null,
  );
  const opener = useRef<HTMLElement | null>(null);
  if (opened !== null) {
    if (opened.sessionId !== sessionId || (opened.shown && view === null)) setOpened(null);
    else if (!opened.shown && view !== null) setOpened({ sessionId, shown: true });
  }
  const open = opened !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) setOpened(null);
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return {
    open(trigger) {
      opener.current = trigger;
      setOpened({ sessionId, shown: view !== null });
    },
    panel: (
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent
          aria-describedby={undefined}
          aria-modal="true"
          className="gap-0 data-[side=right]:w-[420px] data-[side=right]:max-w-[92vw] data-[side=right]:sm:max-w-[92vw]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={fallback.onEscapeKeyDown}
          onKeyDown={fallback.onKeyDown}
          ref={fallback.ref}
        >
          <SheetHeader className="border-b border-(--wb-border-default) pr-12">
            <SheetTitle>产物面板</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-slot="artifacts-panel-body">
            {open ? (
              <ArtifactsList
                changes={view === null ? NO_CHANGES : sessionChanges(view)}
                client={client}
                space={space}
              />
            ) : null}
          </div>
          <SheetFooter className="flex-row justify-end">
            <Button onClick={() => setOpened(null)} type="button" variant="ghost">
              关闭
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    ),
  };
}
