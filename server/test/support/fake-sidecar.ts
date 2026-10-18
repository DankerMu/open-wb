/**
 * 进程内的假转换 sidecar（issue 1505；change office-convert-sandbox design D8）：app 侧的转换器、
 * 缓存、队列与编译入口测试对着它跑，不需要 Docker、LibreOffice 或子进程。**它不做任何隔离**：没有
 * 容器、没有网络命名空间、没有 uid 切换，只是测试进程里对 spool 做文件操作的应答器。
 *
 * 照 `converter/sidecar.mjs` 头注释的协议应答（领取有 `request.json`、没有标记的作业；标记先写
 * `.part` 再 `rename`）。输入名里的 `@标记`（词汇与 `fake-soffice.mjs` 同源）：无 / `named` →
 * `out/<去最后一个扩展名>.pdf` 后 `done`；`exit1` → PDF 后 `failed: exit`；`bad-request`；`empty` →
 * 0 字节后 `done`；`symlink` / `fifo` → 链接 / 无写端的命名管道后 `done`；`nopdf` → 无 `out/` 的
 * `done`；`sparse-limit` / `sparse-over` → 恰 200 MiB / 多 1 字节；`hang`（= `sleep`）→ PDF、无标记；
 * `gate` → PDF，`release(<输入名>)` 后 `done`。追加与截短由 output 测试的 `fstat` 探针在 app 侧做。
 *
 * 观察：递归 `fs.watch`（`jobs/` 出现后才挂）加 100 ms 轮询，记下发现次序、`in/` 的名字与字节、
 * 领取那一刻的全部文件、看到 `cancel` 的时刻（app 写完随即删目录，靠递归监听的事件：macOS 实测；
 * Linux 上未测，推算同样报出）。心跳：`fresh` 每 500 ms touch，`stale` 钉在 30 秒前，`none` 不写。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join, parse, relative } from "node:path";

/** 模块求值时取下的原函数：转换器测试数 `child_process` 的调用，夹具建命名管道不算进去。 */
const runFile = execFileSync;
/** 与 `fake-soffice.mjs` 各持一份的 PDF 字面量。 */
export const PDF =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const SPARSE: Record<string, number> = { "sparse-limit": 209_715_200, "sparse-over": 209_715_201 };
const HELD = ["hang", "sleep", "gate"];

export type Heartbeat = "fresh" | "stale" | "none";

export interface FakeJob {
  id: string;
  dir: string;
  /** `in/` 下的名字（发现时就读）与领取那一刻的字节。 */
  name?: string | undefined;
  bytes?: Buffer | undefined;
  /** `request.json` 原文与领取那一刻作业目录里每个普通文件（相对路径 → 字节）。 */
  request?: string | undefined;
  files: Record<string, Buffer>;
  cancelAt?: number | undefined;
  /** 写出的输出（相对作业目录）与应答：`done` 或 `failed:<原因码>`。 */
  output?: string;
  answer?: string;
}

export interface FakeSidecar {
  /** 同步扫一遍 `jobs/` 再交出至今发现的全部作业，按发现的次序。 */
  jobs(): FakeJob[];
  release(name: string): void;
  /** 下一个被领取的作业按这个标记应答，不看输入名；只用一次。 */
  next: string | undefined;
  heartbeat(mode: Heartbeat): void;
  stop(): void;
}

const running: FakeSidecar[] = [];

/** `afterEach` 用：停掉全部定时器与监听。 */
export function stopFakeSidecars(): void {
  for (const sidecar of running.splice(0)) {
    sidecar.stop();
  }
}

function mark(job: FakeJob, answer: string): void {
  const [file, content] = answer === "done" ? ["done", ""] : ["failed", answer];
  try {
    fs.writeFileSync(join(job.dir, `${file}.part`), content);
    fs.renameSync(join(job.dir, `${file}.part`), join(job.dir, file));
    job.answer = answer === "done" ? "done" : `failed:${answer}`;
  } catch {
    // 作业目录已被 app 删掉（与真 sidecar 吞掉同一个 ENOENT）。
  }
}

/** 按标记写输出；返回随后要写的标记，`undefined` 即先不写。 */
function produce(job: FakeJob, marker: string): string | undefined {
  if (marker === "bad-request" || marker === "nopdf") {
    return marker === "nopdf" ? "done" : marker;
  }
  fs.mkdirSync(join(job.dir, "out"), { recursive: true });
  const output = join(job.dir, "out", `${parse(job.name ?? "").name}.pdf`);
  job.output = relative(job.dir, output);
  writeOutput(job, marker, output);
  return HELD.includes(marker) ? undefined : marker === "exit1" ? "exit" : "done";
}

function writeOutput(job: FakeJob, marker: string, output: string): void {
  if (marker === "symlink") {
    fs.writeFileSync(join(job.dir, "elsewhere.pdf"), PDF);
    fs.symlinkSync(join(job.dir, "elsewhere.pdf"), output);
  } else if (marker === "fifo") {
    runFile("mkfifo", [output]);
  } else {
    fs.writeFileSync(output, marker === "empty" || SPARSE[marker] !== undefined ? "" : PDF);
    if (SPARSE[marker] !== undefined) {
      fs.truncateSync(output, SPARSE[marker]);
    }
  }
}

function snapshot(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const name of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (fs.lstatSync(join(dir, name)).isFile()) {
      files[name] = fs.readFileSync(join(dir, name));
    }
  }
  return files;
}

export function startFakeSidecar(spool: string, heartbeat: Heartbeat = "fresh"): FakeSidecar {
  const jobsDir = join(spool, "jobs");
  const found: FakeJob[] = [];
  const byId = new Map<string, FakeJob>();
  const released = new Set<string>();
  const gated = new Set<FakeJob>();
  let watcher: fs.FSWatcher | undefined;
  let beat = heartbeat;
  const has = (job: FakeJob, name: string): boolean => fs.existsSync(join(job.dir, name));

  function touch(): void {
    if (beat !== "none") {
      const at = Date.now() / 1000 - (beat === "stale" ? 30 : 0);
      fs.writeFileSync(join(spool, "heartbeat"), "", { flag: "a" });
      fs.utimesSync(join(spool, "heartbeat"), at, at);
    }
  }

  function scan(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(jobsDir, { withFileTypes: true }).flatMap((entry) => {
        return entry.isDirectory() && !byId.has(entry.name) ? [entry.name] : [];
      });
    } catch {
      // `jobs/` 还没建出。
    }
    for (const id of names) {
      const job: FakeJob = { id, dir: join(jobsDir, id), files: {} };
      byId.set(id, job);
      found.push(job);
    }
    for (const job of found) {
      job.name ??= has(job, "in") ? fs.readdirSync(join(job.dir, "in"))[0] : undefined;
      job.cancelAt ??= has(job, "cancel") ? Date.now() : undefined;
    }
  }

  function claim(job: FakeJob): void {
    job.files = snapshot(job.dir);
    job.request = job.files["request.json"]?.toString("utf8");
    job.name = fs.readdirSync(join(job.dir, "in"))[0];
    job.bytes = job.files[join("in", job.name ?? "")];
    const marker = sidecar.next ?? /@([a-z0-9-]+)/u.exec(job.name ?? "")?.[1] ?? "ok";
    sidecar.next = undefined;
    const answer = produce(job, marker);
    if (answer !== undefined) {
      mark(job, answer);
    } else if (marker === "gate") {
      gated.add(job);
    }
  }

  function serve(job: FakeJob): void {
    if (job.request === undefined && has(job, "request.json")) {
      claim(job);
    }
    if (gated.has(job) && released.has(job.name ?? "") && job.cancelAt === undefined) {
      gated.delete(job);
      mark(job, "done");
    }
  }

  function tick(): void {
    if (watcher === undefined && fs.existsSync(jobsDir)) {
      watcher = fs.watch(jobsDir, { recursive: true }, (_event, name) => {
        const [id, file] = String(name).split(/[\\/]/u);
        const job = byId.get(id ?? "");
        if (job !== undefined && file === "cancel") {
          job.cancelAt ??= Date.now();
        }
        tick();
      });
    }
    scan();
    for (const job of found) {
      try {
        serve(job);
      } catch {
        // 作业目录在领取途中被 app 删掉：下一轮它已不在。
      }
    }
  }

  const timers = [setInterval(tick, 100), setInterval(touch, 500)];
  const sidecar: FakeSidecar = {
    next: undefined,
    jobs() {
      scan();
      return found;
    },
    release(name) {
      released.add(name);
      tick();
    },
    heartbeat(mode) {
      beat = mode;
      touch();
    },
    stop() {
      timers.forEach(clearInterval);
      watcher?.close();
    },
  };
  touch();
  tick();
  running.push(sidecar);
  return sidecar;
}
