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
  op: "read" | "list" | "mkdir",
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
  if (op === "mkdir" && !isValidMkdirTerminal(components.at(-1))) {
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
  } catch {
    return false;
  }
}
