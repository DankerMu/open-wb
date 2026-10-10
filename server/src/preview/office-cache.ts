/**
 * 办公文档转换的缓存与两个清理函数（office-preview「转换缓存」；design D17、D18，owner D-24）。
 *
 * 缓存包在单次转换（`office.ts`）外面，不改它：结果在 `<cacheDir>/pdf/<键>.pdf`，命中只把修改时间
 * 更新为当前时刻，不启动进程；未命中才转换。转换器交回的已经是本进程自己新建的副本
 * `pdf/<随机名>.pdf`（`0600`，从作业输出的 fd 复制而来），这里只在 `pdf/` 之内把它改名成键——
 * 作业目录里的输出从不被改名进缓存。失败的转换什么都不留，也不记在内存里。同一个键的并发未命中
 * 各转一次，后到的改名原子覆盖先到的；并发上限、排队与去重不在这里。
 *
 * 清理函数永不 reject，本模块不建定时器，顶层没有副作用：何时调用由入口决定。`clearWork` 在同时
 * 提供 `ompUser` 与 `officeBin` 时先以该用户执行一条参数逐项固定的 `sudo … find … -delete`——
 * LibreOffice 在作业目录下建的 `profile`、`.cache` 属该用户，本进程删不掉；这是一条提权命令，
 * argv 里除构造时给定的 `ompUser` 与 `cacheDir` 外没有任何变量。它失败只记一条不带路径的日志。
 *
 * 没有闭合的窗口（读代码推出，没有实测）：
 * - 键取自 `lstat` 那一刻，转换进程随后才按路径读输入；其间输入被改写，旧键下存进的就是新内容。
 * - 本进程对 `work/`（`2770`、无 sticky，omp 用户可写）的递归删除按路径进行：顶层条目与其内部任何
 *   一级都可在检查之后被该用户的存活进程换成符号链接（`office.ts` 的 `removeJob` 同类）。Node 原生
 *   `rmSync` 递归途中是否跟随它取决于运行时版本（仓库只为开发与 CI 钉了版本），这里没有核实。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { lstat, readdir, rename, unlink, utimes } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertSafeSudoPath } from "../core/process-path.js";
import { OfficeConvertError, type OfficeConverter, type OfficeSpawn } from "./office.js";

/** sudoers 规则里逐字写的那条路径；不经 `PATH` 查找。 */
const FIND_PATH = "/usr/bin/find";
/** `pdf/` 下的文件超过这么久没有被命中就清掉；写死，不是配置项。 */
const PDF_RETENTION_MS = 7 * 86_400_000;
const BAD_PATHS = "cacheDir and officeBin must be absolute paths";

/**
 * `sha256(<absInput 的 UTF-8> 0x00 <mtimeMs 的十进制> 0x00 <size 的十进制>)` 的小写十六进制，
 * `mtimeMs` 与 `size` 取自此刻对输入的 `lstat`（纳秒级文件系统上 `mtimeMs` 带小数，原样写入）。
 * `lstat` 失败时以它的错误 reject——那个 message 带路径，调用方不得原样交给请求方。
 */
export async function officeCacheKey(absInput: string): Promise<string> {
  const { mtimeMs, size } = await lstat(absInput);
  return createHash("sha256")
    .update(`${absInput}\0${String(mtimeMs)}\0${String(size)}`, "utf8")
    .digest("hex");
}

/** 命中：大小大于 0 的普通文件（`lstat`，符号链接不算）。命中即把修改时间更新为当前时刻。 */
async function touchIfCached(slot: string): Promise<boolean> {
  try {
    const stats = await lstat(slot);
    if (!stats.isFile() || stats.size === 0) {
      return false;
    }
    const now = new Date();
    await utimes(slot, now, now);
    return true;
  } catch {
    // 不存在，或刚好被周期清理删掉：按未命中处理，重新转换。
    return false;
  }
}

/** 与 `OfficeConverter` 同形，包在它外面；`cacheDir` 必须就是构造 `converter` 时给的那一个。 */
export function createOfficeCache(options: {
  cacheDir: string;
  converter: OfficeConverter;
}): OfficeConverter {
  const { cacheDir, converter } = options;
  if (!isAbsolute(cacheDir)) {
    throw new Error(BAD_PATHS);
  }
  const pdfDir = join(cacheDir, "pdf");
  let closed = false;

  async function cached(absInput: string, signal?: AbortSignal): Promise<string> {
    let key: string;
    try {
      key = await officeCacheKey(absInput);
    } catch {
      throw new OfficeConvertError("failed");
    }
    const slot = join(pdfDir, `${key}.pdf`);
    if (await touchIfCached(slot)) {
      return slot;
    }
    // 失败原样上抛：此时 pdf/ 里没有这次转换的任何文件，下一次调用重新转换。
    const produced = await converter.convert(absInput, signal);
    try {
      await rename(produced, slot);
    } catch {
      await unlink(produced).catch(() => undefined);
      throw new OfficeConvertError("failed");
    }
    return slot;
  }

  return {
    available: converter.available,
    convert(absInput, signal) {
      // 这四种情况不看缓存、不碰输入，交给转换器按契约的次序给出 unavailable / aborted / failed。
      if (!converter.available || closed || signal?.aborted === true || !isAbsolute(absInput)) {
        return converter.convert(absInput, signal);
      }
      return cached(absInput, signal);
    },
    close() {
      closed = true;
      return converter.close();
    },
  };
}

/** 本进程自己的删除：`work` 下逐项递归删，一项删不掉不挡其余；`work` 自身不删。 */
function removeOwnEntries(work: string): void {
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      // 顶层条目是符号链接时删的是链接本身。`force` 不保证不抛：0500 的非空子目录照样 EACCES。
      rmSync(join(work, name), { recursive: true, force: true });
    } catch {
      // 属 omp 用户的残留：留到下一次启动。
    }
  }
}

export function createOfficeCleanup(options: {
  cacheDir: string;
  /** 与 `ompUser` 同时提供时，`clearWork` 才执行 `sudo … find`。它本身不被执行。 */
  officeBin?: string;
  ompUser?: string;
  /** 测试 seam，与转换器的是同一个；缺省为 `node:child_process` 的 `spawn`。 */
  spawn?: OfficeSpawn;
  /** `sudo … find` 失败时恰调一次；记录没有其它键。缺省不记。 */
  log?: (record: { event: "preview_work_clear_failed" }) => void;
}): {
  /** 启动时调用一次，先于转换器受理第一次转换。 */
  clearWork(): Promise<void>;
  /** 删除 `pdf/` 下修改时间早于 `now − 7 天` 的普通文件；恰在界上的留着。 */
  sweepPdf(now: number): Promise<void>;
} {
  const { cacheDir, officeBin, ompUser, log } = options;
  if (!isAbsolute(cacheDir) || (officeBin !== undefined && !isAbsolute(officeBin))) {
    throw new Error(BAD_PATHS);
  }
  const spawnImpl = options.spawn ?? (spawn as OfficeSpawn);
  const work = join(cacheDir, "work");
  const pdfDir = join(cacheDir, "pdf");

  /**
   * 以 `user` 的身份删掉 `work` 下它自己的条目，等命令结束。只有以退出码 0 结束才是 `true`；
   * `PATH` 检查不过、spawn 抛出或失败、非 0 退出、被信号结束都是 `false`。
   */
  function runSudoFind(user: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // `sudo` 经 PATH 查找：与转换的 spawn 同一个检查，不过就不启动。
        const env: Record<string, string> = { PATH: assertSafeSudoPath(process.env.PATH) };
        if (process.env.LANG !== undefined) {
          env.LANG = process.env.LANG;
        }
        // sudoers 按字面比对这一行，逐项固定、没有通配、不经 shell。cwd 为 `/`：GNU find 退出前
        // 要回到初始目录，omp 用户进不去服务端的工作目录时它会把已完成的删除报成失败。
        const child = spawnImpl(
          "sudo",
          ["-n", "-u", user, "--", FIND_PATH, work, "-mindepth", "1", "-delete"],
          { cwd: "/", env, stdio: "ignore", shell: false },
        );
        child.once("exit", (code) => resolve(code === 0));
        // 没有 pid 的 error 是 spawn 失败，不会再有 exit。
        child.on("error", () => {
          if (child.pid === undefined) {
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  }

  return {
    async clearWork() {
      // 没有 officeBin 就没有转换器，work 下不会有属 omp 用户的东西：不提权。
      if (ompUser !== undefined && officeBin !== undefined && !(await runSudoFind(ompUser))) {
        try {
          log?.({ event: "preview_work_clear_failed" });
        } catch {
          // 日志写不出去不该挡住启动。
        }
      }
      removeOwnEntries(work);
    },
    async sweepPdf(now) {
      const limit = now - PDF_RETENTION_MS;
      let names: string[];
      try {
        names = await readdir(pdfDir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(pdfDir, name);
        try {
          // `lstat`：目录与符号链接不碰。崩溃遗留的随机名副本也是普通文件，同样到期清掉。
          const stats = await lstat(path);
          if (stats.isFile() && stats.mtimeMs < limit) {
            await unlink(path);
          }
        } catch {
          // 留给下一轮。
        }
      }
    },
  };
}
