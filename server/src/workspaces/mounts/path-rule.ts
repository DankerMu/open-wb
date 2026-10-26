/**
 * workspaces/mounts/path-rule — the lexical part of D16 (workspace-mounts「挂载目录内的文件端点」):
 * which registered mount a path of a file endpoint is in, and the refusals that follow from that
 * alone. Callers run it after `sandbox.resolve` (an escape stays 403 + audit) and before any
 * existence check or filesystem call; it reads only the names, never the filesystem.
 *
 * Interim (#1694 → #1696): every mount counts as offline here. The online path through the async
 * adapter (D21) and the read-only 403 come with group 9; until then nothing behind a mount point
 * — a live mount, or what omp left there while it is offline — is entered by these endpoints.
 */
import { HttpError } from "../../core/errors/index.js";
import { firstSegment } from "../../core/sandbox/resolve.js";

/** The registered mount `path` is in: its first segment (the sandbox's), when that is a mount name. */
function mountOf(names: ReadonlySet<string>, path: string): string | undefined {
  const first = firstSegment(path);
  return first !== undefined && names.has(first) ? first : undefined;
}

/** A mount's own root: the first segment is all there is (`远端`, `./远端/`). */
function isMountRoot(names: ReadonlySet<string>, path: string): boolean {
  return (
    mountOf(names, path) !== undefined &&
    path.split("/").filter((component) => component !== "" && component !== ".").length === 1
  );
}

/** tree (below the root) / file / download / archive / dirs: inside a mount → 409 `mount_offline`. */
export function refuseInMount(names: ReadonlySet<string>, path: string): void {
  if (mountOf(names, path) !== undefined) {
    throw new HttpError("mount_offline");
  }
}

/** `DELETE …/entries`: a target in any mount, its root included → 409 `mount_boundary`. */
export function refuseDeleteInMount(names: ReadonlySet<string>, path: string): void {
  if (mountOf(names, path) !== undefined) {
    throw new HttpError("mount_boundary");
  }
}

/**
 * `POST …/move`: exactly one side in a mount, the two in different mounts, or `from` a mount root
 * → 409 `mount_boundary`; both in the same mount → 409 `mount_offline` (the boundary first: it
 * cannot succeed whatever the mount's state).
 */
export function refuseMoveInMount(names: ReadonlySet<string>, from: string, to: string): void {
  const fromMount = mountOf(names, from);
  const toMount = mountOf(names, to);
  if (fromMount === undefined && toMount === undefined) {
    return;
  }
  if (fromMount !== toMount || isMountRoot(names, from)) {
    throw new HttpError("mount_boundary");
  }
  throw new HttpError("mount_offline");
}
