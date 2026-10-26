/**
 * workspaces/mounts/path-rule — D16 (workspace-mounts「挂载目录内的文件端点」): which registered mount a
 * path of a file endpoint is in, and the refusals that follow. Callers run it after `sandbox.resolve`
 * (an escape stays 403 + audit) and before any existence check or file system call; it reads only the
 * manager's in-memory registry (name, status, read-only), never the file system.
 *
 * Membership: the path's first segment (the sandbox's `firstSegment`: empty and `.` components dropped)
 * is a registered mount's name, byte for byte; nothing after it is the mount's root. The boundary comes
 * first (a delete or a cross-boundary move cannot succeed whatever the mount's state), then offline
 * (409 `mount_offline`; a mount is offline unless `online`, and with the feature off it never is), then
 * read-only for the writes (403 `mount_read_only`). What passes comes back as the mount, whose calls the
 * route makes through the adapter (D21); undefined means the path is in no mount.
 */
import { HttpError } from "../../core/errors/index.js";
import { firstSegment } from "../../core/sandbox/resolve.js";
import type { MountRef } from "./manager.js";

/** The workspace's registered mount of that name, or undefined. */
export type MountLookup = (name: string) => MountRef | undefined;

function mountOf(lookup: MountLookup, path: string): MountRef | undefined {
  const first = firstSegment(path);
  return first === undefined ? undefined : lookup(first);
}

/** A mount's own root: the first segment is all there is (`远端`, `./远端/`). */
function isMountRoot(path: string): boolean {
  return path.split("/").filter((component) => component !== "" && component !== ".").length === 1;
}

/** Offline → 409; a write into a read-only mount → 403. */
function usable(mount: MountRef, write: boolean): MountRef {
  if (mount.status !== "online") {
    throw new HttpError("mount_offline");
  }
  if (write && mount.readOnly) {
    throw new HttpError("mount_read_only");
  }
  return mount;
}

/** tree (below the root) / file / download / archive: the online mount `path` is in, if any. */
export function mountToRead(lookup: MountLookup, path: string): MountRef | undefined {
  const mount = mountOf(lookup, path);
  return mount === undefined ? undefined : usable(mount, false);
}

/** dirs: the online, writable mount `path` is in, if any. */
export function mountToWrite(lookup: MountLookup, path: string): MountRef | undefined {
  const mount = mountOf(lookup, path);
  return mount === undefined ? undefined : usable(mount, true);
}

/** `DELETE …/entries`: a target in any mount, its root included → 409 `mount_boundary`. */
export function refuseDeleteInMount(lookup: MountLookup, path: string): void {
  if (mountOf(lookup, path) !== undefined) {
    throw new HttpError("mount_boundary");
  }
}

/**
 * `POST …/move`: exactly one side in a mount, the two in different mounts, or `from` a mount root
 * → 409 `mount_boundary`; both in the same mount: that mount when it is online and writable.
 */
export function mountToMoveIn(lookup: MountLookup, from: string, to: string): MountRef | undefined {
  const fromMount = mountOf(lookup, from);
  const toMount = mountOf(lookup, to);
  if (fromMount === undefined && toMount === undefined) {
    return undefined;
  }
  if (fromMount === undefined || fromMount.id !== toMount?.id || isMountRoot(from)) {
    throw new HttpError("mount_boundary");
  }
  return usable(fromMount, true);
}
