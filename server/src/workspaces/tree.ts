/**
 * workspaces/tree — one-level listing of ordinary files and directories.
 *
 * Synchronous, non-following metadata: lstat each direct child, skip
 * symlinks and special files, sort directories first then UTF-8 bytes.
 * Callers supply an authorized absolute directory; this module does not
 * resolve sandbox policy or fabricate empty results on failure. `skip` names
 * children left out by name alone, never looked at: the caller gives the
 * registered mount names when it lists a workspace root (D21).
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceTreeEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

interface RetainedEntry {
  name: string;
  encoded: Buffer;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

export function listOneLevel(
  absDir: string,
  skip: ReadonlySet<string> = new Set(),
): WorkspaceTreeEntry[] {
  const retained: RetainedEntry[] = [];

  for (const name of readdirSync(absDir)) {
    if (skip.has(name)) {
      continue;
    }
    const status = lstatSync(join(absDir, name));
    if (status.isSymbolicLink()) {
      continue;
    }

    let type: "dir" | "file";
    if (status.isDirectory()) {
      type = "dir";
    } else if (status.isFile()) {
      type = "file";
    } else {
      continue;
    }

    retained.push({
      name,
      encoded: Buffer.from(name, "utf8"),
      type,
      size: status.size,
      mtime: status.mtimeMs,
    });
  }

  retained.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }
    return Buffer.compare(left.encoded, right.encoded);
  });

  return retained.map(({ name, type, size, mtime }) => ({ name, type, size, mtime }));
}
