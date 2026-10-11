/**
 * 办公文档转换的缓存与两个清理函数（office-preview「转换缓存」；design D17、D18，owner D-24）。
 *
 * 缓存包在单次转换（`office.ts`）外面，不改它：结果在 `<cacheDir>/pdf/<键>.pdf`，命中只把修改时间
 * 更新为当前时刻，不启动进程；未命中才转换。转换器交回的已经是本进程自己新建的副本
 * `pdf/<随机名>.pdf`（`0600`，从作业输出的 fd 复制而来），这里只在 `pdf/` 之内把它改名成键——
 * 作业目录里的输出从不被改名进缓存。失败的转换什么都不留，也不记在内存里。
 *
 * 未命中的路径经 `office-queue.ts`（office-preview「并发上限与排队」）：同一个键的并发未命中共用
 * 一次「转换 + 改名」，改名在共用的任务之内——每个调用方各自改名的话，只有第一个找得到那个随机
 * 名。算键与查命中都是同步的 `lstat`，`convert()` 在把调用交给队列之前没有 `await`：到达次序就是
 * 调用次序。命中不进队列，队满时照常返回。
 *
 * 清理函数永不 reject，本模块不建定时器，顶层没有副作用：何时调用由入口决定。`clearWork` 在同时
 * 提供 `ompUser` 与 `officeBin` 时先以该用户执行一条参数逐项固定的 `sudo … find … -delete`——
 * LibreOffice 在作业目录下建的 `profile`、`.cache` 属该用户，本进程删不掉；这是一条提权命令，
 * argv 里除构造时给定的 `ompUser` 与 `cacheDir` 外没有任何变量。它失败只记一条不带路径的日志。
 *
 * 这条命令有界（owner D-26，design D18「启动清空的超时与终止」）：固定 10 秒未结束，或入口在关停时
 * 调用 `stopWorkClear()`，都对**自己启动的那个 `sudo`** 发 `SIGTERM`，2 秒内仍未退出再发 `SIGKILL`，
 * 按该命令失败处理（同一行日志，至多一行）；本进程自己的删除照常，不向启动抛出。sudoers 行不变，
 * 不新增任何提权面：应用用户处置的只是自己的子进程。证据等级——对假 `sudo`：实测（
 * `office-work-clear.test.ts`，被哪个信号结束、pid 不存在、日志行数）。对真实 `sudo`：先发 `SIGTERM`
 * 是因为 `sudo` 会把它收到的 `SIGTERM` 转给所运行的命令，而 `SIGKILL` 无法转发，这条命令又不经
 * `setpriv --pdeathsig`——**读 sudo 手册推出，未测**。`sudo` 结束之后它之下的 `find` 是否随之结束，
 * 只能在真实 Linux `sudo` 的 uid 分离部署上观察，**未测**：应用用户无权向 omp 用户的进程发信号，
 * `find` 若留下，本模块没有别的手段处置它，那时它仍在 `work/` 下删除。
 *
 * 没有闭合的窗口（第一条读代码推出，没有实测；第二条在 uid 分离的 Linux 测试部署上实测过）：
 * - 键取自 `lstat` 那一刻，转换进程随后才按路径读输入；其间输入被改写，旧键下存进的就是新内容。
 *   排队把这段间隔拉长了：键在到达时取，进程在轮到这一组时才启动，最坏约
 *   `ceil(8 / concurrency) × timeoutMs`（读代码推出，没有实测）。调用方在此之前做的路径检查到
 *   进程打开输入之间的间隔同样被拉长。
 * - 本进程对 `work/`（`2770`、无 sticky，omp 用户可写）的递归删除交给 `rmSync`：顶层条目与其内部
 *   任何一级都可在检查之后被该用户的存活进程换成符号链接（`office.ts` 的 `removeJob` 同类）。已在
 *   钉定的 Node 24.13.1（官方 Linux 构建）上核实不跟随。strace 跟的是一次参数与这里相同的裸
 *   `rmSync`，不是 `clearWork`：顶层按路径打开（`openat(AT_FDCWD, <路径>, …O_NOFOLLOW|O_DIRECTORY)`），
 *   最后对它的 `rmdir` 也按路径；其下各级才是 `openat`（父目录描述符 + 名字，
 *   `O_NOFOLLOW|O_DIRECTORY`）再 `unlinkat`，按描述符。经真实的 `clearWork`（不提供 `ompUser` 的
 *   分支，链接由 omp 用户以自己的 uid 放），预先放好的顶层与嵌套链接都只删掉链接本身；删除途中
 *   换入没有测过。这是该运行时版本的实现，不是 Node 的承诺（仓库只为开发与 CI 钉了版本）：仍登记
 *   在此，换版本须重新核实。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertSafeSudoPath } from "../core/process-path.js";
import { OfficeConvertError, type OfficeConverter, type OfficeSpawn, terminate } from "./office.js";
import { createOfficeQueue } from "./office-queue.js";

/** sudoers 规则里逐字写的那条路径；不经 `PATH` 查找。 */
const FIND_PATH = "/usr/bin/find";
/** `pdf/` 下的文件超过这么久没有被命中就清掉；写死，不是配置项。 */
const PDF_RETENTION_MS = 7 * 86_400_000;
/** 启动时那条 `sudo … find` 的时限（owner D-26）；写死，不是配置项。 */
const WORK_CLEAR_TIMEOUT_MS = 10_000;
/** `SIGTERM` 之后等这么久，仍未退出才发 `SIGKILL`。 */
const WORK_CLEAR_KILL_GRACE_MS = 2_000;
const BAD_PATHS = "cacheDir and officeBin must be absolute paths";

/**
 * `sha256(<absInput 的 UTF-8> 0x00 <mtimeMs 的十进制> 0x00 <size 的十进制>)` 的小写十六进制，
 * `mtimeMs` 与 `size` 取自此刻对输入的 `lstat`（纳秒级文件系统上 `mtimeMs` 带小数，原样写入）。
 * 同步：键是排队与去重的依据，必须在调用到达的那一拍里定下。`lstat` 失败时原样抛出它的错误——
 * 那个 message 带路径，调用方不得原样交给请求方。
 */
export function officeCacheKey(absInput: string): string {
  const { mtimeMs, size } = lstatSync(absInput);
  return createHash("sha256")
    .update(`${absInput}\0${String(mtimeMs)}\0${String(size)}`, "utf8")
    .digest("hex");
}

/**
 * 命中：大小大于 0 的普通文件（`lstat`，符号链接不算）。命中即把修改时间更新为当前时刻。
 * 同步，理由同上：同键的第二个调用不能在第一个入队之前越过这一步。
 */
function touchIfCached(slot: string): boolean {
  try {
    const stats = lstatSync(slot);
    if (!stats.isFile() || stats.size === 0) {
      return false;
    }
    const now = new Date();
    utimesSync(slot, now, now);
    return true;
  } catch {
    // 不存在，或刚好被周期清理删掉：按未命中处理，重新转换。
    return false;
  }
}

/**
 * 与 `OfficeConverter` 同形，包在它外面；`cacheDir` 必须就是构造 `converter` 时给的那一个。
 * `concurrency` 是同时运行的转换数上限，不是正整数即同步抛出固定 message 的普通错误。
 */
export function createOfficeCache(options: {
  cacheDir: string;
  converter: OfficeConverter;
  concurrency: number;
}): OfficeConverter {
  const { cacheDir, converter } = options;
  if (!isAbsolute(cacheDir)) {
    throw new Error(BAD_PATHS);
  }
  const queue = createOfficeQueue({ concurrency: options.concurrency });
  const pdfDir = join(cacheDir, "pdf");
  let closed = false;
  /** 已经启动、还没落定的共用任务，给 `close()` 等。 */
  const storing = new Set<Promise<string>>();

  /**
   * 一组同键调用共用的任务：转换，再把副本改名进键的位置。`signal` 是队列给这一组的内部信号。
   * 失败原样上抛：此时 pdf/ 里没有这次转换的任何文件，下一次调用重新转换。
   */
  async function convertInto(slot: string, absInput: string, signal: AbortSignal): Promise<string> {
    const produced = await converter.convert(absInput, signal);
    try {
      await rename(produced, slot);
    } catch {
      await unlink(produced).catch(() => undefined);
      throw new OfficeConvertError("failed");
    }
    return slot;
  }

  /** 从头到尾同步，没有 `await`：返回时这个调用已经命中、加入、启动、入队或被拒绝。 */
  function cached(absInput: string, signal?: AbortSignal): Promise<string> {
    let key: string;
    try {
      key = officeCacheKey(absInput);
    } catch {
      return Promise.reject(new OfficeConvertError("failed"));
    }
    const slot = join(pdfDir, `${key}.pdf`);
    if (touchIfCached(slot)) {
      return Promise.resolve(slot);
    }
    const task = (shared: AbortSignal): Promise<string> => {
      const run = convertInto(slot, absInput, shared);
      const forget = (): void => {
        storing.delete(run);
      };
      storing.add(run);
      run.then(forget, forget);
      return run;
    };
    return queue.run(key, task, signal);
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
    async close() {
      closed = true;
      // 先清队列：排队的组以 aborted 落定、一个都不启动；然后才终止在途的转换。
      queue.close();
      await converter.close();
      // 转换已经交回副本、正在改名的任务不归转换器管：等它们落定。
      await Promise.allSettled([...storing]);
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
  /** `sudo … find` 失败（含超时与被终止）时恰调一次；记录没有其它键。缺省不记。 */
  log?: (record: { event: "preview_work_clear_failed" }) => void;
  /** 测试 seam：`sudo … find` 的时限（毫秒）。入口不传，用固定的 10 秒。 */
  clearTimeoutMs?: number;
}): {
  /** 启动时调用一次，先于转换器受理第一次转换。 */
  clearWork(): Promise<void>;
  /**
   * 终止在途的那条 `sudo … find`（关停时调用）：`clearWork` 随后照常落定。没有在途的就什么都不做；
   * 可重复调用。
   */
  stopWorkClear(): void;
  /** 删除 `pdf/` 下修改时间早于 `now − 7 天` 的普通文件；恰在界上的留着。 */
  sweepPdf(now: number): Promise<void>;
} {
  const { cacheDir, officeBin, ompUser, log } = options;
  if (!isAbsolute(cacheDir) || (officeBin !== undefined && !isAbsolute(officeBin))) {
    throw new Error(BAD_PATHS);
  }
  const spawnImpl = options.spawn ?? (spawn as OfficeSpawn);
  const clearTimeoutMs = options.clearTimeoutMs ?? WORK_CLEAR_TIMEOUT_MS;
  const work = join(cacheDir, "work");
  const pdfDir = join(cacheDir, "pdf");
  /** 在途那条 `sudo … find` 的终止函数；没有在途的即 `undefined`。 */
  let stopInFlight: (() => void) | undefined;

  /**
   * 以 `user` 的身份删掉 `work` 下它自己的条目，等命令结束。只有没被本进程终止、以退出码 0 结束
   * 才是 `true`；`PATH` 检查不过、spawn 抛出或失败、非 0 退出、被信号结束、超时、被 `stopWorkClear`
   * 终止都是 `false`。只 resolve 一次，所以调用方至多记一行日志。
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
        let stopped = false;
        let killTimer: NodeJS.Timeout | undefined;
        // 超时与关停走同一处：先 SIGTERM（理由见头注释），到期仍在才 SIGKILL。只对自己启动的
        // `sudo` 发信号，守卫（pid 为正、尚未退出）是 `office.ts` 的那一份。
        const stop = (): void => {
          if (stopped) {
            return;
          }
          stopped = true;
          terminate(child, false, "SIGTERM");
          killTimer = setTimeout(
            () => terminate(child, false, "SIGKILL"),
            WORK_CLEAR_KILL_GRACE_MS,
          );
        };
        const timer = setTimeout(stop, clearTimeoutMs);
        const settle = (succeeded: boolean): void => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          stopInFlight = undefined;
          resolve(succeeded);
        };
        stopInFlight = stop;
        child.once("exit", (code) => settle(!stopped && code === 0));
        // 没有 pid 的 error 是 spawn 失败，不会再有 exit。
        child.on("error", () => {
          if (child.pid === undefined) {
            settle(false);
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
    stopWorkClear() {
      stopInFlight?.();
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
