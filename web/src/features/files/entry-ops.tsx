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
 * 移动到… sends `move` with `from` = the path of the row whose menu was used and `to` = the chosen
 * target directory joined with that row's own name (`workspacePath`; the root target gives the bare
 * name). The targets offered are `moveTargets` of the browser's loaded listings and expanded set,
 * taken once when the dialog opens; nothing typed by the user enters `to`, and nothing here trims,
 * normalises or re-encodes either path. Whether the move is allowed is the server's decision.
 *
 * 删除 sends `DELETE entries?path=` with the path of the row whose menu was used, as the menu gave
 * it: not the selection, not the address, and nothing here trims, normalises or re-encodes it
 * (`deleteEntry` encodes it once, whole). Whether that path may be deleted is the server's decision.
 */
import { type RefObject, useCallback, useMemo, useRef } from "react";
import { type ApiClient, downloadUrl } from "../../lib/api.js";
import { type DirectoryCache, moveTargets, renameTarget, workspacePath } from "./browser-paths.js";
import { DeleteEntryDialog, MoveDialog, RenameDialog } from "./dialogs.js";
import { useRequestDialog } from "./request-dialog.js";

/** 行菜单所属的条目。 */
type EntryTarget = { name: string; path: string; type: "dir" | "file" };

/** 行菜单调用的操作；`trigger` 是该行的 `更多操作 <名>`，取消类关闭后焦点还给它。 */
export type EntryActions = {
  /** 文件行 `下载` 一项的地址。 */
  downloadHref(path: string): string;
  rename(target: EntryTarget, trigger: HTMLElement | null): void;
  moveTo(target: EntryTarget, trigger: HTMLElement | null): void;
  remove(target: EntryTarget, trigger: HTMLElement | null): void;
};

type Operation = "move" | "remove" | "rename";

/** 浏览器此刻的树：`移动到…` 打开时由它取目标目录；`name` 是空间名，根项的文字用。 */
type BrowserTree = {
  cacheRef: RefObject<DirectoryCache>;
  expandedPathsRef: RefObject<ReadonlySet<string>>;
  name: string;
};

/**
 * 成功后该拿到焦点的那一行（它的 `更多操作 <名>`）的路径；那一行挂上时取走并清空。用引用而不是状态：
 * 新行与写入它的那次更新在同一次提交里挂上，不需要再渲染一遍。
 */
export type MenuFocus = RefObject<string | null>;

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
  { cacheRef, expandedPathsRef, name: workspaceName }: BrowserTree,
) {
  // `targets`：`移动到…` 可选的目标目录，打开那一刻取定，此后树怎么变都不改；别的操作是空数组。
  const { close, dialog, open, returnFocus, submit } = useRequestDialog<
    EntryTarget & { op: Operation; targets: readonly string[] }
  >();
  const focusMenuPath: MenuFocus = useRef(null);
  // 打开确认框那一刻该行的父目录行按钮：删除成功后焦点给它（被删的行连同它的按钮已卸载）。
  const parentRow = useRef<HTMLElement | null>(null);
  const actions = useMemo<EntryActions>(() => {
    const opener = (op: Operation) => (target: EntryTarget, trigger: HTMLElement | null) => {
      focusMenuPath.current = null;
      parentRow.current = parentRowOf(trigger);
      const targets =
        op === "move" ? moveTargets(cacheRef.current, expandedPathsRef.current, target.path) : [];
      open({ ...target, op, targets }, trigger);
    };
    return {
      downloadHref: (path) => downloadUrl(workspaceId, path),
      moveTo: opener("move"),
      remove: opener("remove"),
      rename: opener("rename"),
    };
  }, [cacheRef, expandedPathsRef, open, workspaceId]);

  /** 重命名与移动共用的那一次 `POST move`；成功后焦点给新路径那一行的 `更多操作 <名>`。 */
  const move = useCallback(
    (from: string, to: string, conflictText: string) => {
      submit(
        (signal) => client.moveEntry(workspaceId, { from, to }, { signal }),
        () => {
          focusMenuPath.current = to;
          onMoved(from, to);
        },
        conflictText,
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

  function renderDialog() {
    if (!dialog) {
      return null;
    }

    const { name, op, path, targets, type } = dialog.subject;
    const shared = { error: dialog.error, onCancel: close, pending: dialog.pending, returnFocus };
    if (op === "remove") {
      return (
        <DeleteEntryDialog
          {...shared}
          key={dialog.id}
          name={name}
          onConfirm={() => remove(path)}
          type={type}
        />
      );
    }
    if (op === "move") {
      return (
        <MoveDialog
          {...shared}
          key={dialog.id}
          // `to`：选中的目标目录接上这一行自己的名字，原样拼接；目标是根（`""`）时就是名字本身。
          onMove={(target) => move(path, workspacePath(target, name), "目标位置已存在同名条目")}
          targets={targets}
          workspaceName={workspaceName}
        />
      );
    }
    return (
      <RenameDialog
        {...shared}
        key={dialog.id}
        name={name}
        onRename={(typed) => move(path, renameTarget(path, typed), "该目录下已存在同名条目")}
      />
    );
  }

  return { actions, focusMenuPath, dialog: renderDialog() };
}
