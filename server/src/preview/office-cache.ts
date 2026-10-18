/**
 * 办公文档转换的缓存与两个清理函数（office-preview「转换缓存与作业目录清理」；design D17、D18，
 * owner D-24；change office-convert-sandbox design D6）。
 *
 * 缓存包在单次转换（`office.ts`）外面，不改它：结果在 `<cacheDir>/pdf/<键>.pdf`，命中只把修改时间
 * 更新为当前时刻，不写 spool；未命中才转换。转换器交回的已经是本进程自己新建的副本
 * `pdf/<随机名>.pdf`（`0600`，从作业输出的 fd 复制而来），这里只在 `pdf/` 之内把它改名成键——
 * 作业目录里的输出从不被改名进缓存。失败的转换什么都不留，也不记在内存里。
 *
 * 未命中的路径经 `office-queue.ts`（office-preview「并发上限与排队」）：同一个键的并发未命中共用
 * 一次「转换 + 改名」，改名在共用的任务之内——每个调用方各自改名的话，只有第一个找得到那个随机
 * 名。算键与查命中都是同步的 `lstat`，`convert()` 在把调用交给队列之前没有 `await`：到达次序就是
 * 调用次序。命中不进队列，队满时照常返回。
 *
 * 清理函数永不 reject，本模块不建定时器，顶层没有副作用：何时调用由入口决定。`clearWork` 由本进程
 * 递归删 `<spoolDir>/jobs` 下的条目（`jobs` 自身不删；未提供 `spoolDir` 即不碰 spool），不启动任何
 * 子进程、不提权：sidecar 与本进程同 uid（change office-convert-sandbox design D6），作业目录里没有
 * 本进程删不掉的东西（`0500` 的非空目录这类本进程自己也删不掉的除外，留到下一次启动）。
 *
 * 没有闭合的窗口（第一条读代码推出，没有实测）：
 * - 键取自 `lstat` 那一刻，转换器随后才以 `openRegularFile` 打开输入、复制字节；其间输入被改写，旧键
 *   下存进的就是新内容。排队把这段间隔拉长了：键在到达时取，复制在轮到这一组时才发生，最坏约
 *   `ceil(8 / concurrency) × timeoutMs`（读代码推出，没有实测）。
 * - 本进程对 `jobs/` 的递归删除交给 `rmSync`：顶层条目与其内部任何一级都可在检查之后被同 uid 的
 *   sidecar 里的存活进程换成符号链接。已在钉定的 Node 24.13.1（官方 Linux 构建）上核实不跟随。strace
 *   跟的是一次参数与这里相同的裸 `rmSync`：顶层按路径打开（`openat(AT_FDCWD, <路径>, …O_NOFOLLOW|
 *   O_DIRECTORY)`），最后对它的 `rmdir` 也按路径；其下各级才是 `openat`（父目录描述符 + 名字，
 *   `O_NOFOLLOW|O_DIRECTORY`）再 `unlinkat`，按描述符。经真实的 `clearWork`，预先放好的顶层与嵌套
 *   链接都只删掉链接本身（`office-cache.test.ts`，实测）；删除途中换入没有测过。这是该运行时版本的
 *   实现，不是 Node 的承诺（仓库只为开发与 CI 钉了版本）：仍登记在此，换版本须重新核实。
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { OfficeConvertError, type OfficeConverter } from "./office.js";
import { createOfficeQueue } from "./office-queue.js";

/** `pdf/` 下的文件超过这么久没有被命中就清掉；写死，不是配置项。 */
const PDF_RETENTION_MS = 7 * 86_400_000;
const BAD_PATHS = "cacheDir and spoolDir must be absolute paths";

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

/** 本进程自己的删除：`jobs` 下逐项递归删，一项删不掉不挡其余；`jobs` 自身不删。 */
function removeOwnEntries(jobs: string): void {
  let names: string[];
  try {
    names = readdirSync(jobs);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      // 顶层条目是符号链接时删的是链接本身。`force` 不保证不抛：0500 的非空子目录照样 EACCES。
      rmSync(join(jobs, name), { recursive: true, force: true });
    } catch {
      // 留到下一次启动。
    }
  }
}

export function createOfficeCleanup(options: {
  cacheDir: string;
  /** 与 sidecar 共享的 spool；只在配置了 `OFFICE_SPOOL_DIR` 且启动预检通过时由入口提供。 */
  spoolDir?: string;
}): {
  /** 启动时调用一次，先于转换器受理第一次转换：清空 `<spoolDir>/jobs`。 */
  clearWork(): Promise<void>;
  /** 删除 `pdf/` 下修改时间早于 `now − 7 天` 的普通文件；恰在界上的留着。 */
  sweepPdf(now: number): Promise<void>;
} {
  const { cacheDir, spoolDir } = options;
  if (!isAbsolute(cacheDir) || (spoolDir !== undefined && !isAbsolute(spoolDir))) {
    throw new Error(BAD_PATHS);
  }
  const pdfDir = join(cacheDir, "pdf");

  return {
    async clearWork() {
      if (spoolDir !== undefined) {
        removeOwnEntries(join(spoolDir, "jobs"));
      }
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
