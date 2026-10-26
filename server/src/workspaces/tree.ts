/**
 * workspaces/tree — one-level listing of ordinary files and directories.
 *
 * Synchronous, non-following metadata: lstat each direct child, skip
 * symlinks and special files, sort directories first then UTF-8 bytes.
 * Callers supply an authorized absolute directory; this module does not
 * resolve sandbox policy or fabricate empty results on failure. `skip` names
 * children left out by name alone, never looked at: the caller gives the
 * registered mount names when it lists a workspace root (D21). Inside an online mount the same
 * rules run over the mount's asynchronous adapter (`listOneLevelAsync`).
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
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
    if (!skip.has(name)) {
      retain(retained, name, lstatSync(join(absDir, name)));
    }
  }
  return ordered(retained);
}

/**
 * The same listing over asynchronous calls, one after another (the online-mount adapter, D21):
 * `readdir` of `absDir`, then `lstat` of each child in turn.
 */
export async function listOneLevelAsync(
  absDir: string,
  fs: { readdir(path: string): Promise<string[]>; lstat(path: string): Promise<Stats> },
): Promise<WorkspaceTreeEntry[]> {
  const retained: RetainedEntry[] = [];
  for (const name of await fs.readdir(absDir)) {
    retain(retained, name, await fs.lstat(join(absDir, name)));
  }
  return ordered(retained);
}

/** Ordinary files and directories only: symlinks and special files are left out. */
function retain(retained: RetainedEntry[], name: string, status: Stats): void {
  let type: "dir" | "file";
  if (status.isSymbolicLink()) {
    return;
  }
  if (status.isDirectory()) {
    type = "dir";
  } else if (status.isFile()) {
    type = "file";
  } else {
    return;
  }
  retained.push({
    name,
    encoded: Buffer.from(name, "utf8"),
    type,
    size: status.size,
    mtime: status.mtimeMs,
  });
}

/** Directories first, then by UTF-8 bytes. */
function ordered(retained: RetainedEntry[]): WorkspaceTreeEntry[] {
  retained.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "dir" ? -1 : 1;
    }
    return Buffer.compare(left.encoded, right.encoded);
  });
  return retained.map(({ name, type, size, mtime }) => ({ name, type, size, mtime }));
}
