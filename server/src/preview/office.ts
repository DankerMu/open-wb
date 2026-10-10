/**
 * 办公文档转换器（office-preview「转换器调用契约」；design D17、D18）：每次转换在自己的作业目录
 * `<cacheDir>/work/<随机名>` 里启动一个无界面的 office 进程，把它写出的 PDF 复制成本进程自己的
 * 新文件 `<cacheDir>/pdf/<随机名>.pdf` 后删掉作业目录。
 *
 * 被转换的是不可信文档：子进程环境只有 `PATH`、`LANG`、`HOME`，不继承 `process.env`；配置了
 * `ompUser` 时经 `sudo … setpriv --pdeathsig KILL --` 以该用户运行，前置检查不过就是失败，从不
 * 回退为同 uid 启动。终止在途转换不新增任何提权规则：同 uid 模式杀进程组，`ompUser` 模式只杀
 * 自己启动的 `sudo`。后者杀不到 LibreOffice 包装脚本再派生的 `soffice.bin`：它每次都留下，把整份
 * 转换跑完才自行退出（实测最长在终止之后 128 秒），又不占转换名额，所以实际同时运行的转换进程
 * 可以多于配置的并发上限——已登记的残余（design D18、owner D-25）。
 *
 * `work/` 与 `pdf/` 由调用方建好，本模块不 mkdir 它们。这里只有单次转换：缓存键、命中与两个清理
 * 函数在包在外面的 `office-cache.ts`，并发上限与排队不在这两个文件里。
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, createWriteStream, rmSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, parse } from "node:path";
import { pipeline } from "node:stream/promises";
import { assertSafeSudoPath, assertSetprivExecutable, SETPRIV_PATH } from "../core/process-path.js";
import { ensureOwnedDir } from "../core/sandbox/dirs.js";

const JOB_DIR_MODE = 0o2770;
const RANDOM_NAME_BYTES = 16;
/** 输出 PDF 的大小上限，200 MiB；写死，不是配置项。 */
const OUTPUT_LIMIT_BYTES = 209_715_200;

type OfficeConvertErrorKind = "unavailable" | "failed" | "timeout" | "aborted";

/** 只带种类：`message` 恒等于 `kind`，不带子进程输出、路径、环境或底层错误。 */
export class OfficeConvertError extends Error {
  readonly kind: OfficeConvertErrorKind;

  constructor(kind: OfficeConvertErrorKind) {
    super(kind);
    this.name = "OfficeConvertError";
    this.kind = kind;
  }
}

/** 与 `node:child_process` 的 `spawn` 同形；标准流全部丢弃，所以返回的是没有流的 `ChildProcess`。 */
export type OfficeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface OfficeConverterOptions {
  /** 配置里给出的受信绝对路径；缺席即功能关闭。 */
  officeBin?: string;
  /** 其下的 `work/`（`2770`）与 `pdf/`（`0700`）必须已经存在。 */
  cacheDir: string;
  timeoutMs: number;
  /** 存在时转换进程以该系统用户运行（ADR-0010）。 */
  ompUser?: string;
  /** 测试 seam；缺省为 `node:child_process` 的 `spawn`。 */
  spawn?: OfficeSpawn;
}

export interface OfficeConverter {
  readonly available: boolean;
  /** `absInput` 是调用方已经过 `sandbox.resolve` 的绝对路径。成功时落定为 `pdf/` 下的新文件。 */
  convert(absInput: string, signal?: AbortSignal): Promise<string>;
  /** 终止全部在途转换并等它们落定；幂等。其后的 `convert` 以 `aborted` 失败。 */
  close(): Promise<void>;
}

type StopReason = "timeout" | "aborted";
/** 子进程一侧的结局；只有 `exited-zero` 才去看输出。 */
type ChildOutcome = "exited-zero" | "failed" | StopReason;

interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 同 uid 模式才是 `true`：新进程组，终止时整组杀。 */
  ownGroup: boolean;
}

function randomName(): string {
  return randomBytes(RANDOM_NAME_BYTES).toString("hex");
}

/** argv 与环境只在这里拼：`UserInstallation`、`--outdir`、`HOME` 都落在同一个作业目录下。 */
function buildLaunch(
  officeBin: string,
  ompUser: string | undefined,
  job: string,
  absInput: string,
): Launch {
  const officeArgs = [
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--nofirststartwizard",
    `-env:UserInstallation=file://${job}/profile`,
    "--convert-to",
    "pdf",
    "--outdir",
    join(job, "out"),
    absInput,
  ];
  // 新对象，不是 process.env 的副本：父进程持有的上游密钥、数据库路径一个都不带过去。
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: job };
  if (process.env.LANG !== undefined) {
    env.LANG = process.env.LANG;
  }
  if (ompUser === undefined) {
    return { command: officeBin, args: officeArgs, env, ownGroup: true };
  }
  // sudoers 放行的就是这一行的形状；sudo 一死，内核经 pdeathsig 杀掉 setpriv exec 出来的进程。
  const identity = ["-n", "-u", ompUser, "--preserve-env=PATH,LANG,HOME", "--"];
  const launcher = [SETPRIV_PATH, "--pdeathsig", "KILL", "--", officeBin];
  return { command: "sudo", args: [...identity, ...launcher, ...officeArgs], env, ownGroup: false };
}

/**
 * 终止只有这一处。还活着且有正整数 pid 才发信号：spawn 失败时 `pid` 是 `undefined`，绝不能落成
 * `kill(0)`（那是本进程自己的进程组）；已退出的 pid 可能已被别的进程复用。
 * 同 uid 模式对进程组发 `SIGKILL`；`ompUser` 模式只对自己启动的 `sudo` 发，不再起任何进程。
 */
function terminate(child: ChildProcess, ownGroup: boolean): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (ownGroup) {
      process.kill(-pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // 信号没送到（进程组刚好已经不在）：结局仍由 exit 事件给出。
  }
}

/**
 * 成功判定与复制用同一个 fd：`O_NOFOLLOW` 打开（符号链接即失败）、`fstat` 为大小大于 0 的普通
 * 文件，再从这个 fd 读出、写进独占创建的 `0600` 新文件。不做「先 `lstat` 再按路径复制」——
 * `ompUser` 模式下两步之间输出可以被换成符号链接。`O_NONBLOCK` 让命名管道的 open 立即返回。
 *
 * 复制的字节数以这次 `fstat` 的 `size` 为准：超过上限的一个字节都不读；只读前 `size` 个字节，
 * 此后追加的不读（还活着的后代可以一直往里写）；读到的不足 `size`（取得大小之后被截短）即失败。
 * 任何一步不成立都返回 `null`。
 */
async function collectOutput(
  job: string,
  absInput: string,
  pdfDir: string,
): Promise<string | null> {
  const produced = join(job, "out", `${parse(basename(absInput)).name}.pdf`);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  let source: Awaited<ReturnType<typeof open>>;
  try {
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
    // `end` 是闭区间的末位。文件比它短时读流正常结束、不报错，所以读完还要比对字节数。
    const reader = source.createReadStream({ autoClose: false, start: 0, end: size - 1 });
    try {
      await pipeline(reader, createWriteStream(copy, { flags: "wx", mode: 0o600 }));
      if (reader.bytesRead !== size) {
        throw new Error("short read");
      }
    } catch {
      // 半截的副本不留在 pdf/ 里；名字是本次调用刚取的随机数，不会是别人的文件。
      await unlink(copy).catch(() => undefined);
      return null;
    }
    return copy;
  } catch {
    return null;
  } finally {
    await source.close().catch(() => undefined);
  }
}

/** 删除失败不改变结果：`ompUser` 模式下属于该用户的残留删不掉，留给启动时对 `work/` 的清空。 */
function removeJob(job: string): void {
  try {
    rmSync(job, { recursive: true, force: true });
  } catch {
    // 见上。
  }
}

export function createOfficeConverter(options: OfficeConverterOptions): OfficeConverter {
  const { officeBin, cacheDir, timeoutMs, ompUser } = options;
  // 相对的 cacheDir 会随 cwd 漂移；officeBin 是 sudoers 规则里逐字写的那条路径，不经 PATH 查找。
  if (!isAbsolute(cacheDir) || (officeBin !== undefined && !isAbsolute(officeBin))) {
    throw new Error("cacheDir and officeBin must be absolute paths");
  }
  const spawnImpl = options.spawn ?? (spawn as OfficeSpawn);
  let closed = false;
  /** 在途子进程各自的终止函数，给 `close()` 用。 */
  const stoppers = new Set<(reason: StopReason) => void>();
  const inFlight = new Set<Promise<string>>();

  /** 启动并等到子进程落定（`exit`，或 spawn 失败的 `error`）；超时、中止、`close()` 都经 `stop`。 */
  function spawnAndWait(launch: Launch, job: string, signal?: AbortSignal): Promise<ChildOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnImpl(launch.command, launch.args, {
          cwd: job,
          env: launch.env,
          stdio: "ignore",
          shell: false,
          detached: launch.ownGroup,
        });
      } catch {
        resolve("failed");
        return;
      }
      let stopped: StopReason | undefined;
      let settled = false;
      const stop = (reason: StopReason): void => {
        if (stopped === undefined && !settled) {
          stopped = reason;
          terminate(child, launch.ownGroup);
        }
      };
      const onAbort = (): void => stop("aborted");
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const settle = (exitedZero: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stoppers.delete(stop);
        resolve(stopped ?? (exitedZero ? "exited-zero" : "failed"));
      };
      stoppers.add(stop);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("exit", (code) => settle(code === 0));
      // 没有 pid 的 error 是 spawn 失败，不会再有 exit；有 pid 的 error（信号没送到）不算落定，
      // 进程还在，继续等它的 exit。
      child.on("error", () => {
        if (child.pid === undefined) {
          settle(false);
        }
      });
    });
  }

  async function runOne(absInput: string, signal?: AbortSignal): Promise<string> {
    if (officeBin === undefined) {
      throw new OfficeConvertError("unavailable");
    }
    if (closed || signal?.aborted === true) {
      throw new OfficeConvertError("aborted");
    }
    // 输入是 argv 的最后一项：不是绝对路径（例如以 `-` 开头）会被 office 当成选项。
    if (!isAbsolute(absInput)) {
      throw new OfficeConvertError("failed");
    }
    if (ompUser !== undefined) {
      // 与 omp 的 spawn 同一组前置检查；抛错即失败，不启动、不回退。
      assertSafeSudoPath(process.env.PATH);
      assertSetprivExecutable();
    }
    const job = join(cacheDir, "work", randomName());
    try {
      ensureOwnedDir(job, JOB_DIR_MODE);
      const launch = buildLaunch(officeBin, ompUser, job, absInput);
      const outcome = await spawnAndWait(launch, job, signal);
      if (outcome !== "exited-zero") {
        throw new OfficeConvertError(outcome);
      }
      const pdf = await collectOutput(job, absInput, join(cacheDir, "pdf"));
      if (pdf === null) {
        throw new OfficeConvertError("failed");
      }
      return pdf;
    } finally {
      removeJob(job);
    }
  }

  /** 底层错误的 message 带路径（作业目录、setpriv）：一律换成只带种类的 `failed`。 */
  async function convertOnce(absInput: string, signal?: AbortSignal): Promise<string> {
    try {
      return await runOne(absInput, signal);
    } catch (error) {
      throw error instanceof OfficeConvertError ? error : new OfficeConvertError("failed");
    }
  }

  return {
    available: officeBin !== undefined,
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
