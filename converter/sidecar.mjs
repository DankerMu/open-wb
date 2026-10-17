/**
 * 办公文档转换 sidecar（office-preview「转换 sidecar 实现与镜像」；change office-convert-sandbox
 * design D3、D7）。它在 `network_mode: none`、只读根、只挂 spool 卷的容器里长驻，轮询 spool，
 * 对每个就绪作业以容器自己的 LibreOffice 转换，结果写回同一作业目录。零依赖，Node 24。
 *
 * 本头注释是 spool 协议的单一真相（app 一侧的 spool 客户端按它写；change 的切片 S1b）：
 *
 * - `<spool>` = `CONVERTER_SPOOL_DIR`（缺省 `/spool`）。根下只有 `heartbeat` 与 `jobs/`；本进程
 *   SHALL NOT 写这两者之外的任何东西，SHALL NOT 删除作业目录（归 app），SHALL NOT 建 `jobs/`
 *   （app 建；不存在时视为空列表，不限次数地继续轮询）。
 * - `heartbeat`：启动即以 `wx` 建（已存在则 touch），之后每 `CONVERTER_HEARTBEAT_MS`（缺省
 *   2000）touch。健康 = 年龄 < 10 s（`healthcheck.mjs` 与 app 的心跳检查同一判据）。
 * - `jobs/<id>/`：app 建（`id` 是 32 个十六进制字符）。`in/<name>` 是输入的字节副本；
 *   `request.json` = `{"version":1,"input":"<name>","timeoutMs":<正整数>}`，恰这三个键、没有路径，
 *   由 app 经 `.part` + `rename` 写出——它的出现就是就绪标记。`jobs/` 下的非目录条目（如测试夹具的
 *   `jobs/<id>.record.json`）跳过、不记日志。
 * - 领取：每 `CONVERTER_POLL_MS`（缺省 200）一轮，取「有 `request.json`、没有 `done` / `failed`、
 *   不在在途表里」的目录，按 `request.json` 的 mtime 升序，同时在途至多 `CONVERTER_CONCURRENCY`
 *   （缺省 2）。
 * - 校验：键集恰为三键；`version` = 1；`input` 是单一路径段（不含 `/` 与 NUL、不是 `.` / `..`）、
 *   扩展名小写后为 `docx` / `xlsx` / `pptx`；`timeoutMs` 是 ≤ 2147483647 的正整数；`request.json`
 *   与 `in/<input>` 都是普通文件（`lstat`，不跟随链接）。任一不成立 → `failed: bad-request`，不启动进程；
 *   读 `request.json` 时它（或作业目录）已不在 → 与 `cancel` 同等，`cancelled`。
 * - 转换：`detached` 启动 `CONVERTER_SOFFICE_BIN`（缺省 `/usr/bin/soffice`），`cwd` 与 `HOME` 都是
 *   作业目录，环境恰为 `PATH`、`HOME` 与存在时的 `LANG`，标准流丢弃；`in/<input>` 作为 `--outdir`
 *   之后的最后一项、以作业目录开头的绝对路径传入，所以以 `-` 开头的名字不会被当成选项。
 * - 终止：每轮对每个在途作业核对「`cancel` 出现，**或** `request.json` / 作业目录已不在」（app 写
 *   `cancel` 后立刻删目录，只认 `cancel` 会漏杀）→ 对进程组 `SIGKILL`、`cancelled`；`timeoutMs`
 *   到期 → 同样杀组、`timeout`。收到 `SIGTERM` → 杀全部在途进程组、以 0 退出、不写标记（重启后
 *   仍在的作业被重新领取）。
 * - 结果：退出码 0 且 `out/<去最后一个扩展名>.pdf` 是大小 > 0 的普通文件（`lstat`）→ `done`（空）；
 *   否则 `failed`，内容恰为一个原因码：`bad-request` / `exit`（非 0 退出）/ `signal`（被本进程之外的
 *   信号结束）/ `timeout` / `cancelled` / `no-output`。标记先写 `<名>.part` 再 `rename`，读者看不到
 *   半截内容（同目录的 `.part` 名可能被短暂看到）。
 * - 吞掉的错误恰为这些：标记写入与改名的 `ENOENT`（作业目录已被 app 删掉，那个作业 app 已经不等了）；
 *   列 `jobs/` 的 `ENOENT`（app 还没建它）；探测文件在不在时的 `ENOENT` / `ENOTDIR`；读 `request.json`
 *   时的 `ENOENT` / `ENOTDIR`（落为 `cancelled`）；spawn 报 `ENOENT` 且作业目录已不在（app 在核对之后、
 *   子进程 chdir 之前收尾，落为 `cancelled`，其它作业不受影响）；`kill` 的 `ESRCH`。其余一律不吞，
 *   stderr 写一行 `{"event":"fatal","reason":…,"code":…}`（只带错误码，不带路径与栈）、杀全部在途
 *   进程组、以 1 退出：启动时配置不合法 → `config`、spool 写不了 → `spool`；spawn 的其它错误（如
 *   可执行文件缺失）→ `spawn`；运行期任何未捕获的错误（含心跳 touch 失败）→ `internal`。
 * - 日志：stderr 每作业恰一行 `{"event":"convert","id":…,"result":"done|failed","reason":"<码或空>",
 *   "ms":…}`，不含输入名、不含路径；它进容器日志，不进 app 的 stderr。
 *
 * 隔离不在这里：网络、可见文件系统与身份由容器构造给出（`compose.yml`）。同一 sidecar 内并发的
 * 作业共享文件系统视图、ipc 命名空间与 uid，作业间只靠不可猜的作业 id 隔离（读代码推出，未测；
 * design D2 第 2 条登记的残余）。
 */
import { spawn } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { extname, join, parse } from "node:path";

const OFFICE_ARGS = [
  "--headless",
  "--norestore",
  "--nolockcheck",
  "--nodefault",
  "--nofirststartwizard",
];
const EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
const REQUEST_KEYS = ["input", "timeoutMs", "version"];
const MAX_TIMEOUT_MS = 2_147_483_647;

/** 不吞的错误都到这里：只写原因与错误码（不写路径与栈），杀全部在途进程组，以 1 退出。 */
function fatal(reason, code) {
  const line = code === undefined ? { event: "fatal", reason } : { event: "fatal", reason, code };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  for (const job of running.values()) {
    try {
      killGroup(job.child);
    } catch {
      // 已在退出路径上：一组杀不掉不挡其余，也不能再抛（那会把栈写进 stderr）。
    }
  }
  process.exit(1);
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    fatal("config");
  }
  return value;
}

/** 在途作业：id → `{dir, child, startedAt, timer, stopped}`。 */
const running = new Map();
/** `readRequest` 的第三种答案：`request.json` 或作业目录已不在。 */
const GONE = Symbol("gone");

process.on("uncaughtException", (error) => fatal("internal", errorCode(error)));
process.on("unhandledRejection", (error) => fatal("internal", errorCode(error)));

const spool = process.env.CONVERTER_SPOOL_DIR ?? "/spool";
const soffice = process.env.CONVERTER_SOFFICE_BIN ?? "/usr/bin/soffice";
const concurrency = positiveInt("CONVERTER_CONCURRENCY", 2);
const pollMs = positiveInt("CONVERTER_POLL_MS", 200);
const heartbeatMs = positiveInt("CONVERTER_HEARTBEAT_MS", 2000);
const jobsDir = join(spool, "jobs");
const heartbeat = join(spool, "heartbeat");

function errorCode(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** 存在与否；不存在（含上一级已不是目录）是答案，不是错误。不跟随符号链接。 */
function probe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function touchHeartbeat() {
  try {
    writeFileSync(heartbeat, "", { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const now = new Date();
    utimesSync(heartbeat, now, now);
  }
}

/** 先写 `.part` 再 `rename`；作业目录已被 app 删掉时的 `ENOENT` 吞掉，其它错误照抛。 */
function writeMarker(dir, name, content) {
  const target = join(dir, name);
  const part = `${target}.part`;
  try {
    // 上一次本进程死在写与改名之间留下的 `.part`：先清掉，`wx` 才不会撞上它。
    rmSync(part, { force: true });
    writeFileSync(part, content, { flag: "wx" });
    renameSync(part, target);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function settle(id, dir, startedAt, reason) {
  writeMarker(dir, reason === "" ? "done" : "failed", reason);
  const result = reason === "" ? "done" : "failed";
  const line = { event: "convert", id, result, reason, ms: Date.now() - startedAt };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/** pid 只来自本进程启动的子进程；`ESRCH`（整组已不在）是答案，其它错误照抛。 */
function killGroup(child) {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      throw error;
    }
  }
}

function validInput(input) {
  if (typeof input !== "string" || input.includes("/") || input.includes("\0")) {
    return false;
  }
  if (input === "." || input === "..") {
    return false;
  }
  return EXTENSIONS.has(extname(input).slice(1).toLowerCase());
}

/** 读出并解析 `request.json`：已不在 → `GONE`；不是普通文件或不是 JSON → `undefined`；其它 I/O 错误照抛。 */
function loadRequest(path) {
  try {
    return lstatSync(path).isFile() ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return GONE;
    }
    if (code !== undefined) {
      throw error;
    }
    return undefined;
  }
}

/** 合法 → `{input, timeoutMs}`；已不在 → `GONE`；任何不合法 → `undefined`。 */
function readRequest(dir) {
  const request = loadRequest(join(dir, "request.json"));
  if (request === GONE) {
    return GONE;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const keys = Object.keys(request).sort();
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, at) => key !== REQUEST_KEYS[at])) {
    return undefined;
  }
  const { version, input, timeoutMs } = request;
  if (version !== 1) {
    return undefined;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return undefined;
  }
  if (!validInput(input) || probe(join(dir, "in", input))?.isFile() !== true) {
    return undefined;
  }
  return { input, timeoutMs };
}

function shouldCancel(dir) {
  return probe(join(dir, "cancel")) !== undefined || probe(join(dir, "request.json")) === undefined;
}

function hasOutput(dir, input) {
  const stat = probe(join(dir, "out", `${parse(input).name}.pdf`));
  return stat?.isFile() === true && stat.size > 0;
}

function outcome(job, input, code, signal) {
  if (job.stopped !== undefined) {
    return job.stopped;
  }
  if (signal !== null) {
    return "signal";
  }
  if (code !== 0) {
    return "exit";
  }
  return hasOutput(job.dir, input) ? "" : "no-output";
}

function launch(id, dir, startedAt, { input, timeoutMs }) {
  const env = { PATH: process.env.PATH ?? "", HOME: dir };
  if (process.env.LANG !== undefined) {
    env.LANG = process.env.LANG;
  }
  const args = [
    ...OFFICE_ARGS,
    `-env:UserInstallation=file://${dir}/profile`,
    "--convert-to",
    "pdf",
    "--outdir",
    join(dir, "out"),
    join(dir, "in", input),
  ];
  const child = spawn(soffice, args, { cwd: dir, env, stdio: "ignore", detached: true });
  const job = { dir, child, startedAt, timer: undefined, stopped: undefined };
  job.timer = setTimeout(() => stop(job, "timeout"), timeoutMs);
  running.set(id, job);
  child.once("error", (error) => {
    if (child.pid !== undefined) {
      return;
    }
    if (errorCode(error) === "ENOENT" && probe(dir) === undefined) {
      clearTimeout(job.timer);
      running.delete(id);
      settle(id, dir, startedAt, "cancelled");
      return;
    }
    fatal("spawn", errorCode(error));
  });
  child.once("exit", (code, signal) => {
    if (running.get(id) !== job) {
      return;
    }
    clearTimeout(job.timer);
    running.delete(id);
    settle(id, dir, startedAt, outcome(job, input, code, signal));
  });
}

function stop(job, reason) {
  if (job.stopped === undefined) {
    job.stopped = reason;
    killGroup(job.child);
  }
}

function start(id, dir) {
  const startedAt = Date.now();
  if (shouldCancel(dir)) {
    settle(id, dir, startedAt, "cancelled");
    return;
  }
  const request = readRequest(dir);
  if (request === GONE) {
    settle(id, dir, startedAt, "cancelled");
    return;
  }
  if (request === undefined) {
    settle(id, dir, startedAt, "bad-request");
    return;
  }
  launch(id, dir, startedAt, request);
}

/** 就绪作业按 `request.json` 的 mtime 升序；`jobs/` 还不存在就是空列表。 */
function readyJobs() {
  let entries;
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const ready = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || running.has(entry.name)) {
      continue;
    }
    const dir = join(jobsDir, entry.name);
    const request = probe(join(dir, "request.json"));
    if (request === undefined || probe(join(dir, "done")) || probe(join(dir, "failed"))) {
      continue;
    }
    ready.push({ id: entry.name, dir, at: request.mtimeMs });
  }
  return ready.sort((a, b) => a.at - b.at);
}

function tick() {
  for (const job of running.values()) {
    if (shouldCancel(job.dir)) {
      stop(job, "cancelled");
    }
  }
  for (const { id, dir } of readyJobs()) {
    if (running.size >= concurrency) {
      break;
    }
    start(id, dir);
  }
}

process.on("SIGTERM", () => {
  for (const job of running.values()) {
    killGroup(job.child);
  }
  process.exit(0);
});

try {
  touchHeartbeat();
} catch (error) {
  fatal("spool", errorCode(error));
}
setInterval(touchHeartbeat, heartbeatMs);
setInterval(tick, pollMs);
tick();
