/* File-change card adapted from resource/workbuddy-live-demo.html:2468-2476 (fileChangesHTML) and :519-526 (its frame): the head has no icon, each row shows the logical path `<account>/<dir>/<path>` (never the workspace root) and 查看详情 opens the workspace sidebar of the session page on that file, without navigating. Built from the copied-layer Button and Tailwind classes; each row carries its own classes. */
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/index.js";
import { summarizeChanges } from "./stream-artifacts.js";
import type { ChatStepView } from "./stream-steps.js";
import type { SessionSpace } from "./workspace-list.js";

type FileChange = ReturnType<typeof summarizeChanges>[number];
/** 查看详情 of one row: `path` is workspace-relative, `trigger` the button that was clicked. */
type Reveal = (path: string, trigger: HTMLElement) => void;
type ChangeSource = {
  /** Absent while the session has no workspace (`workspaceId` null or not known yet): no 查看详情. */
  onReveal: Reveal | undefined;
  space: SessionSpace | null;
  steps: readonly ChatStepView[];
};

const COUNT = "font-mono text-[11px]";

/**
 * The logical prefix `<account>/<dir>/` of a row's path; empty while `space` is `null`, while its
 * workspace is in no list (a temporary one, an unlisted one, or the list is loading or failed) or
 * no account is signed in: the row then shows the workspace-relative path.
 */
function useChangePrefix(space: SessionSpace | null): string {
  const account = useAuth().principal?.account;
  const workspace = space?.workspace ?? null;
  return workspace !== null && account !== undefined
    ? `${logicalPath(account, workspace.dir)}/`
    : "";
}

/**
 * One change: its counts or 写入, its shown path (`prefix` + the relative one) and, with `onReveal`,
 * 查看详情 named after the shown path. `onReveal` gets the workspace-relative path, not the shown one.
 */
function FileChangeRow({
  change,
  onReveal,
  prefix,
}: {
  change: FileChange;
  onReveal: Reveal | undefined;
  prefix: string;
}) {
  const path = `${prefix}${change.path}`;
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
      {onReveal === undefined ? null : (
        <Button
          aria-label={`查看详情 ${path}`}
          className="size-[26px] rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-(--wb-text-secondary) dark:hover:bg-accent"
          onClick={(event) => onReveal(change.path, event.currentTarget)}
          size="icon-xs"
          title={`查看详情 ${path}`}
          type="button"
          variant="ghost"
        >
          <Icon name="chevron-right" size={12} />
        </Button>
      )}
    </div>
  );
}

/**
 * One card per assistant message: the changes of its ended steps, one row per path. `space` is
 * the session's resolved workspace (`resolveSessionSpace`): it only decides the shown path (logical
 * when its workspace is listed, workspace-relative otherwise). 查看详情 depends on `onReveal` alone,
 * which the page hands down whenever the session's `workspaceId` is not null — a temporary
 * workspace, an unlisted one and a failed list read included. Renders nothing while no ended step
 * carries changes.
 */
export function FileChangesCard({ onReveal, space, steps }: ChangeSource) {
  const prefix = useChangePrefix(space);
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
        <FileChangeRow change={change} key={change.path} onReveal={onReveal} prefix={prefix} />
      ))}
    </div>
  );
}
