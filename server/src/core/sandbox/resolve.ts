/**
 * core/sandbox resolve — 沙箱路径边界（不变量 3）。
 *
 * 同步、只读元数据：规范化受信 root，按用户分量逐个 lstat 拒绝任何
 * symlink，再按 `realpath(root)` 前缀匹配。不创建、不读取目标内容。
 * 第一段是已登记挂载名时不碰该段及其下任何分量（D21：宿主不同步进入挂载）。
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * 路径的第一段：按 `/` 分割、去掉空段与 `.` 段之后的第一个分量（`..` 不去掉，由 resolve 拒绝）；
 * 没有这样的分量（空间根）时为 undefined。挂载成员判定与 resolve 用同一个函数。
 */
export function firstSegment(relPath: string): string | undefined {
  return relPath.split("/").find((component) => component !== "" && component !== ".");
}

export function resolve(
  root: string,
  relPath: string,
  op: "read" | "list" | "mkdir" | "write" | "delete" | "move",
  mountNames?: ReadonlySet<string>,
): { ok: true; absPath: string; mount?: string } | { ok: false; reason: string } {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: "cannot resolve sandbox root" };
  }

  if (relPath.includes("\0")) {
    return { ok: false, reason: "path contains a NUL byte" };
  }
  if (relPath.startsWith("/")) {
    return { ok: false, reason: "path is absolute" };
  }

  const components = relPath.split("/");
  if (namesEntry(op) && !isValidMkdirTerminal(components.at(-1))) {
    return { ok: false, reason: "mkdir name is invalid" };
  }

  const mount = mountOf(relPath, mountNames);
  const current = walkComponents(canonicalRoot, components, mount === undefined);
  if (current === undefined) {
    return { ok: false, reason: "path is not inside the sandbox root" };
  }

  if (current !== canonicalRoot && !current.startsWith(`${canonicalRoot}/`)) {
    return { ok: false, reason: "path escapes the sandbox root" };
  }
  return mount === undefined
    ? { ok: true, absPath: current }
    : { ok: true, absPath: current, mount };
}

function mountOf(relPath: string, mountNames: ReadonlySet<string> | undefined): string | undefined {
  const first = firstSegment(relPath);
  return first !== undefined && mountNames?.has(first) === true ? first : undefined;
}

/**
 * 从规范化 root 起词法拼接各分量；任一分量为 `..` 即拒（undefined）。`inspect` 为真时对每个
 * 已存在分量 lstat、遇符号链接即拒；挂载内（`inspect` 为假）不做任何文件系统调用。
 */
function walkComponents(
  canonicalRoot: string,
  components: readonly string[],
  inspect: boolean,
): string | undefined {
  let current = canonicalRoot;
  for (const component of components) {
    if (component === "..") {
      return undefined;
    }
    if (component === "" || component === ".") {
      continue;
    }

    current = join(current, component);
    if (inspect && !inspectExisting(current)) {
      return undefined;
    }
  }
  return current;
}

/**
 * mkdir、write、delete、move 的末段都必须点名一个条目，共用同一段末段词法判定；
 * 空串（空间根本身）因此不能被新建、删除、移动或作为移动的目标。
 */
function namesEntry(op: string): boolean {
  return op === "mkdir" || op === "write" || op === "delete" || op === "move";
}

function isValidMkdirTerminal(name: string | undefined): boolean {
  return (
    name !== undefined && name.length > 0 && name !== "." && name !== ".." && !name.includes("\\")
  );
}
function inspectExisting(path: string): boolean {
  try {
    const status = lstatSync(path, { throwIfNoEntry: false });
    if (status === undefined) {
      return true;
    }
    return !status.isSymbolicLink();
  } catch (error) {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR"
    );
  }
}
