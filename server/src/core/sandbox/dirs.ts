/**
 * core/sandbox dirs — 共享目录权限位（ADR-0010 / D3）。
 *
 * `ensureSharedDir`：同步受信绝对路径，逐级 mkdir，仅对本次新建的分量 chmod 0o2770，不改既有分量
 * （SANDBOX_ROOT 一侧）。`ensureOwnedDir`：单个目录，每次校正到精确 mode 并校验归属
 * （OMP_STATE_DIR 托管布局）。两者都不 chown、不改进程 umask；组归属由部署 setgid 继承。
 */

import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";

const SHARED_DIR_MODE = 0o2770;

export function ensureSharedDir(absPath: string): void {
  let start = 1;
  while (start <= absPath.length) {
    const slash = absPath.indexOf("/", start);
    const current = slash === -1 ? absPath : absPath.slice(0, slash);
    start = slash === -1 ? absPath.length + 1 : slash + 1;
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (!statSync(current).isDirectory()) {
        throw error;
      }
      continue;
    }
    chmodSync(current, SHARED_DIR_MODE);
  }
}

/**
 * 托管目录：非递归建出 `absPath`（父目录必须已在），要求它是本进程 uid 持有的目录（符号链接与
 * 其它类型一律拒绝、不跟随），并把 `mode & 0o7777` 校正到精确的 `mode`。新建时 `mkdir` 直接带
 * 目标权限位（umask 只会再收窄），不经过一个更宽的中间状态。校正后复查：内核静默丢掉 setgid
 * （本进程不在该目录的组里）同样是失败。
 */
export function ensureOwnedDir(absPath: string, mode: number): void {
  const fail = (reason: string, cause?: unknown): never => {
    throw new Error(`managed directory ${absPath} (mode 0o${mode.toString(8)}): ${reason}`, {
      cause,
    });
  };
  try {
    mkdirSync(absPath, mode & 0o777);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      fail("cannot be created", error);
    }
  }
  const modeOf = (): number => {
    const stats = lstatSync(absPath);
    if (!stats.isDirectory()) {
      fail("is not a directory");
    }
    if (stats.uid !== process.geteuid?.()) {
      fail("is not owned by this process");
    }
    return stats.mode & 0o7777;
  };
  if (modeOf() === mode) {
    return;
  }
  try {
    chmodSync(absPath, mode);
  } catch (error) {
    fail("mode cannot be set", error);
  }
  if (modeOf() !== mode) {
    fail("mode was not applied");
  }
}
