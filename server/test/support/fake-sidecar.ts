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
 * `gate` → `release(<输入名>)` 后 `done`；`locked-dir` → 另放 `0500` 的非空 `locked/`（app 删不掉）；
 * `out-symlink` → `out` 是指向另一目录的链接；`job-symlink` → 作业目录换成指向 `<spool>/decoy-<id>`
 * （内有 `out/`）的链接后 `done`。追加与截短由 output 测试的 `fstat` 探针在 app 侧做。
 *
 * 观察：100 ms 轮询加 `fs.watch`（app 写完 `cancel` 随即删目录，轮询会漏）。macOS 上递归监听 `jobs/`；
 * 加挂逐目录监听反而偶发漏记（实测；推算为 FSEvents 增减监听时重建事件流）。Linux 上不用递归监听：Node 的
 * 递归监听是 JS 实现，目录已删即不发子项事件，Node 24.13.1 还会 `readdir` 已消失的子目录、发出 `ENOENT`
 * 的 `error`（CI 与探针实测）；改为非递归监听 `jobs/` 与每个作业目录（inotify）。每个监听都挂 `error`，回调
 * 里的扫描与应答吞掉 `ENOENT`。心跳：`fresh` 每 500 ms touch，`stale` 钉在 30 秒前。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join, parse } from "node:path";

/** 模块求值时取下的原函数：转换器测试数 `child_process` 的调用，夹具建命名管道不算进去。 */
const runFile = execFileSync;
export const PDF =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const SPARSE: Record<string, number> = { "sparse-limit": 209_715_200, "sparse-over": 209_715_201 };
const HELD = ["hang", "sleep", "gate"];
const LINUX = process.platform === "linux";
export type Heartbeat = "fresh" | "stale" | "none";

/** 发现时读 `name`；领取时记 `request`、`files`（相对路径 → 字节）与 `bytes`；`answer` 为 `done` 或 `failed:<码>`。 */
export interface FakeJob {
  id: string;
  dir: string;
  name?: string | undefined;
  bytes?: Buffer | undefined;
  request?: string | undefined;
  files: Record<string, Buffer>;
  cancelAt?: number | undefined;
  output?: string;
  answer?: string;
}

/** `jobs()` 先同步扫一遍再交出全部作业（发现次序）；`next` 让下一个领取的作业按该标记应答，只用一次。 */
export interface FakeSidecar {
  jobs(): FakeJob[];
  release(name: string): void;
  next: string | undefined;
  heartbeat(mode: Heartbeat): void;
  stop(): void;
}

const running: FakeSidecar[] = [];

export function stopFakeSidecars(): void {
  for (const sidecar of running.splice(0)) {
    sidecar.stop();
  }
}

/** 作业目录随时可能被 app 删掉：途中的 `ENOENT` 吞掉（与真 sidecar 同），下一轮再看。 */
function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // 见上。
  }
}

function mark(job: FakeJob, answer: string): void {
  const [file, content] = answer === "done" ? ["done", ""] : ["failed", answer];
  quietly(() => {
    fs.writeFileSync(join(job.dir, `${file}.part`), content);
    fs.renameSync(join(job.dir, `${file}.part`), join(job.dir, file));
    job.answer = answer === "done" ? "done" : `failed:${answer}`;
  });
}

/** 按标记写输出；返回随后要写的标记，`undefined` 即先不写。 */
function produce(job: FakeJob, marker: string): string | undefined {
  if (marker === "bad-request" || marker === "nopdf") {
    return marker === "nopdf" ? "done" : marker;
  }
  const out = join(job.dir, marker === "out-symlink" ? "real-out" : "out");
  fs.mkdirSync(out, { recursive: true });
  const output = join(out, `${parse(job.name ?? "").name}.pdf`);
  job.output = join("out", parse(output).base);
  writeOutput(job, marker, output);
  if (marker === "out-symlink") {
    fs.symlinkSync(out, join(job.dir, "out"));
  } else if (marker === "locked-dir") {
    fs.mkdirSync(join(job.dir, "locked", "keep"), { recursive: true });
    fs.chmodSync(join(job.dir, "locked"), 0o500);
  } else if (marker === "job-symlink") {
    const decoy = join(job.dir, "..", "..", `decoy-${job.id}`);
    fs.mkdirSync(decoy);
    fs.renameSync(out, join(decoy, "out"));
    fs.rmSync(job.dir, { recursive: true });
    fs.symlinkSync(decoy, job.dir);
  }
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
  const names = fs.readdirSync(dir, { recursive: true, encoding: "utf8" });
  const files = names.filter((name) => fs.lstatSync(join(dir, name)).isFile());
  return Object.fromEntries(files.map((name) => [name, fs.readFileSync(join(dir, name))]));
}

/** 挂一个监听：目录已不在（`ENOENT`）即不挂，之后的 `error` 关掉它；`onName` 不抛。 */
function watchDir(dir: string, recursive: boolean, onName: (name: string) => void): fs.FSWatcher[] {
  try {
    const watch = fs.watch(dir, { recursive }, (_event, name) => onName(String(name)));
    return [watch.on("error", () => watch.close())];
  } catch {
    return [];
  }
}

export function startFakeSidecar(spool: string, heartbeat: Heartbeat = "fresh"): FakeSidecar {
  const jobsDir = join(spool, "jobs");
  const found: FakeJob[] = [];
  const byId = new Map<string, FakeJob>();
  const released = new Set<string>();
  const gated = new Set<FakeJob>();
  const watchers: fs.FSWatcher[] = [];
  let watching = false;
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
    const entries = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir, { withFileTypes: true }) : [];
    for (const { name: id } of entries.filter((e) => e.isDirectory() && !byId.has(e.name))) {
      const job: FakeJob = { id, dir: join(jobsDir, id), files: {} };
      byId.set(id, job);
      found.push(job);
      watchers.push(...(LINUX ? watchDir(job.dir, false, (name) => onJobs(`${id}/${name}`)) : []));
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

  /** 监听事件的名字是 `<id>/<文件>`；Linux 上 `jobs/` 只报 `<id>`，随即扫描给它挂上逐目录监听。 */
  function onJobs(name: string): void {
    const [id, file] = name.split(/[\\/]/u);
    const job = byId.get(id ?? "");
    if (job !== undefined && file === "cancel") {
      job.cancelAt ??= Date.now();
    }
    tick();
  }

  function tick(): void {
    if (!watching && fs.existsSync(jobsDir)) {
      watching = true;
      watchers.push(...watchDir(jobsDir, !LINUX, onJobs));
    }
    quietly(scan);
    for (const job of found) {
      quietly(() => serve(job));
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
      for (const watch of watchers) {
        watch.close();
      }
    },
  };
  touch();
  tick();
  running.push(sidecar);
  return sidecar;
}
