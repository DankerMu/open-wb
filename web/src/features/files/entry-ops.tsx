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
 * target directory joined with that row's own name (`moveDestination`; the root target gives the
 * bare name). The targets offered are `moveTargets` of the browser's loaded listings and expanded
 * set, taken once when the dialog opens; nothing typed by the user enters `to`, and nothing here
 * trims, normalises or re-encodes either path. Whether the move is allowed is the server's decision.
 *
 * A drop (drag and drop on the tree, `moveInto`) sends the same `move`: `from` is the path the tree
 * hands over — the row the drag started on, kept by the tree itself, never read out of the drag's
 * data — and `to` is the row dropped on joined with `from`'s last segment (`moveDestination`).
 * There is no dialog: the request has its own controller here, one at a time, and a failure is the
 * `notice` shown above the tree. `accepts` is what the tree asks while a drag is over a row;
 * `moveInto` decides again by itself before it sends.
 *
 * Both moves stay within the entry's「挂载范围」(`scopeOf`, the browser's mounts): 移动到… lists targets
 * from the root of the mount the entry is in (from the space root outside mounts), and a drop is
 * accepted only on a directory of the same scope. A 409 shows the fixed same-name text only for
 * `code: "conflict"`; other 409s (`mount_boundary`, `mount_offline`) show the envelope message.
 *
 * 删除 sends `DELETE entries?path=` with the path of the row whose menu was used, as the menu gave
 * it: not the selection, not the address, and nothing here trims, normalises or re-encodes it
 * (`deleteEntry` encodes it once, whole). Whether that path may be deleted is the server's decision.
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, downloadUrl } from "../../lib/api.js";
import {
  canMoveInto,
  type DirectoryCache,
  moveDestination,
  moveTargets,
  renameTarget,
} from "./browser-paths.js";
import { DeleteEntryDialog, MoveDialog, RenameDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { isConflict, useRequestDialog } from "./request-dialog.js";

/** 行菜单所属的条目。 */
type EntryTarget = { name: string; path: string; type: "dir" | "file" };

/** 行菜单调用的操作；`trigger` 是该行的 `更多操作 <名>`，取消类关闭后焦点还给它。 */
export type EntryActions = {
  /** 文件行 `下载` 一项的地址。 */
  downloadHref(path: string): string;
  rename(target: EntryTarget, trigger: HTMLElement | null): void;
  moveTo(target: EntryTarget, trigger: HTMLElement | null): void;
  remove(target: EntryTarget, trigger: HTMLElement | null): void;
  /** 拖放经过时问：`from` 这一行此刻能不能放到目录 `directory`（`""` 是根）上；跨挂载范围不能。 */
  accepts(from: string, directory: string): boolean;
  /** 拖放放下：把 `from` 移进 `directory`；此刻不能放（`accepts` 为假）就什么都不做。 */
  moveInto(from: string, directory: string): void;
};

const MOVE_CONFLICT = "目标位置已存在同名条目";

type Operation = "move" | "remove" | "rename";

/**
 * 成功后该拿到焦点的那一行（它的 `更多操作 <名>`）的路径；那一行挂上时取走并清空。用引用而不是状态：
 * 新行与写入它的那次更新在同一次提交里挂上，不需要再渲染一遍。新行要等它那一层重列回来才挂上时（拖放
 * 到没加载过的目录）就留到那时；那一层重列失败由浏览器清掉，每次新操作开始时这里也清掉。
 */
export type MenuFocus = RefObject<string | null>;

/**
 * 浏览器此刻的树：`移动到…` 打开时由它取目标目录；`name` 是空间名，根项的文字用；`focusMenuPath` 由
 * 浏览器持有（它知道哪一层重列失败），这里只写；`scopeOf` 是路径的挂载范围（`useMounts`，挂载外为 `""`）。
 */
type BrowserTree = {
  cacheRef: RefObject<DirectoryCache>;
  expandedPathsRef: RefObject<ReadonlySet<string>>;
  focusMenuPath: MenuFocus;
  name: string;
  scopeOf: (path: string) => string;
};

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
  { cacheRef, expandedPathsRef, focusMenuPath, name: workspaceName, scopeOf }: BrowserTree,
) {
  // 经引用读：`scopeOf` 随列表变，`accepts` 与 `actions` 不随它重建（树的拖放处理器跟着不变），
  // 读到的总是最近一次渲染的那一个。
  const scopeRef = useRef(scopeOf);
  scopeRef.current = scopeOf;
  // `targets`：`移动到…` 可选的目标目录，打开那一刻取定，此后树怎么变都不改；别的操作是空数组。
  const { close, dialog, open, returnFocus, submit } = useRequestDialog<
    EntryTarget & { op: Operation; targets: readonly string[] }
  >();
  // 打开确认框那一刻该行的父目录行按钮：删除成功后焦点给它（被删的行连同它的按钮已卸载）。
  const parentRow = useRef<HTMLElement | null>(null);
  // 拖放的失败文案（树区上方）与它在途的那一次请求；请求没返回之前不接受下一次放下。
  const [notice, setNotice] = useState<string | null>(null);
  const dropRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      dropRequest.current?.abort();
      dropRequest.current = null;
    },
    [],
  );

  const accepts = useCallback(
    (from: string, directory: string) =>
      dropRequest.current === null &&
      canMoveInto(from, directory) &&
      scopeRef.current(from) === scopeRef.current(directory),
    [],
  );

  /**
   * 放下的那一次 `POST move`，没有对话框。发出时撤掉上一次的失败文案；成功后同 `移动到…`：焦点给新
   * 行的 `更多操作 <名>`，树由 `onMoved` 跟过去。失败只写文案（`code` 为 `conflict` 的 409 是固定的那一句，
   * 其余是信封 message，401 不写——登录层接手），不重列。卸载时中止，中止之后到的应答不交付。
   */
  const moveInto = useCallback(
    (from: string, directory: string) => {
      if (!accepts(from, directory)) {
        return;
      }

      const to = moveDestination(from, directory);
      const controller = new AbortController();
      dropRequest.current = controller;
      focusMenuPath.current = null;
      setNotice(null);
      void client
        .moveEntry(workspaceId, { from, to }, { signal: controller.signal })
        .then(
          () => {
            if (!controller.signal.aborted) {
              focusMenuPath.current = to;
              onMoved(from, to);
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted && !isUnauthorized(error)) {
              setNotice(isConflict(error) ? MOVE_CONFLICT : errorMessage(error));
            }
          },
        )
        .finally(() => {
          if (dropRequest.current === controller) {
            dropRequest.current = null;
          }
        });
    },
    [accepts, client, focusMenuPath, onMoved, workspaceId],
  );

  const actions = useMemo<EntryActions>(() => {
    const opener = (op: Operation) => (target: EntryTarget, trigger: HTMLElement | null) => {
      focusMenuPath.current = null;
      parentRow.current = parentRowOf(trigger);
      const start = scopeRef.current(target.path);
      const targets =
        op === "move"
          ? moveTargets(cacheRef.current, expandedPathsRef.current, target.path, start)
          : [];
      open({ ...target, op, targets }, trigger);
    };
    return {
      accepts,
      downloadHref: (path) => downloadUrl(workspaceId, path),
      moveInto,
      moveTo: opener("move"),
      remove: opener("remove"),
      rename: opener("rename"),
    };
  }, [accepts, cacheRef, expandedPathsRef, focusMenuPath, moveInto, open, workspaceId]);

  /**
   * 重命名与 `移动到…` 共用的那一次 `POST move`；成功后焦点给新路径那一行的 `更多操作 <名>`，拖放
   * 留下的失败文案撤掉（删除成功时同样）。
   */
  const move = useCallback(
    (from: string, to: string, conflictText: string) => {
      submit(
        (signal) => client.moveEntry(workspaceId, { from, to }, { signal }),
        () => {
          focusMenuPath.current = to;
          setNotice(null);
          onMoved(from, to);
        },
        conflictText,
      );
    },
    [client, focusMenuPath, onMoved, submit, workspaceId],
  );

  // 删除路由只对挂载内的条目答 409 `mount_boundary`，那些行的菜单没有 `删除`（`tree.tsx`），挂载列表过期时
  // 才会撞上。不给冲突文案：409 与其余失败一样显示信封 message。
  const remove = useCallback(
    (path: string) => {
      submit(
        (signal) => client.deleteEntry(workspaceId, path, { signal }),
        () => {
          focusMenuPath.current = null;
          returnFocus.current = parentRow.current;
          setNotice(null);
          onMoved(path, null);
        },
      );
    },
    [client, focusMenuPath, onMoved, returnFocus, submit, workspaceId],
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
          onMove={(target) => move(path, moveDestination(path, target), MOVE_CONFLICT)}
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

  return { actions, dialog: renderDialog(), notice };
}
