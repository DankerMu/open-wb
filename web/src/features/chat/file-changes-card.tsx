/* File-change card adapted from resource/workbuddy-live-demo.html:2468-2476 (fileChangesHTML): the head has no icon, each row shows the logical path `<account>/<dir>/<path>` (never the workspace root) and 查看详情 opens that workspace in /files. */
import { useId } from "react";
import { useNavigate } from "react-router";
import { Button, Icon } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/file-meta.js";
import { summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { Workspace } from "./workspace-list.js";

/**
 * One card per assistant message: the changes of its ended steps, one row per path. `workspace` is
 * the session's workspace resolved in the workspace list, `null` while that list is loading, after
 * it failed, or when the session is unbound or bound to an unlisted workspace; rows then show the
 * workspace-relative path and no 查看详情. Renders nothing while no ended step carries changes.
 */
export function FileChangesCard({
  steps,
  workspace,
}: {
  steps: readonly ChatStepView[];
  workspace: Workspace | null;
}) {
  const account = useAuth().principal?.account;
  const navigate = useNavigate();
  const headId = useId();
  const changes = summarizeChanges(steps);
  if (changes.length === 0) {
    return null;
  }
  const space =
    workspace !== null && account !== undefined
      ? { id: workspace.id, prefix: `${logicalPath(account, workspace.dir)}/` }
      : null;
  return (
    <fieldset aria-labelledby={headId} className="file-changes-card">
      <div className="file-changes-head" id={headId}>
        {`文件变更（${changes.length} 个）`}
      </div>
      {changes.map((change) => {
        const path = `${space?.prefix ?? ""}${change.path}`;
        return (
          <div className="file-change-row" key={change.path}>
            {change.kind === "edit" && change.added > 0 ? (
              <span className="file-change-add">{`+${change.added}`}</span>
            ) : null}
            {change.kind === "edit" && change.removed > 0 ? (
              <span className="file-change-del">{`-${change.removed}`}</span>
            ) : null}
            {change.kind === "write" ? <span className="file-change-kind">写入</span> : null}
            <span className="file-change-path" title={path}>
              {path}
            </span>
            {space === null ? null : (
              <Button
                aria-label={`查看详情 ${path}`}
                className="chat-msg-action"
                onClick={() => void navigate(`/files?ws=${space.id}`)}
                size="icon"
                title={`查看详情 ${path}`}
                variant="ghost"
              >
                <Icon name="chevron-right" size={12} />
              </Button>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
