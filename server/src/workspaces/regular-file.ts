/**
 * workspaces/regular-file — the one open of a file every read route serves (`file`, `download`,
 * `archive`, the preview listener's `/w/` and the PDF `/o/` sends), after its own lstat found a
 * regular file there.
 *
 * The path may have been replaced since that lstat, so the open neither follows a final symlink
 * nor waits on a pipe, and what was opened is judged from its descriptor: anything but a regular
 * file is closed here and is `not_found`, as is an open refused because nothing is there any more,
 * because a symlink or because a socket is. The descriptor and the size `fstat` gave for it are
 * then the authority for the type and the size; what happens to the path afterwards does not reach
 * the response. Reproduced through each route with the window held open by a hook around
 * `openSync` that does the swap itself, not by a natural race (钩子辅助复现).
 *
 * Only the last component is guarded (written residual, owner B1): a directory on the way to it
 * replaced by a symlink after the sandbox resolved the path is still followed by the open, and a
 * same-named regular file outside the workspace would be served (读代码推出; not tested and not
 * prevented — Node has no `openat`).
 */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { HttpError } from "../core/errors/index.js";

/** An opened regular file: the caller owns `fd` and closes it, or hands it to a stream that does. */
export interface RegularFile {
  fd: number;
  /** From the `fstat` of `fd`, not from any lstat of the path. */
  size: number;
}

/** Nothing at the path any more: the entry, or a directory on the way to it, is gone. */
export function isStructuralAbsence(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function openRegularFile(absPath: string): RegularFile {
  let fd: number;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const { code, errno } = error instanceof Error ? (error as NodeJS.ErrnoException) : {};
    if (
      isStructuralAbsence(error) ||
      code === "ELOOP" ||
      code === "ENXIO" ||
      // By number: Node has no name for macOS's EOPNOTSUPP and reports "Unknown system error".
      errno === -osConstants.errno.EOPNOTSUPP
    ) {
      throw new HttpError("not_found");
    }
    throw error;
  }
  try {
    // A pipe opens at once under O_NONBLOCK and is refused here, as are a directory and a device.
    const status = fstatSync(fd);
    if (!status.isFile()) {
      throw new HttpError("not_found");
    }
    return { fd, size: status.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
