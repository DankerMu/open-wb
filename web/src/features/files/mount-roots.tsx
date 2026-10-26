/**
 * The mount root rows of `DirectoryTree` and the unmount confirmation (workspace-mounts「挂载根行」,
 * design D18; demo `rootHTML`). They come after the workspace root row, in the order of the list.
 *
 * A row: icon `cloud` (`sftp` / `smb`) or `folder` (`local`), the name, a `只读` tag when read-only,
 * the status dot (its accessible text `在线` / `离线`) and `卸载 <名>`; below it `<host>:<remotePath>`
 * or the source's name. An online row expands like a directory (`展开|折叠 <名>`; `body` is the
 * tree's listing of that path, so the rows inside are ordinary rows). An offline row is not a button:
 * it cannot be expanded, a click on it does nothing, and it shows `离线，重新连接后可浏览` instead of
 * any listing. No row menu, no drag, not a drop target — none of those props reach these rows. The
 * row of a mount the dialog has just created (`takeCreated`, once) expands if it is not expanded and
 * takes focus.
 *
 * The confirmation is `ConfirmDialog` (`dialogs.tsx`, the copy-in `alert-dialog` that 删除 uses too):
 * initial focus on `取消`, `卸载` does not close it — the request's outcome does, and a failure shows
 * its message inside.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "../../components/icon.js";
import type { MountView } from "../../lib/api.js";
import { ConfirmDialog } from "./dialogs.js";
import type { MountRootsState } from "./use-mounts.js";

type MountRootsProps = MountRootsState & {
  expandedPaths: ReadonlySet<string>;
  onToggleDirectory(path: string): void;
  /** The tree's own rendering of what is under an expanded directory `path`. */
  body(path: string): ReactNode;
};

type UnmountDialogProps = NonNullable<MountRootsState["unmount"]>;

const ROW =
  "group/row flex min-w-0 flex-1 items-center gap-[0.4rem] rounded-[6px] px-2 py-[0.32rem] text-left text-[0.8rem] leading-[1.35] text-(--wb-text-primary)";
const GLYPH = "inline-flex size-[14px] shrink-0 text-(--wb-text-secondary)";
const NOTE = "mr-2 ml-7 text-[0.75rem]";

function subline(mount: MountView) {
  if (mount.backend === "local") {
    return mount.sourceName;
  }
  return mount.host === null || mount.remotePath === null
    ? null
    : `${mount.host}:${mount.remotePath}`;
}

function MountRow({
  body,
  expanded,
  mount,
  onToggle,
  onUnmount,
  takeCreated,
}: {
  body: ReactNode;
  expanded: boolean;
  mount: MountView;
  onToggle(): void;
  onUnmount(trigger: HTMLElement): void;
  takeCreated(id: string): boolean;
}) {
  const online = mount.status === "online";
  const toggle = useRef<HTMLButtonElement>(null);
  // Every render asks; only the first one after the dialog's 201 gets a yes (StrictMode included).
  useEffect(() => {
    if (!takeCreated(mount.id)) return;
    if (online && !expanded) onToggle();
    toggle.current?.focus();
  });

  const glyphs = (
    <>
      <span className={GLYPH}>
        <Icon name={mount.backend === "local" ? "folder" : "cloud"} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate" data-slot="tree-name">
        {mount.name}
      </span>
    </>
  );
  const location = subline(mount);

  return (
    <li className="min-w-0" data-slot="mount-root">
      <div className="flex min-w-0 items-center gap-1 pr-1">
        {online ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "折叠" : "展开"} ${mount.name}`}
            className={`${ROW} cursor-pointer hover:bg-(--wb-brand-primary-subtle)`}
            onClick={onToggle}
            ref={toggle}
            title={mount.name}
            type="button"
          >
            <svg
              aria-hidden="true"
              className={`${GLYPH} transition-transform duration-120 ${expanded ? "rotate-0" : "-rotate-90"}`}
              viewBox="0 0 16 16"
            >
              <path d="M4 6l4 5 4-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {glyphs}
          </button>
        ) : (
          <div className={`${ROW} text-(--wb-text-tertiary)`} title={mount.name}>
            <span aria-hidden="true" className="size-[14px] shrink-0" />
            {glyphs}
          </div>
        )}
        {mount.readOnly ? (
          <span className="shrink-0 rounded-[4px] border border-(--wb-border-default) px-1 text-[10px] leading-[15px] text-(--wb-text-secondary)">
            只读
          </span>
        ) : null}
        <span
          className={`size-[7px] shrink-0 rounded-full ${online ? "bg-(--wb-status-success)" : "bg-(--wb-text-tertiary)"}`}
          data-slot="mount-status"
        >
          <span className="sr-only">{online ? "在线" : "离线"}</span>
        </span>
        <Button
          aria-label={`卸载 ${mount.name}`}
          className="text-muted-foreground"
          onClick={(event) => onUnmount(event.currentTarget)}
          size="icon-xs"
          title={`卸载 ${mount.name}`}
          type="button"
          variant="ghost"
        >
          <Icon name="x" size={12} />
        </Button>
      </div>
      {location ? (
        <p
          className={`${NOTE} mb-[0.35rem] truncate font-(family-name:--wb-mono) text-[0.65rem] leading-[1.3] text-(--wb-text-tertiary)`}
          data-slot="tree-root-path"
        >
          {location}
        </p>
      ) : null}
      {online ? (
        expanded ? (
          body
        ) : null
      ) : (
        <p className={`${NOTE} mt-[0.15rem] mb-[0.4rem] text-muted-foreground`}>
          离线，重新连接后可浏览
        </p>
      )}
    </li>
  );
}

export function MountRoots({
  body,
  expandedPaths,
  mounts,
  onToggleDirectory,
  onUnmount,
  takeCreated,
  unmount,
}: MountRootsProps) {
  return (
    <>
      {mounts.map((mount) => (
        <MountRow
          body={expandedPaths.has(mount.name) ? body(mount.name) : null}
          expanded={expandedPaths.has(mount.name)}
          key={mount.id}
          mount={mount}
          onToggle={() => onToggleDirectory(mount.name)}
          onUnmount={(trigger) => onUnmount(mount, trigger)}
          takeCreated={takeCreated}
        />
      ))}
      {unmount ? <UnmountDialog {...unmount} /> : null}
    </>
  );
}

function UnmountDialog({ mount, ...rest }: UnmountDialogProps) {
  return (
    <ConfirmDialog
      {...rest}
      confirmLabel="卸载"
      note="只断开挂载，远端文件不受影响。"
      pendingNote="正在卸载。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。"
      title={`卸载「${mount.name}」？`}
    />
  );
}
