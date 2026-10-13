/**
 * Path arithmetic for `WorkspaceBrowser`: pure functions over workspace-relative paths (segments
 * joined by `/`, the root directory is `""`) and the cache of loaded directory listings. Nothing
 * here requests anything.
 */
import type { DirectoryListing, TreeEntry } from "./types.js";

export type DirectoryCache = Record<string, DirectoryListing>;

/**
 * 树上的一行，选中的文件也是它。`onlyPaths` 合成的行在父目录没加载过、或列表里没有它而它被步骤报过
 * 时没有 `size` / `mtime`（不编造）：预览头不显示那一段，文档大小的前置判定跳过（#1372）。
 */
export type TreeRow =
  | TreeEntry
  | { name: string; type: "dir" | "file"; size?: undefined; mtime?: undefined };

export type TreeRows = Record<string, { entries: TreeRow[] }>;

/**
 * 以路径为键的普通对象（列表缓存、目录的失败文案、`TreeRows`）里 `key` 自己登记过的值，没登记过是
 * `undefined`。这些表的每一处读都经这里，不用方括号：名为 `constructor`、`__proto__`、`toString` 的
 * 目录按方括号读出来的是继承自对象原型的函数或原型本身，不是列表也不是文案（#1340）。写入端（展开加
 * 计算键、`Object.fromEntries`）定义的本来就是自有属性。
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function workspacePath(parent: string, name: string) {
  if (parent.length === 0) {
    return name;
  }

  return `${parent}/${name}`;
}

/** 父目录的路径：`out/sub/a.md` → `out/sub`，根下的条目 → `""`。只按最后一个 `/` 切，别的不看。 */
export function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/**
 * 重命名发给 `move` 的 `to`：`path` 的父目录接上 `name`，原样拼接——不去空格、不折叠 `.` / `..`、
 * 不看 `name` 里有没有分隔符。带 `/` 的 `name` 会让结果离开父目录：拒绝它是调用方（`RenameDialog`）
 * 的事，是否越界由服务端 `sandbox.resolve` 裁决。
 */
export function renameTarget(path: string, name: string): string {
  return workspacePath(parentPath(path), name);
}

/**
 * 移动（`移动到…` 与拖放）发给 `move` 的 `to`：目标目录 `directory` 接上 `from` 的末段（它在列表里的
 * 名字），原样拼接——不去空格、不折叠 `.` / `..`、不编码；目标是根（`""`）时就是名字本身。两段都来自
 * 已加载的列表；能不能移由服务端裁决。
 */
export function moveDestination(from: string, directory: string): string {
  return workspacePath(directory, from.slice(from.lastIndexOf("/") + 1));
}

/**
 * 条目 `path` 能不能移进目录 `directory`（`""` 是根）：不能移进自身与自身的后代（`movedPath` 的判法：
 * 同级的 `output` 不在 `out` 之下），也不移进它当前的父目录（那是原地不动）。`移动到…` 的下拉与拖放的
 * 放下共用这一个判定；它只管界面给不给这个入口，服务端另有自己的裁决。
 */
export function canMoveInto(path: string, directory: string): boolean {
  return parentPath(path) !== directory && movedPath(directory, path, null) !== null;
}

/**
 * `from` 被移到 `to`（`null`：被删除）之后 `path` 的写法。只有 `path` 恰为 `from` 或以 `from + "/"`
 * 开头才算命中（同级的 `output` 不在 `out` 之下）：换掉这段前缀，`to` 为 `null` 时是 `null`；没命中
 * 的原样返回。
 */
export function movedPath(path: string, from: string, to: string): string;
export function movedPath(path: string, from: string, to: string | null): string | null;
export function movedPath(path: string, from: string, to: string | null): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) {
    return path;
  }

  return to === null ? null : `${to}${path.slice(from.length)}`;
}

/**
 * 带着路径的一样东西（选中项、进行中的定位）在 `from` 被移到 `to`（`null`：被删除）之后：路径照
 * `movedPath` 换，其余原样；没有这样东西，或它在被删除的 `from` 之下，是 `null`。
 */
export function movedTarget<T extends { path: string }>(
  target: T | null,
  from: string,
  to: string | null,
): T | null {
  const path = target ? movedPath(target.path, from, to) : null;
  return target && path !== null ? { ...target, path } : null;
}

/**
 * 以路径为键的一组项（展开集合、目录的失败文案、列表缓存）在 `from` 被移到 `to`（`null`：被删除）之后
 * 的样子：先丢掉 `to` 及其下早先留下的项，再把 `from` 及其下的键换到 `to` 之下，`to` 为 `null` 时丢掉；
 * 其余原样，次序不变。进出都是元组：键不经过对象的属性名。
 */
export function movedKeys<T>(
  entries: Iterable<readonly [string, T]>,
  from: string,
  to: string | null,
): [string, T][] {
  return [...entries].flatMap(([key, value]): [string, T][] => {
    const stale = to !== null && movedPath(key, to, null) === null;
    const moved = stale ? null : movedPath(key, from, to);
    return moved === null ? [] : [[moved, value]];
  });
}

/**
 * `from` 被移到 `to`（`null`：被删除）之后的列表缓存，不请求：键照 `movedKeys` 换，换了键的列表连同
 * 它的 `listing.path`；`from` 在它已加载的父目录列表里的那一条拿掉，`to` 的父目录已加载时以新名字
 * 放进去（顶掉同名的旧条目；父目录没变就留在原来的位置）。
 * 父目录随后由调用方重新列出，这里改列表只为那之前的几帧。
 */
export function movedCache(cache: DirectoryCache, from: string, to: string | null): DirectoryCache {
  const keyed = Object.entries(cache).map(([key, listing]) => [key, { key, listing }] as const);
  const kept = movedKeys(keyed, from, to).map(
    ([moved, { key, listing }]): [string, DirectoryListing] => [
      moved,
      moved === key ? listing : { ...listing, path: moved },
    ],
  );
  // `Object.fromEntries` 定义自有属性：名为 `__proto__` 的目录不会改到原型。
  const next: DirectoryCache = Object.fromEntries(kept);
  const lastName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const source = parentPath(from);
  const listed = ownValue(next, source);
  const entry = listed?.entries.find((item) => item.name === lastName(from));
  if (!listed || !entry) {
    return next;
  }

  if (to === null || parentPath(to) !== source) {
    next[source] = { ...listed, entries: listed.entries.filter((item) => item !== entry) };
  }
  const landing = to === null ? undefined : ownValue(next, parentPath(to));
  if (to !== null && landing) {
    const moved = { ...entry, name: lastName(to) };
    const rest = landing.entries.filter((item) => item === entry || item.name !== moved.name);
    next[parentPath(to)] = {
      ...landing,
      entries: rest.includes(entry)
        ? rest.map((item) => (item === entry ? moved : item))
        : [...rest, moved],
    };
  }
  return next;
}

/**
 * 地址里的 `path` 在定位之前的写法：按 `/` 切开，去掉空段与 `.` 段后接回去（`./a//b/` → `a/b`，
 * `/`、`.` → `""`）；有一段恰为 `..` 时是 `null`——调用方不为它发请求。只认这三种段：不去空格、
 * 不解码、不做 Unicode 规范化，`\` 不是分隔符，`...` 是普通的名字。
 * 服务端 `sandbox.resolve` 逐段时同样跳过空段与 `.`、拒绝 `..`；它另外整条拒绝以 `/` 开头的写法，
 * 这里则把开头的空段去掉、按相对路径定位。
 */
export function normalizedPath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? null : segments.join("/");
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
  if (!ownValue(cache, "")) {
    return [];
  }

  const paths: string[] = [""];
  const visit = (parent: string) => {
    for (const entry of ownValue(cache, parent)?.entries ?? []) {
      if (entry.type !== "dir") {
        continue;
      }

      const path = workspacePath(parent, entry.name);
      if (!ownValue(cache, path)) {
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
 * `移动到…` 可选的目标目录，`from` 是要移动的条目。只收树上此刻可见且列表已加载的目录：根（列表已
 * 加载即算），以及自身与各级上级都在 `expanded` 里、自身列表已加载的目录——自根沿各级列表里列为目录
 * 的条目下行，不看 `cache` 里还有哪些键：地址定位会把上级没列出的目录的列表留在缓存里，那样的目录在
 * 树上没有行。再去掉 `from` 自身、它的后代和它当前的父目录（`canMoveInto`）。次序同树上自上而下，根是
 * `""`。加载过但折叠着的目录不在其中，这一点与 `loadedDirectoryPaths` 不同。
 */
export function moveTargets(
  cache: DirectoryCache,
  expanded: ReadonlySet<string>,
  from: string,
): string[] {
  const visible: string[] = [];
  const visit = (path: string) => {
    const listing = ownValue(cache, path);
    if (!listing) {
      return;
    }

    visible.push(path);
    for (const entry of expanded.has(path) ? listing.entries : []) {
      const child = workspacePath(path, entry.name);
      if (entry.type === "dir" && expanded.has(child)) {
        visit(child);
      }
    }
  };
  visit("");
  return visible.filter((path) => canMoveInto(from, path));
}

/**
 * 定位到 `path` 的下一步，只看已加载的列表。各级父目录没加载就是下一个要请求的 `unloaded`——不看
 * 它在不在上一级的列表里：有没有、能不能列由服务端答复。`expand` 是其中在树上有行的那些（根，以及
 * 被一个有行的上级列为目录的）：只有它们会被展开；`unloaded` 不在 `expand` 里即它在树上没有行。
 * 各级都已加载（`unloaded` 为 `null`）时，`entry` 是末级在它父目录列表里的条目，没有则为 `null`。
 * 路径原样按 `/` 切开、原样比对：不去空格，不做 Unicode 规范化，不处理 `.` / `..` / 空段。
 */
export function revealStep(path: string, cache: DirectoryCache) {
  const parents = parentDirectories(path);
  const expand: string[] = [];
  let listed = true;
  for (const [index, parent] of parents.entries()) {
    const above = parents[index - 1];
    listed &&=
      above === undefined ||
      ownValue(cache, above)?.entries.some(
        (item) => item.type === "dir" && workspacePath(above, item.name) === parent,
      ) === true;
    if (listed) {
      expand.push(parent);
    }
    if (!ownValue(cache, parent)) {
      return { entry: null, expand, unloaded: parent };
    }
  }

  const last = parents.at(-1);
  const entry =
    last === undefined
      ? undefined
      : ownValue(cache, last)?.entries.find((item) => workspacePath(last, item.name) === path);
  return { entry: entry ?? null, expand, unloaded: null };
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
      if (ownValue(cache, parent)) {
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
    const loaded = ownValue(cache, parent)?.entries ?? [];
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
