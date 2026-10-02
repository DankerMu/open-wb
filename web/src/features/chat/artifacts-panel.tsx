/* Artifacts panel adapted from resource/workbuddy-live-demo.html:2033-2046 (openArtifactsPanel), issue 537: the rows are the file-change rows of the whole session and a previewable path carries the action of its artifact card instead of the demo's static panels. */
import { type ReactNode, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { Button, Drawer, useToast } from "../../ui/index.js";
import { ArtifactAction } from "./artifact-card.js";
import { FileChangeRow, useChangeSpace } from "./file-changes-card.js";
import type { ChatState } from "./stream.js";
import { artifactKind, summarizeChanges } from "./stream-artifacts.js";
import type { Workspace } from "./workspace-list.js";

/**
 * The changes of every ended step of `view`, one per path: `view.messages` is in message order and
 * each `steps` in ordinal order, so the summary's "last step wins, first place kept" is "the later
 * message, then the larger ordinal, wins".
 */
function sessionChanges(view: ChatState) {
  return summarizeChanges(view.messages.flatMap((message) => message.steps));
}

/**
 * The drawer's list: one file-change row per change; while the workspace is resolved, a path that
 * derives an artifact carries that artifact's action after 查看详情.
 */
function ArtifactsList({
  changes,
  client,
  workspace,
}: {
  changes: ReturnType<typeof sessionChanges>;
  client: ApiClient;
  workspace: Workspace | null;
}) {
  const space = useChangeSpace(workspace);
  return (
    <div className="artifacts-panel-list">
      {changes.map((change) => {
        const artifact = artifactKind(change.path);
        return (
          <FileChangeRow change={change} key={change.path} space={space}>
            {space !== null && artifact !== null ? (
              <ArtifactAction
                artifact={artifact}
                client={client}
                path={change.path}
                workspaceId={space.id}
              />
            ) : null}
          </FileChangeRow>
        );
      })}
    </div>
  );
}

/**
 * The 产物面板 drawer of the session page. `view` is the current chat view, `null` while there is
 * none (history loading or failed, another session or account being read); `workspace` is the
 * session's workspace resolved in the workspace list. `open(trigger)` only toasts while the view
 * holds no change of an ended step; otherwise it focuses `trigger` first, because the drawer hands
 * focus back to the element that was active when it opened and a click does not always focus the
 * button. The list is derived from `view` on every render while the drawer is open, never stored,
 * and the drawer closes with the view it was opened on.
 */
export function useArtifactsPanel(
  client: ApiClient,
  view: ChatState | null,
  workspace: Workspace | undefined,
): { open(trigger: HTMLElement): void; panel: ReactNode } {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (open && view === null) setOpen(false);
  return {
    open(trigger) {
      if (view === null || sessionChanges(view).length === 0) {
        toast.show({ type: "info", message: "当前任务暂无产物" });
        return;
      }
      trigger.focus();
      setOpen(true);
    },
    panel: (
      <Drawer
        footer={
          <Button onClick={() => setOpen(false)} variant="ghost">
            关闭
          </Button>
        }
        onOpenChange={setOpen}
        open={open}
        side="right"
        title="产物面板"
        width={420}
      >
        {open && view !== null ? (
          <ArtifactsList
            changes={sessionChanges(view)}
            client={client}
            workspace={workspace ?? null}
          />
        ) : null}
      </Drawer>
    ),
  };
}
