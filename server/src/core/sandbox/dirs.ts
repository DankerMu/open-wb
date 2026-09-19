/**
 * core/sandbox dirs — 共享目录权限位（ADR-0010 / D3）。
 *
 * 同步受信绝对路径：逐级 mkdir，仅对本次新建的分量 chmod 0o2770。
 * 不 chown、不改进程 umask、不改既有分量。组归属由部署 setgid 继承。
 */

import { chmodSync, mkdirSync, statSync } from "node:fs";

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
