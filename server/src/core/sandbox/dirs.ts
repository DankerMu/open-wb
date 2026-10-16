/**
 * core/sandbox dirs — 共享目录权限位（ADR-0010 / D3）。
 *
 * `ensureSharedDir`：同步受信绝对路径，逐级 mkdir，仅对本次新建的分量 chmod 0o2770，不改既有分量
 * （SANDBOX_ROOT 一侧）。`ensureOwnedDir`：单个目录，每次校正到精确 mode 并校验归属
 * （OMP_STATE_DIR 托管布局）。`ensureOwnedFile`：同一语义的单个普通文件，内容不管。
 * 三者都不 chown、不改进程 umask；组归属由部署 setgid 继承。
 *
 * `ensureSandboxRoot`：`SANDBOX_ROOT` 自身（change sandbox-boundary-closure，owner B2/B3/B4）。启动的
 * `sandbox_root` 阶段建出并经 `ensureOwnedDir` 校正为精确 `0o3770`。粘滞位的用意：omp uid 在根下
 * 只能新建自己的条目，不能改名或删除应用 uid 建出的 `.trash` 与账号根——这是 POSIX 粘滞目录的语义，
 * 本仓库的用例只钉住 mode 位，没有在 uid 分离的 Linux 上实测改名被拒（读代码推出）。根之下的分量
 * 仍由 `ensureSharedDir` 惰性建出。
 */

import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";

const SHARED_DIR_MODE = 0o2770;
/** setgid + sticky: the `<state>/home` precedent (omp-runtime「OMP_STATE_DIR 托管布局」). */
const SANDBOX_ROOT_MODE = 0o3770;

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
 * 沙箱根（sandbox-core「沙箱根目录」）：缺失时递归建出它与缺失的父级（父级权限位不改），取内核
 * realpath（根可以是运维放置的、指向目录的符号链接；配置值照旧交给 store 与 spawn），不是目录即抛，
 * 再以 `ensureOwnedDir(root, 0o3770)` 校正属主与精确 mode。校正失败（属别的 uid、chmod 被拒、复查
 * 发现 setgid 被内核丢掉）：`strict`（`OMP_USER` 已配置）原样抛出；否则返回 `unchanged`、不再
 * chmod——已落下的权限位也不回滚（B3：同 uid 模式不纠正，回滚也是纠正）。不碰根之下任何条目。
 */
export function ensureSandboxRoot(
  configuredPath: string,
  options: { strict: boolean },
): { root: string; outcome: "ok" | "unchanged" } {
  mkdirSync(configuredPath, { recursive: true });
  const root = realpathSync.native(configuredPath);
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`sandbox root ${root}: is not a directory`);
  }
  try {
    ensureOwnedDir(root, SANDBOX_ROOT_MODE);
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return { root, outcome: "unchanged" };
  }
  return { root, outcome: "ok" };
}

/**
 * 托管目录：非递归建出 `absPath`（父目录必须已在），要求它是本进程 uid 持有的目录（符号链接与
 * 其它类型一律拒绝、不跟随），并把 `mode & 0o7777` 校正到精确的 `mode`。新建时 `mkdir` 直接带
 * 目标权限位（umask 只会再收窄），不经过一个更宽的中间状态。校正后复查：内核静默丢掉 setgid
 * （本进程不在该目录的组里）同样是失败。
 */
export function ensureOwnedDir(absPath: string, mode: number): void {
  ensureOwned("directory", absPath, mode, () => mkdirSync(absPath, mode & 0o777));
}

/**
 * 托管文件：`absPath` 缺失时建为空文件（父目录必须已在），要求它是本进程 uid 持有的普通文件
 * （符号链接与其它类型一律拒绝、不跟随），并把 `mode & 0o7777` 校正到精确的 `mode`。既有内容
 * 不读取、不截断、不改写。新建时 `open` 直接带目标权限位，不经过一个更宽的中间状态。
 */
export function ensureOwnedFile(absPath: string, mode: number): void {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
  ensureOwned("file", absPath, mode, () =>
    closeSync(openSync(absPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)),
  );
}

/** `create` 的 `EEXIST` 不是错误；其后以 `lstat` 校验类型与归属，mode 不符时 chmod 并复查。 */
function ensureOwned(
  kind: "directory" | "file",
  absPath: string,
  mode: number,
  create: () => void,
): void {
  const fail = (reason: string, cause?: unknown): never => {
    throw new Error(`managed ${kind} ${absPath} (mode 0o${mode.toString(8)}): ${reason}`, {
      cause,
    });
  };
  try {
    create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      fail("cannot be created", error);
    }
  }
  const modeOf = (): number => {
    const stats = lstatSync(absPath);
    if (!(kind === "directory" ? stats.isDirectory() : stats.isFile())) {
      fail(kind === "directory" ? "is not a directory" : "is not a regular file");
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
