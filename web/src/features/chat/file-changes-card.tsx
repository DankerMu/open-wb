/* File-change card adapted from resource/workbuddy-live-demo.html:2468-2476 (fileChangesHTML) and :519-526 (its frame): the head has no icon, each row shows the logical path `<account>/<dir>/<path>` (never the workspace root) and 查看详情 opens that workspace in /files. Built from the copied-layer Button and Tailwind classes; the row carries its own classes, so the 产物面板 list reuses it as is; it wraps, so a row of that list can put the failure of its action on a line under its controls. */
import { type ReactNode, useId } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Icon } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/file-meta.js";
import { summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { Workspace } from "./workspace-list.js";

type FileChange = ReturnType<typeof summarizeChanges>[number];
type ChangeSpace = { id: string; prefix: string };

const COUNT = "font-mono text-[11px]";

/**
 * The workspace a row links to and the logical prefix `<account>/<dir>/` of its paths; `null` while
 * `workspace` is (see `FileChangesCard`) or no account is signed in.
 */
export function useChangeSpace(workspace: Workspace | null): ChangeSpace | null {
  const account = useAuth().principal?.account;
  return workspace !== null && account !== undefined
    ? { id: workspace.id, prefix: `${logicalPath(account, workspace.dir)}/` }
    : null;
}

/**
 * One change: its counts or 写入, its path and, when `space` is resolved, 查看详情 followed by
 * `children`. Without `space` the path is workspace-relative and there is no 查看详情.
 */
export function FileChangeRow({
  change,
  space,
  children,
}: {
  change: FileChange;
  space: ChangeSpace | null;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const path = `${space?.prefix ?? ""}${change.path}`;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-(--wb-border-default) px-3 py-[7px] text-[12.5px] last:border-b-0"
      data-slot="file-change-row"
    >
      {change.kind === "edit" && change.added > 0 ? (
        <span className={`${COUNT} text-(--wb-status-success-text)`} data-slot="file-change-add">
          {`+${change.added}`}
        </span>
      ) : null}
      {change.kind === "edit" && change.removed > 0 ? (
        <span className={`${COUNT} text-(--wb-status-error-text)`} data-slot="file-change-del">
          {`-${change.removed}`}
        </span>
      ) : null}
      {change.kind === "write" ? (
        <span className="text-[11px] text-(--wb-text-secondary)" data-slot="file-change-kind">
          写入
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-mono" data-slot="file-change-path" title={path}>
        {path}
      </span>
      {space === null ? null : (
        <Button
          aria-label={`查看详情 ${path}`}
          className="size-[26px] rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-(--wb-text-secondary) dark:hover:bg-accent"
          onClick={() => void navigate(`/files?ws=${space.id}`)}
          size="icon-xs"
          title={`查看详情 ${path}`}
          type="button"
          variant="ghost"
        >
          <Icon name="chevron-right" size={12} />
        </Button>
      )}
      {children}
    </div>
  );
}

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
  const space = useChangeSpace(workspace);
  const headId = useId();
  const changes = summarizeChanges(steps);
  if (changes.length === 0) {
    return null;
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset 的禁用语义与默认边框都用不上，这里只要分组。
    <div
      aria-labelledby={headId}
      className="min-w-0 overflow-hidden rounded-xl border border-(--wb-border-default) bg-(--wb-bg-secondary)"
      data-slot="file-changes-card"
      role="group"
    >
      <div
        className="border-b border-(--wb-border-default) px-3 py-[9px] text-[13px] font-semibold"
        data-slot="file-changes-head"
        id={headId}
      >
        {`文件变更（${changes.length} 个）`}
      </div>
      {changes.map((change) => (
        <FileChangeRow change={change} key={change.path} space={space} />
      ))}
    </div>
  );
}
