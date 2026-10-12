/**
 * What `WorkspaceBrowser` does after an entry operation has succeeded: its listings, expanded set,
 * failure texts, in-flight directory requests, the walk in progress and the selection follow the
 * entry to its new path (or drop it) without walking the tree again. Nothing here decides what may
 * be moved or deleted — the server already answered.
 */
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import {
  type DirectoryCache,
  movedCache,
  movedKeys,
  movedPath,
  movedTarget,
  parentPath,
} from "./browser-paths.js";
import type { SelectedFile } from "./preview-area.js";
import type { TreeEntry } from "./types.js";

type Paths = ReadonlySet<string>;

/** `WorkspaceBrowser` 交出来的状态：引用、写状态的函数与它自己的几个操作。 */
type FollowState<Reveal extends { path: string }> = {
  cacheRef: RefObject<DirectoryCache>;
  directoryRequestsRef: RefObject<Map<string, AbortController>>;
  expandedPathsRef: RefObject<Paths>;
  failedDirectoriesRef: RefObject<Map<string, string>>;
  revealRef: RefObject<Reveal | null>;
  selectedFileRef: RefObject<SelectedFile | null>;
  setDirectories: Dispatch<SetStateAction<DirectoryCache>>;
  setDirectoryErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setExpandedPaths: Dispatch<SetStateAction<Paths>>;
  setLoadingPaths: Dispatch<SetStateAction<Paths>>;
  clearSelection(): void;
  loadDirectory(path: string, refresh?: boolean): void;
  onPathChange(path: string | null): void;
  selectFile(entry: TreeEntry, path: string): void;
};

/**
 * 放弃 `from` 及其之下、`to`（不是 `null` 时）及其之下在途的目录请求：中止，并从请求表里删去。`to`
 * 之下在途的是早先留在那个位置上的目录的列表，落地了会被当成刚移过去的目录的内容。
 */
function abandonRequests(requests: Map<string, AbortController>, from: string, to: string | null) {
  for (const [path, controller] of [...requests]) {
    if (
      movedPath(path, from, null) === null ||
      (to !== null && movedPath(path, to, null) === null)
    ) {
      controller.abort();
      requests.delete(path);
    }
  }
}

/**
 * `from` 已被改名或移动为 `to`，或已被删除（`to` 为 `null`），界面跟过去而不重新逐级展开。次序：放弃
 * `from` 之下、以及 `to` 之下（那里早先留下的目录已被顶掉）在途的目录请求；列表缓存、展开集合、目录的
 * 失败文案与进行中的定位换到新路径（`movedKeys`：先丢 `to` 之下早先留下的，再换；删除时 `from` 之下的
 * 都丢掉、定位放弃）；当前文件在 `from` 之下时在新路径重新选中一次（按新名的类别重取：`file`、
 * `archive` 或预览来源的地址）并上报，删除时清掉选中并上报 `null`——选中在前、上报在后，上报回来的
 * `path` 不另起定位；重新列出受影响的层，先 `from` 的父目录、后 `to` 的父目录，同一层只列一次（改名
 * 与删除因此只有一次）；已展开而没有列表的新路径补一次请求。
 */
export function useFollowEntry<Reveal extends { path: string }>({
  cacheRef,
  clearSelection,
  directoryRequestsRef,
  expandedPathsRef,
  failedDirectoriesRef,
  loadDirectory,
  onPathChange,
  revealRef,
  selectFile,
  selectedFileRef,
  setDirectories,
  setDirectoryErrors,
  setExpandedPaths,
  setLoadingPaths,
}: FollowState<Reveal>) {
  return useCallback(
    (from: string, to: string | null) => {
      const requests = directoryRequestsRef.current;
      abandonRequests(requests, from, to);
      // 上面放弃的请求不再走到自己的收尾：它们的读取中标记在这里一并拿掉。
      setLoadingPaths((current) => new Set([...current].filter((path) => requests.has(path))));
      cacheRef.current = movedCache(cacheRef.current, from, to);
      setDirectories(cacheRef.current);
      const expanded = movedKeys(expandedPathsRef.current.entries(), from, to);
      expandedPathsRef.current = new Set(expanded.map(([path]) => path));
      setExpandedPaths(expandedPathsRef.current);
      setDirectoryErrors((current) =>
        Object.fromEntries(movedKeys(Object.entries(current), from, to)),
      );
      failedDirectoriesRef.current = new Map(movedKeys(failedDirectoriesRef.current, from, to));
      revealRef.current = movedTarget(revealRef.current, from, to);
      const selected = selectedFileRef.current;
      const next = movedTarget(selected, from, to);
      if (selected && !next) {
        clearSelection();
        onPathChange(null);
      } else if (next && next.path !== selected?.path) {
        const name = next.path.slice(next.path.lastIndexOf("/") + 1);
        selectFile({ ...next.entry, name }, next.path);
        onPathChange(next.path);
      }
      const layers = new Set([parentPath(from), parentPath(to ?? from)]);
      layers.forEach((layer) => {
        loadDirectory(layer, true);
      });
      for (const [path] of expanded) {
        if (to !== null && movedPath(path, to, null) === null) {
          loadDirectory(path);
        }
      }
    },
    [
      cacheRef,
      clearSelection,
      directoryRequestsRef,
      expandedPathsRef,
      failedDirectoriesRef,
      loadDirectory,
      onPathChange,
      revealRef,
      selectFile,
      selectedFileRef,
      setDirectories,
      setDirectoryErrors,
      setExpandedPaths,
      setLoadingPaths,
    ],
  );
}
