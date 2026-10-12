/**
 * The operations on one tree entry of `WorkspaceBrowser`, reached from its row menu: what the menu
 * calls (`actions`), the dialog of the operation in progress, and the one request behind it.
 * Nothing here touches the tree: a finished operation is reported through `onMoved`, and the
 * browser makes its listings, expanded set and selection follow.
 *
 * 重命名 sends `move` with `to` = the entry's parent joined with the typed name (`renameTarget`). The
 * name reaches this file already checked by `RenameDialog`; the path it lands in is the server's
 * decision.
 */
import { type RefObject, useCallback, useMemo, useRef } from "react";
import { type ApiClient, downloadUrl } from "../../lib/api.js";
import { movedPath, renameTarget } from "./browser-paths.js";
import { RenameDialog } from "./dialogs.js";
import { useRequestDialog } from "./request-dialog.js";

/** 行菜单所属的条目。 */
type EntryTarget = { name: string; path: string };

/** 行菜单调用的操作；`trigger` 是该行的 `更多操作 <名>`，取消类关闭后焦点还给它。 */
export type EntryActions = {
  /** 文件行 `下载` 一项的地址。 */
  downloadHref(path: string): string;
  rename(target: EntryTarget, trigger: HTMLElement | null): void;
};

/**
 * 成功后该拿到焦点的那一行（它的 `更多操作 <名>`）的路径；那一行挂上时取走并清空。用引用而不是状态：
 * 新行与写入它的那次更新在同一次提交里挂上，不需要再渲染一遍。
 */
export type MenuFocus = RefObject<string | null>;

/** 放弃 `from` 及其之下在途的目录请求：中止，并从请求表里删去。 */
export function abandonRequests(requests: Map<string, AbortController>, from: string) {
  for (const [path, controller] of [...requests]) {
    if (movedPath(path, from, null) === null) {
      controller.abort();
      requests.delete(path);
    }
  }
}

export function useEntryOperations(
  client: Pick<ApiClient, "moveEntry">,
  workspaceId: string,
  /** `from` 已被移到 `to`（服务端已答成功）。 */
  onMoved: (from: string, to: string) => void,
) {
  const { close, dialog, open, returnFocus, submit } = useRequestDialog<EntryTarget>();
  const focusMenuPath: MenuFocus = useRef(null);
  const actions = useMemo<EntryActions>(
    () => ({ downloadHref: (path) => downloadUrl(workspaceId, path), rename: open }),
    [open, workspaceId],
  );

  const rename = useCallback(
    (from: string, name: string) => {
      const to = renameTarget(from, name);
      submit(
        (signal) => client.moveEntry(workspaceId, { from, to }, { signal }),
        () => {
          focusMenuPath.current = to;
          onMoved(from, to);
        },
        "该目录下已存在同名条目",
      );
    },
    [client, onMoved, submit, workspaceId],
  );

  return {
    actions,
    focusMenuPath,
    dialog: dialog ? (
      <RenameDialog
        error={dialog.error}
        key={dialog.id}
        name={dialog.subject.name}
        onCancel={close}
        onRename={(name) => rename(dialog.subject.path, name)}
        pending={dialog.pending}
        returnFocus={returnFocus}
      />
    ) : null,
  };
}
