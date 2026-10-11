/**
 * Path arithmetic for `WorkspaceBrowser`: pure functions over workspace-relative paths (segments
 * joined by `/`, the root directory is `""`) and the cache of loaded directory listings. Nothing
 * here requests anything.
 */
import type { DirectoryListing, TreeEntry } from "./types.js";

export type DirectoryCache = Record<string, DirectoryListing>;

/** 树上的一行。`onlyPaths` 合成的行在父目录没加载过时没有 `size` / `mtime`（不编造）。 */
export type TreeRow =
  | TreeEntry
  | { name: string; type: "dir" | "file"; size?: undefined; mtime?: undefined };

export type TreeRows = Record<string, { entries: TreeRow[] }>;

export function workspacePath(parent: string, name: string) {
  if (parent.length === 0) {
    return name;
  }

  return `${parent}/${name}`;
}

/** 各级父目录，自根向下：`src/deep/app.ts` → `["", "src", "src/deep"]`；根自身没有父目录。 */
function parentDirectories(path: string): string[] {
  if (path.length === 0) {
    return [];
  }

  const parents = [""];
  for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
    parents.push(path.slice(0, slash));
  }
  return parents;
}

export function loadedDirectoryPaths(cache: DirectoryCache) {
  if (!cache[""]) {
    return [];
  }

  const paths: string[] = [""];
  const visit = (parent: string) => {
    for (const entry of cache[parent]?.entries ?? []) {
      if (entry.type !== "dir") {
        continue;
      }

      const path = workspacePath(parent, entry.name);
      if (!cache[path]) {
        continue;
      }

      paths.push(path);
      visit(path);
    }
  };
  visit("");
  return paths;
}

/**
 * 定位到 `path` 的下一步，只看已加载的列表：`expand` 是走得到的各级父目录；`unloaded` 是第一个还
 * 没加载的层（没有则为 `null`）；`entry` 是末级在它父目录列表里的条目——中途缺了一级、某一级不是
 * 目录或末级不在列表里时为 `null`。
 */
export function revealStep(path: string, cache: DirectoryCache) {
  const parents = parentDirectories(path);
  const expand: string[] = [];
  for (const [index, parent] of parents.entries()) {
    expand.push(parent);
    if (!Object.hasOwn(cache, parent)) {
      return { entry: null, expand, unloaded: parent };
    }

    const child = parents[index + 1] ?? path;
    const entry = cache[parent]?.entries.find((item) => workspacePath(parent, item.name) === child);
    if (child === path) {
      return { entry: entry ?? null, expand, unloaded: null };
    }
    if (entry?.type !== "dir") {
      break;
    }
  }
  return { entry: null, expand, unloaded: null };
}

/** 带标记的行：这些路径本身与它们的各级父目录；根行不带。 */
export function markedRows(paths: Iterable<string>): ReadonlySet<string> {
  const rows = new Set<string>();
  for (const path of paths) {
    rows.add(path);
    for (const parent of parentDirectories(path)) {
      rows.add(parent);
    }
  }
  rows.delete("");
  return rows;
}

/** `refresh(paths)` 要重取的层：这些路径的各级父目录里已加载的那些（路径自身即使是目录也不算）。 */
export function refreshLayers(cache: DirectoryCache, paths: Iterable<string>): ReadonlySet<string> {
  const layers = new Set<string>();
  for (const path of paths) {
    for (const parent of parentDirectories(path)) {
      if (Object.hasOwn(cache, parent)) {
        layers.add(parent);
      }
    }
  }
  return layers;
}

/**
 * `onlyPaths` 的树：只由这些路径与它们的各级父目录构成，各级目录都展开。某一行在已加载的父目录
 * 列表里有同名同类的条目时沿用那一条（带 `size` / `mtime`），否则只有名字与类别。同一级目录在前，
 * 再按名字的字符串序。
 */
export function subtreeOf(onlyPaths: Iterable<string>, cache: DirectoryCache) {
  const children = new Map<string, Map<string, "dir" | "file">>([["", new Map()]]);
  for (const path of onlyPaths) {
    const parents = parentDirectories(path);
    for (const [index, parent] of parents.entries()) {
      const child = parents[index + 1];
      const name = (child ?? path).slice(parent.length === 0 ? 0 : parent.length + 1);
      const siblings = children.get(parent) ?? new Map<string, "dir" | "file">();
      children.set(parent, siblings);
      if (child !== undefined) {
        siblings.set(name, "dir");
      } else if (!siblings.has(name)) {
        siblings.set(name, "file");
      }
    }
  }

  const rows = [...children].map(([parent, siblings]) => {
    const loaded = Object.hasOwn(cache, parent) ? (cache[parent]?.entries ?? []) : [];
    const entries = [...siblings].map(
      ([name, type]): TreeRow =>
        loaded.find((entry) => entry.name === name && entry.type === type) ?? { name, type },
    );
    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "dir" ? -1 : 1;
      }
      return left.name < right.name ? -1 : 1;
    });
    return [parent, { entries }] as const;
  });
  // `Object.fromEntries` 定义自有属性：名为 `__proto__` 的目录不会改到原型。
  const tree: TreeRows = Object.fromEntries(rows);
  return { expandedPaths: new Set(children.keys()) as ReadonlySet<string>, tree };
}
