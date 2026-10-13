/**
 * `WorkspaceBrowser` 对「已不存在的文件」的记账（workspace-sidebar「本会话改动标记与过滤」，#1372）：
 * 两种记录、它们的作废，以及 `onlyPaths` 里哪些路径还成行。记录在组件内存里，随卸载清空；都是 `Set`，
 * 不是以路径为键的普通对象。这里不发请求。
 *
 * - `reported`：宿主经句柄 `reported(paths)` 告知「刚被一个结束的步骤报过」的路径。`onlyPaths` 下不发
 *   `tree`，已加载的列表不会更新：被报过的路径不因那份列表里没有它而被判不存在。
 * - `missing`：`file` / `archive` 应答过 404 的路径。只在给了 `onlyPaths` 或 `clearMissing` 时才记。
 * - 作废（design D14-8）：某目录的 `tree` 列表读到时，直属于它的路径两种记录都清掉（`withListed`），
 *   按新列表重判；被再报一次的路径清掉 404 记录（`withReported`）。`refresh` 本身不动记录——
 *   `onlyPaths` 下它不发 `tree`，移出的行不会因为点一次 `刷新` 而回来。
 */
import { useCallback, useRef, useState } from "react";
import { type DirectoryCache, ownValue, parentPath, type TreeRow } from "./browser-paths.js";

type PathRecords = { missing: ReadonlySet<string>; reported: ReadonlySet<string> };

const NO_RECORDS: PathRecords = { missing: new Set(), reported: new Set() };

/** 这些路径被步骤报过：记下，并清掉它们的 404 记录。 */
function withReported(records: PathRecords, paths: readonly string[]): PathRecords {
  const missing = new Set(records.missing);
  for (const path of paths) {
    missing.delete(path);
  }
  return { missing, reported: new Set([...records.reported, ...paths]) };
}

/** `path` 的 `file` / `archive` 应答了 404。 */
function withMissing(records: PathRecords, path: string): PathRecords {
  return { missing: new Set(records.missing).add(path), reported: records.reported };
}

/** 目录 `directory` 的列表读到了：直属于它的路径两种记录都清掉；没有这样的记录时原样返回。 */
function withListed(records: PathRecords, directory: string): PathRecords {
  const elsewhere = (paths: ReadonlySet<string>) =>
    new Set([...paths].filter((path) => parentPath(path) !== directory));
  const missing = elsewhere(records.missing);
  const reported = elsewhere(records.reported);
  return missing.size === records.missing.size && reported.size === records.reported.size
    ? records
    : { missing, reported };
}

/**
 * `onlyPaths` 里的文件 `path` 在过滤视图里的那一行，`null` 即它已被判定为不存在、不成行：应答过 404；
 * 或父目录的列表已加载、其中没有同名的文件、那之后也没有被报过。父目录的列表里有它时沿用那一条（带
 * `size` / `mtime`，可能是旧的）；父目录没加载过、或列表里没有而被报过时只有名字，是否存在留给选中时
 * `file` / `archive` 的应答。只看直属的父目录，不看更上面的各级。
 */
export function filteredRow(
  path: string,
  cache: DirectoryCache,
  records: PathRecords,
): TreeRow | null {
  if (records.missing.has(path)) {
    return null;
  }

  const name = path.slice(path.lastIndexOf("/") + 1);
  const listing = ownValue(cache, parentPath(path));
  const entry = listing?.entries.find((item) => item.name === name && item.type === "file");
  if (entry) {
    return entry;
  }
  return listing && !records.reported.has(path) ? null : { name, type: "file" };
}

/**
 * `onlyPaths` 里还成行的那些路径（`filteredRow` 不是 `null`）；`subtreeOf` 与空集文案都拿它。没有
 * `onlyPaths` 时是 `undefined`。
 */
export function listedPaths(
  onlyPaths: ReadonlySet<string> | undefined,
  cache: DirectoryCache,
  records: PathRecords,
): ReadonlySet<string> | undefined {
  return (
    onlyPaths &&
    new Set([...onlyPaths].filter((path) => filteredRow(path, cache, records) !== null))
  );
}

/**
 * 两种记录与写它们的三个入口（引用都稳定）：`records` 供渲染，`ref` 供回调读当下的值（同一拍里先
 * `reported` 再定位）。`listed(directory)`：该目录的列表读到了；`missing(path)`：它的 `file` /
 * `archive` 答了 404；`reported(paths)`：它们刚被一个结束的步骤报过。
 */
export function usePathRecords() {
  const [records, setRecords] = useState(NO_RECORDS);
  const ref = useRef(records);
  const update = useCallback((change: (records: PathRecords) => PathRecords) => {
    ref.current = change(ref.current);
    setRecords(ref.current);
  }, []);
  const listed = useCallback((path: string) => update((now) => withListed(now, path)), [update]);
  const missing = useCallback((path: string) => update((now) => withMissing(now, path)), [update]);
  const reported = useCallback(
    (paths: readonly string[]) => update((now) => withReported(now, paths)),
    [update],
  );
  return { listed, missing, records, ref, reported };
}
