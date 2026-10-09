/**
 * core/sandbox resolve — 沙箱路径边界（不变量 3）。
 *
 * 同步、只读元数据：规范化受信 root，按用户分量逐个 lstat 拒绝任何
 * symlink，再按 `realpath(root)` 前缀匹配。不创建、不读取目标内容。
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function resolve(
  root: string,
  relPath: string,
  op: "read" | "list" | "mkdir" | "write" | "delete" | "move",
): { ok: true; absPath: string } | { ok: false; reason: string } {
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

  let current = canonicalRoot;
  for (const component of components) {
    if (component === "..") {
      return { ok: false, reason: "path is not inside the sandbox root" };
    }
    if (component === "" || component === ".") {
      continue;
    }

    current = join(current, component);
    if (!inspectExisting(current)) {
      return { ok: false, reason: "path is not inside the sandbox root" };
    }
  }

  if (current !== canonicalRoot && !current.startsWith(`${canonicalRoot}/`)) {
    return { ok: false, reason: "path escapes the sandbox root" };
  }
  return { ok: true, absPath: current };
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
