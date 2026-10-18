/**
 * 办公文档转换器的 app 一侧（office-preview「sidecar 转换契约」；change office-convert-sandbox
 * design D3、D4）：本进程不启动任何转换进程。每次转换在 spool 里建一个作业目录，把输入的**字节**
 * 交给 `--network none`、只挂 spool 的转换 sidecar（`converter/`，协议的单一真相在
 * `converter/sidecar.mjs` 头注释），等它写回标记，再把它写出的 PDF 复制成本进程自己的新文件
 * `<cacheDir>/pdf/<随机名>.pdf`，最后删掉作业目录。
 *
 * 作业：`jobs/<32 hex>/`（`0700`）→ `in/<basename>`（`openRegularFile` 打开，从那个描述符恰复制 `size`
 * 字节，`wx`、`0600`）→ `request.json`（恰三键，先以 `wx` 写 `.part` 再 `rename`）→ 每 `pollMs` 看 `done`
 * / `failed`。超时、中止与 `close()` 都写 `cancel`（sidecar 看到它或目录已不在都杀整组）。写 `cancel` 与
 * `.part` 之前作业目录先经 `realDir` 核对不是链接；核对与写入之间的窗口是一次系统调用间隔，不是零（读
 * 代码推出）。app 一侧的任何路径都不进 spool：输入只以 basename 出现，`request.json` 里没有路径字段。
 *
 * 不再有提权与杀进程：`OMP_USER` 不影响这里的任何一步，两种 uid 模式下对 spool 做的事完全相同。
 * 旧链的 D-25 残余（终止之后 `soffice.bin` 存活）在 sidecar 里预期不再出现——那里只有同 uid 杀进程组
 * 一种终止（读代码推出）；测试主机实测（S2b）之后由收尾切片按观察改写本段。
 *
 * 每次转换前看一次心跳（`office-sidecar-health.ts`）：不新鲜即 `unavailable`、不碰 spool；从新鲜到
 * 不新鲜的第一次经注入的 `log` 写一行，再见新鲜才复位（边沿触发）。`jobs/` 与 `pdf/` 由调用方建好，
 * 本模块不 mkdir 它们。缓存键、命中与清理在 `office-cache.ts`，并发上限、排队与去重在
 * `office-queue.ts`（`busy` 只从那里来）。
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  type ReadStream,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, parse } from "node:path";
import { pipeline } from "node:stream/promises";
import { openRegularFile } from "../workspaces/regular-file.js";
import { HEARTBEAT_FRESH_MS, heartbeatFresh } from "./office-sidecar-health.js";

const JOB_DIR_MODE = 0o700;
const RANDOM_NAME_BYTES = 16;
const DEFAULT_POLL_MS = 100;
/** 输出 PDF 的大小上限，200 MiB；写死，不是配置项。 */
const OUTPUT_LIMIT_BYTES = 209_715_200;
const BAD_PATHS = "cacheDir and spoolDir must be absolute paths";

type OfficeConvertErrorKind = "unavailable" | "failed" | "timeout" | "aborted" | "busy";

/** 只带种类：`message` 恒等于 `kind`，不带路径、原因码或底层错误。 */
export class OfficeConvertError extends Error {
  readonly kind: OfficeConvertErrorKind;

  constructor(kind: OfficeConvertErrorKind) {
    super(kind);
    this.name = "OfficeConvertError";
    this.kind = kind;
  }
}

interface OfficeConverterOptions {
  /** 与 sidecar 共享的 spool（`OFFICE_SPOOL_DIR`，app 视角的绝对路径）；缺席即功能关闭。 */
  spoolDir?: string;
  /** 其下的 `pdf/`（`0700`）必须已经存在。 */
  cacheDir: string;
  timeoutMs: number;
  /** 看 `done` / `failed` 的间隔；缺省 100 毫秒，测试可注入。 */
  pollMs?: number;
  /** 心跳从新鲜变为不新鲜时调一次；记录只有 `event` 一个键。抛出被吞掉。 */
  log?: (record: { event: "office_convert_sidecar_unavailable" }) => void;
}

export interface OfficeConverter {
  readonly available: boolean;
  /** `absInput` 是调用方已经过 `sandbox.resolve` 的绝对路径。成功时落定为 `pdf/` 下的新文件。 */
  convert(absInput: string, signal?: AbortSignal): Promise<string>;
  /** 对全部在途作业写 `cancel` 并等它们落定；幂等。其后的 `convert` 以 `aborted` 失败。 */
  close(): Promise<void>;
}

type StopReason = "timeout" | "aborted";

function randomName(): string {
  return randomBytes(RANDOM_NAME_BYTES).toString("hex");
}

/**
 * 把 `reader`（只覆盖源的前 `size` 个字节）写进独占新建的 `0600` 文件 `target`：目标在调用的这一拍
 * 里同步建出（`wx`，已存在即失败）。读到的不足 `size`（取得大小之后被截短）即删掉副本、返回
 * `false`。`size` 为 0 时不读，只建空文件。
 */
async function copyExact(
  reader: (() => ReadStream) | undefined,
  size: number,
  target: string,
): Promise<boolean> {
  let created = false;
  try {
    const writer = createWriteStream(target, { fd: openSync(target, "wx", 0o600) });
    created = true;
    const source = reader?.();
    if (source === undefined) {
      writer.end();
      await new Promise<void>((resolve, reject) =>
        writer.once("close", resolve).once("error", reject),
      );
      return true;
    }
    await pipeline(source, writer);
    if (source.bytesRead !== size) {
      throw new Error("short read");
    }
    return true;
  } catch {
    // 半截的副本不留下；`target` 是本次调用刚建出的名字，不会是别人的文件。
    if (created) {
      await unlink(target).catch(() => undefined);
    }
    return false;
  }
}

/**
 * 成功判定与复制用同一个 fd：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开 `out/<去最后一个扩展名>.pdf`（符号
 * 链接即失败；命名管道的 open 立即返回，随后被 `fstat` 拒）、`fstat` 为大小大于 0、不超过上限的普通
 * 文件，再从这个 fd 恰复制 `size` 字节：超过上限的一个字节都不读，此后追加的不读；任何一步不成立都返回
 * `null`。`O_NOFOLLOW` 只管末段，作业目录与 `out/` 先经 `realDir` 核对；到 `open` 之间的换入是竞态残余。
 */
async function collectOutput(job: string, name: string, pdfDir: string): Promise<string | null> {
  const produced = join(job, "out", `${parse(name).name}.pdf`);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  let source: Awaited<ReturnType<typeof open>>;
  try {
    realDir(join(realDir(job), "out"));
    source = await open(produced, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = await source.stat();
    const { size } = stats;
    if (!stats.isFile() || size === 0 || size > OUTPUT_LIMIT_BYTES) {
      return null;
    }
    const copy = join(pdfDir, `${randomName()}.pdf`);
    // `end` 是闭区间的末位。文件比它短时读流正常结束、不报错，所以 `copyExact` 读完还要比对字节数。
    const reader = () => source.createReadStream({ autoClose: false, start: 0, end: size - 1 });
    return (await copyExact(reader, size, copy)) ? copy : null;
  } catch {
    return null;
  } finally {
    await source.close().catch(() => undefined);
  }
}

/** `lstat` 为目录（非链接）才交回原路径，否则抛：作业目录或 `out/` 被换成链接时 app 的读写不跟随进别处。 */
function realDir(path: string): string {
  if (!lstatSync(path).isDirectory()) {
    throw new Error("not a directory");
  }
  return path;
}

/** 删除失败不改变结果：sidecar 与本进程同 uid，删不掉的留给下一次启动对 `jobs/` 的清空。 */
function removeJob(job: string): void {
  try {
    rmSync(job, { recursive: true, force: true });
  } catch {
    // 见上。
  }
}

export function createOfficeConverter(options: OfficeConverterOptions): OfficeConverter {
  const { spoolDir, cacheDir, timeoutMs, log } = options;
  // 相对路径会随 cwd 漂移。
  if (!isAbsolute(cacheDir) || (spoolDir !== undefined && !isAbsolute(spoolDir))) {
    throw new Error(BAD_PATHS);
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let closed = false;
  /** 心跳上一次被判为不新鲜且已经记过一行：再见新鲜才复位。 */
  let staleReported = false;
  /** 在途作业各自的终止函数，给 `close()` 用。 */
  const stoppers = new Set<(reason: StopReason) => void>();
  const inFlight = new Set<Promise<string>>();

  /** 不碰 spool 的判定（次序即优先级），最后看心跳：不新鲜即 `unavailable`，边沿那一行写失败不影响结果。 */
  function admit(absInput: string, signal?: AbortSignal): string {
    if (spoolDir === undefined) {
      throw new OfficeConvertError("unavailable");
    }
    if (closed || signal?.aborted === true) {
      throw new OfficeConvertError("aborted");
    }
    if (!isAbsolute(absInput)) {
      throw new OfficeConvertError("failed");
    }
    if (heartbeatFresh(spoolDir, { freshMs: HEARTBEAT_FRESH_MS })) {
      staleReported = false;
      return spoolDir;
    }
    if (!staleReported) {
      staleReported = true;
      try {
        log?.({ event: "office_convert_sidecar_unavailable" });
      } catch {
        // 日志写不出去不改变这次转换的结果。
      }
    }
    throw new OfficeConvertError("unavailable");
  }

  /**
   * 一个作业的终止：时限到期、调用方中止、`close()` 都写 `cancel`（只一次，同步），记下原因并叫醒
   * 等待。从作业目录建出那一刻起生效：复制输入期间的终止同样写 `cancel`，随后不再写 `request.json`。
   */
  function track(job: string, signal?: AbortSignal) {
    let reason: StopReason | undefined;
    let wake = (): void => undefined;
    const stop = (why: StopReason): void => {
      if (reason === undefined) {
        reason = why;
        try {
          writeFileSync(join(realDir(job), "cancel"), "", { flag: "wx" });
        } catch {
          // 已经在（sidecar 只认它出现）、作业目录已不在或被换成了链接。
        }
        wake();
      }
    };
    const onAbort = (): void => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    stoppers.add(stop);
    return {
      stopped: () => reason,
      /** 每 `pollMs` 看一次 `done` / `failed`，直到其一出现或被终止；原因码不读。 */
      async wait(): Promise<"done" | "failed" | StopReason> {
        for (;;) {
          if (reason !== undefined) {
            return reason;
          }
          if (existsSync(join(job, "done"))) {
            return "done";
          }
          if (existsSync(join(job, "failed"))) {
            return "failed";
          }
          await new Promise<void>((resolve) => {
            const tick = setTimeout(resolve, pollMs);
            wake = () => {
              clearTimeout(tick);
              resolve();
            };
          });
        }
      },
      dispose(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stoppers.delete(stop);
      },
    };
  }

  async function runOne(absInput: string, signal?: AbortSignal): Promise<string> {
    const spool = admit(absInput, signal);
    // 在建作业目录之前打开：末段被换成符号链接、不是普通文件或已不在，都在这里失败。
    const input = openRegularFile(absInput);
    const name = basename(absInput);
    const job = join(spool, "jobs", randomName());
    let tracked: ReturnType<typeof track> | undefined;
    try {
      // 从这里到复制目标建出都是同步的：`convert` 返回之前作业目录与 `in/<名字>` 已经在。
      mkdirSync(job, JOB_DIR_MODE);
      mkdirSync(join(job, "in"), JOB_DIR_MODE);
      tracked = track(job, signal);
      const reader =
        input.size === 0
          ? undefined
          : () => createReadStream("", { fd: input.fd, autoClose: false, end: input.size - 1 });
      if (!(await copyExact(reader, input.size, join(job, "in", name)))) {
        throw new OfficeConvertError("failed");
      }
      const early = tracked.stopped();
      if (early !== undefined) {
        throw new OfficeConvertError(early);
      }
      const request = join(realDir(job), "request.json");
      const body = JSON.stringify({ version: 1, input: name, timeoutMs });
      writeFileSync(`${request}.part`, body, { flag: "wx" });
      renameSync(`${request}.part`, request);
      const outcome = await tracked.wait();
      if (outcome !== "done") {
        throw new OfficeConvertError(outcome);
      }
      const pdf = await collectOutput(job, name, join(cacheDir, "pdf"));
      if (pdf === null) {
        throw new OfficeConvertError("failed");
      }
      return pdf;
    } finally {
      tracked?.dispose();
      closeSync(input.fd);
      removeJob(job);
    }
  }

  /** 底层错误的 message 带路径（作业目录、输入）：一律换成只带种类的 `failed`。 */
  async function convertOnce(absInput: string, signal?: AbortSignal): Promise<string> {
    try {
      return await runOne(absInput, signal);
    } catch (error) {
      throw error instanceof OfficeConvertError ? error : new OfficeConvertError("failed");
    }
  }

  return {
    available: spoolDir !== undefined,
    convert(absInput, signal) {
      const run = convertOnce(absInput, signal);
      inFlight.add(run);
      const forget = (): void => {
        inFlight.delete(run);
      };
      run.then(forget, forget);
      return run;
    },
    async close() {
      closed = true;
      for (const stop of [...stoppers]) {
        stop("aborted");
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}
