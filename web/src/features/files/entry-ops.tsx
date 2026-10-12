/**
 * The operations on one tree entry of `WorkspaceBrowser`, reached from its row menu: what the menu
 * calls (`actions`), the dialog of the operation in progress, and the one request behind it.
 * Nothing here touches the tree: a finished operation is reported through `onMoved`, and the
 * browser makes its listings, expanded set and selection follow.
 *
 * 重命名 sends `move` with `to` = the entry's parent joined with the typed name (`renameTarget`). The
 * name reaches this file already checked by `RenameDialog`; the path it lands in is the server's
 * decision.
 *
 * 删除 sends `DELETE entries?path=` with the path of the row whose menu was used, as the menu gave
 * it: not the selection, not the address, and nothing here trims, normalises or re-encodes it
 * (`deleteEntry` encodes it once, whole). Whether that path may be deleted is the server's decision.
 */
import { type RefObject, useCallback, useMemo, useRef } from "react";
import { type ApiClient, downloadUrl } from "../../lib/api.js";
import { movedPath, renameTarget } from "./browser-paths.js";
import { DeleteEntryDialog, RenameDialog } from "./dialogs.js";
import { useRequestDialog } from "./request-dialog.js";

/** 行菜单所属的条目。 */
type EntryTarget = { name: string; path: string; type: "dir" | "file" };

/** 行菜单调用的操作；`trigger` 是该行的 `更多操作 <名>`，取消类关闭后焦点还给它。 */
export type EntryActions = {
  /** 文件行 `下载` 一项的地址。 */
  downloadHref(path: string): string;
  rename(target: EntryTarget, trigger: HTMLElement | null): void;
  remove(target: EntryTarget, trigger: HTMLElement | null): void;
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

/** `trigger` 所在行的父目录的行按钮（父目录是根时即根行）：行是 `<li>`，子层在它里面的 `<ul>` 里。 */
function parentRowOf(trigger: HTMLElement | null) {
  const parent = trigger?.closest("li")?.parentElement?.closest("li");
  return parent?.querySelector<HTMLElement>(":scope > button") ?? null;
}

export function useEntryOperations(
  client: Pick<ApiClient, "deleteEntry" | "moveEntry">,
  workspaceId: string,
  /** `from` 已被移到 `to`，`to` 为 `null` 即已被删除（服务端已答成功）。 */
  onMoved: (from: string, to: string | null) => void,
) {
  const { close, dialog, open, returnFocus, submit } = useRequestDialog<
    EntryTarget & { op: "remove" | "rename" }
  >();
  const focusMenuPath: MenuFocus = useRef(null);
  // 打开确认框那一刻该行的父目录行按钮：删除成功后焦点给它（被删的行连同它的按钮已卸载）。
  const parentRow = useRef<HTMLElement | null>(null);
  const actions = useMemo<EntryActions>(() => {
    const opener =
      (op: "remove" | "rename") => (target: EntryTarget, trigger: HTMLElement | null) => {
        focusMenuPath.current = null;
        parentRow.current = parentRowOf(trigger);
        open({ ...target, op }, trigger);
      };
    return {
      downloadHref: (path) => downloadUrl(workspaceId, path),
      remove: opener("remove"),
      rename: opener("rename"),
    };
  }, [open, workspaceId]);

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

  // 删除路由不答 409：不给冲突文案，失败一律显示信封 message。
  const remove = useCallback(
    (path: string) => {
      submit(
        (signal) => client.deleteEntry(workspaceId, path, { signal }),
        () => {
          focusMenuPath.current = null;
          returnFocus.current = parentRow.current;
          onMoved(path, null);
        },
      );
    },
    [client, onMoved, returnFocus, submit, workspaceId],
  );

  const subject = dialog?.subject;
  return {
    actions,
    focusMenuPath,
    dialog:
      dialog && subject?.op === "remove" ? (
        <DeleteEntryDialog
          error={dialog.error}
          key={dialog.id}
          name={subject.name}
          onCancel={close}
          onConfirm={() => remove(subject.path)}
          pending={dialog.pending}
          returnFocus={returnFocus}
          type={subject.type}
        />
      ) : dialog && subject ? (
        <RenameDialog
          error={dialog.error}
          key={dialog.id}
          name={subject.name}
          onCancel={close}
          onRename={(name) => rename(subject.path, name)}
          pending={dialog.pending}
          returnFocus={returnFocus}
        />
      ) : null,
  };
}
