/**
 * workspaces/mounts/files — what the file endpoints do inside an online mount (s1b-workspace-mounts D16,
 * D21; workspace-mounts「挂载目录内的文件端点」): the listing, the open of a regular file and its reads,
 * `mkdir` of one level and a same-mount `rename`, each file system call through the manager's adapter
 * (`fs.ts`) and none synchronous — a hung remote then holds one libuv thread for at most the deadline,
 * never the event loop. The rules mirror the routes' own outside mounts (404 for what is absent or not
 * an ordinary file / directory, 409 for what is already there); the differences are D16's: `mkdir`
 * makes only the one level and nothing is `chmod`ed (rclone's `--umask` decides the mode), and a read
 * that reaches EOF before the length already announced destroys the stream (#1665 P7: an rclone
 * descriptor fixes neither the inode nor the content, and `fstat` keeps the old size).
 *
 * The path under the mount point is followed as the kernel sees it: no `lstat` of the mount point
 * comes first. While a mount is `online` its point is the FUSE mount itself, which cannot be renamed,
 * removed or replaced by a symlink (EBUSY), and rclone mounts show no symlinks (`local` without
 * `--links` skips them, `sftp` follows them on the server; #1665 P13). The residual is the transition:
 * a request that passed the status check (`path-rule.ts`) and waits on the gate while the mount goes
 * offline (a failed probe, not an expired call: those fail every queued call) still makes its calls
 * after the lazy unmount, when the point is an ordinary directory omp could have swapped — the same
 * class as the intermediate-component residual of the routes outside mounts (owner B1).
 *
 * The one call not through the adapter is the fallback close: past a deadline the adapter admits
 * nothing more on that mount, so a handle whose close it refuses is closed directly. By then the
 * manager has begun the SIGKILL and lazy unmount that make a stuck FUSE request return (#1665 P9).
 */
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "../../core/errors/index.js";
import { isRefusedOpen, isStructuralAbsence, READ_OPEN_FLAGS } from "../regular-file.js";
import { listOneLevelAsync, type WorkspaceTreeEntry } from "../tree.js";
import type { MountFileHandle, MountFs } from "./fs.js";

/** The most one adapter `read` of a stream asks for. */
const CHUNK_BYTES = 64 * 1024;

/** A regular file opened in a mount: `size` is its handle's `fstat`, the authority from here on. */
export interface MountFile {
  mountId: string;
  handle: MountFileHandle;
  size: number;
}

/** The entry at `path`, or undefined when nothing is there. */
async function lstatExisting(
  fs: MountFs,
  mountId: string,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await fs.lstat(mountId, path);
  } catch (error) {
    if (isStructuralAbsence(error)) {
      return undefined;
    }
    throw error;
  }
}

/** tree: the one-level listing of the directory at `absPath`; anything else is 404. */
export async function listMountDir(
  fs: MountFs,
  mountId: string,
  absPath: string,
): Promise<WorkspaceTreeEntry[]> {
  if ((await lstatExisting(fs, mountId, absPath))?.isDirectory() !== true) {
    throw new HttpError("not_found");
  }
  return listOneLevelAsync(absPath, {
    readdir: (path) => fs.readdir(mountId, path),
    lstat: (path) => fs.lstat(mountId, path),
  });
}

/** What was never a regular file is 404 before anything opens it (and before an archive's name). */
export async function requireMountFile(
  fs: MountFs,
  mountId: string,
  absPath: string,
): Promise<void> {
  if ((await lstatExisting(fs, mountId, absPath))?.isFile() !== true) {
    throw new HttpError("not_found");
  }
}

/**
 * Opens what `requireMountFile` found, judged again from the handle (what was swapped in since is 404);
 * the caller closes it (`closeMountFile`) or hands it to `mountRangeStream`.
 */
export async function openMountFile(
  fs: MountFs,
  mountId: string,
  absPath: string,
): Promise<MountFile> {
  let handle: MountFileHandle;
  try {
    handle = await fs.open(mountId, absPath, READ_OPEN_FLAGS);
  } catch (error) {
    throw isRefusedOpen(error) ? new HttpError("not_found") : error;
  }
  const file: MountFile = { mountId, handle, size: 0 };
  try {
    const status = await fs.fstat(mountId, handle);
    if (!status.isFile()) {
      throw new HttpError("not_found");
    }
    file.size = status.size;
    return file;
  } catch (error) {
    void closeMountFile(fs, file);
    throw error;
  }
}

/** Through the adapter; refused there (`mount_offline`), directly. Never rejects. */
export function closeMountFile(fs: MountFs, file: Pick<MountFile, "mountId" | "handle">) {
  return fs.close(file.mountId, file.handle).catch((error: unknown) => {
    if (error instanceof HttpError && error.code === "mount_offline") {
      return file.handle.close().catch(() => undefined);
    }
    // The answer is already decided by now; a failing close of a read-only handle changes nothing.
    return undefined;
  });
}

/**
 * `length` bytes at `position`, fewer only where the file ends: each read may come back short, so it
 * is repeated until the buffer is full or a read gets nothing. The buffer is this call's own: a read
 * that outlives its deadline still writes into it (`fs.ts`), and nothing else ever looks at it again.
 */
export async function readMountAt(
  fs: MountFs,
  file: MountFile,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const bytesRead = await fs.read(
      file.mountId,
      file.handle,
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Bytes `start` through `end` (both included; `end < start`: none), pulled one adapter `read` at a
 * time into a fresh buffer each, never beyond `end`. EOF before `end` destroys the stream with an
 * error — the framework then destroys the connection: nothing is padded and the response never ends
 * normally (D16). Ending, failing or being destroyed lets the handle go (`closeMountFile`).
 */
export function mountRangeStream(
  fs: MountFs,
  file: MountFile,
  start: number,
  end: number,
): Readable {
  let position = start;
  return new Readable({
    read() {
      const length = Math.min(CHUNK_BYTES, end - position + 1);
      if (length <= 0) {
        this.push(null);
        return;
      }
      const buffer = Buffer.alloc(length);
      fs.read(file.mountId, file.handle, buffer, 0, length, position).then(
        (bytesRead) => {
          if (bytesRead === 0) {
            this.destroy(new Error(`mount file ended at byte ${position} of ${end + 1}`));
            return;
          }
          position += bytesRead;
          this.push(buffer.subarray(0, bytesRead));
          if (position > end) {
            this.push(null);
          }
        },
        (error: unknown) => {
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    },
    destroy(error, callback) {
      // Not waited for: a close stuck behind a hung call must not hold the error back.
      void closeMountFile(fs, file);
      callback(error);
    },
  });
}

/** dirs: one `mkdir`; its parent missing or not a directory is 404, anything already there 409. */
export async function makeMountDir(fs: MountFs, mountId: string, absPath: string): Promise<void> {
  try {
    await fs.mkdir(mountId, absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HttpError("conflict");
    }
    throw isStructuralAbsence(error) ? new HttpError("not_found") : error;
  }
}

/**
 * move within one mount, the route's checks in the route's order: `from` an ordinary file or
 * directory (404), `to`'s parent a directory (404), nothing at `to` (409); then one `rename`.
 */
export async function moveInMount(
  fs: MountFs,
  mountId: string,
  fromAbs: string,
  toAbs: string,
): Promise<"file" | "dir"> {
  const from = await lstatExisting(fs, mountId, fromAbs);
  const type = from?.isFile() === true ? "file" : from?.isDirectory() === true ? "dir" : undefined;
  if (type === undefined) {
    throw new HttpError("not_found");
  }
  if ((await lstatExisting(fs, mountId, dirname(toAbs)))?.isDirectory() !== true) {
    throw new HttpError("not_found");
  }
  if ((await lstatExisting(fs, mountId, toAbs)) !== undefined) {
    throw new HttpError("conflict");
  }
  await fs.rename(mountId, fromAbs, toAbs);
  return type;
}
