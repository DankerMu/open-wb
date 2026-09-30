/**
 * The one session cwd resolution (#521, parent D4): an unbound session runs in its owner root; a
 * bound one in the root the workspace store's owner-scoped `rootOf` answers, which must already be
 * a directory. Never creates a directory and never falls back to the owner root.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { AgentUnavailableError } from "./omp/process.js";

/** The workspace store's owner-scoped `rootOf`, injected by createApp (sessions never builds one). */
export type WorkspaceRootOf = (ownerId: string, workspaceId: string) => string | null;

export function sessionCwdResolver(sandboxRoot: string, workspaceRootOf: WorkspaceRootOf) {
  return (ownerId: string, workspaceId: string | null): string => {
    if (workspaceId === null) {
      return join(sandboxRoot, ownerId);
    }
    let root: string | null;
    try {
      root = workspaceRootOf(ownerId, workspaceId);
    } catch {
      // rootOf throws when the root exists but is not a plain directory (file, symlink, unsafe path)
      throw new AgentUnavailableError("session workspace root is unusable");
    }
    if (root === null) {
      // Invariant broken (the workspace is not this owner's): a generic failure, never a fallback.
      throw new Error("session workspace root is unresolvable");
    }
    if (!isDirectory(root)) {
      throw new AgentUnavailableError("session workspace root is missing");
    }
    return root;
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
