#!/usr/bin/env node
/**
 * 假 `rclone`（s1b-workspace-mounts tasks 5.2）：凭证文件与 mount-manager 的测试对着它真实 spawn，不需要
 * rclone。两个子命令：`obscure -`（#1685）与 `mount`（#1686）。
 *
 * 子进程环境只有 `PATH` 与 `HOME`（`HOME` = `<state>/mounts/<id>`），所以记录文件与假 mountinfo 的位置都从
 * `HOME` 推出：每次调用先向 `<state>/fake-rclone-calls.jsonl` 追加一行 `{argv, env, stdin, pid, at}`（`at` 为写下这一行时的
 * `Date.now()`；`mount`
 * 另有 `logMode`：spawn 时 `--log-file` 的模式位，文件不存在为 null），再按 `@标记` 行事（同
 * `fake-soffice.mjs` 的标记写法），没有标记即正常行为。凡睡眠都有上限，到时自行退出，不留长命进程。
 *
 * `obscure -`：标记取自标准输入。正常输出（测试里另按同一公式算一遍来对）：口令去掉末尾一个换行
 * （#1665 P2′：末尾换行不计入口令）后，`obscured:<口令>` 的 base64url 编码加一个换行——与真 rclone 的
 * obscure 串同一字母表 `[A-Za-z0-9_-]`。
 *
 * `mount <段名>:<远端> <挂载点> …`：标记取自 `<远端>`（`sftp` / `smb` 的 `remotePath`、`local` 的挂载源路径）；
 * `<state>/fake-rclone-next` 存在时，每次 `mount` 先取走它的第一行作为本次的标记（重挂时远端已定在 DB 里，测试经
 * 它逐次改行为，#1687）。`mount` 的记录另有 `confHost`（spawn 时 `--config` 文件里 `host = ` 一行的值，没有为 null；
 * 只取这一行，整份文件含凭证）与 `preMounted`（spawn 时假 mountinfo 里是否已有挂载点等于本挂载点的行）。
 * 追加 mountinfo 行时持有 `<mountinfo>.lock`（与假 `fusermount3` 同一把目录锁）。
 * 挂出 = 向 `<state>/fake-mountinfo` 追加一行内核格式的记录：`… <挂载点> … - fuse.rclone <来源> rw…`，
 * 挂载点与来源按内核的写法把空格、制表符、换行与反斜杠写成 `\ooo` 八进制转义。挂出之后前台等待
 * SIGTERM（收到即退出；行不删——卸载由 `fusermount3 -uz` 删它，被 SIGKILL 时行也留着，同真实 FUSE）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SLEEP_MS = 30_000;
/** 挂出的进程等 SIGTERM 的上限：比任何一个用例都长，又不至于留下长命进程。 */
const MOUNTED_MS = 60_000;

const [command, ...rest] = process.argv.slice(2);
if (!process.env.HOME || (command !== "obscure" && command !== "mount")) {
  process.exit(64);
}
const state = join(process.env.HOME, "..", "..");
const stdin = readFileSync(0, "utf8");

function record(extra = {}) {
  appendFileSync(
    join(state, "fake-rclone-calls.jsonl"),
    `${JSON.stringify({ argv: process.argv.slice(1), env: { ...process.env }, stdin, pid: process.pid, at: Date.now(), ...extra })}\n`,
  );
}

function sleepThenExit(ms = SLEEP_MS) {
  setTimeout(() => process.exit(0), ms);
}

if (command === "obscure") {
  obscure();
} else {
  mount();
}

function obscure() {
  if (rest.length !== 1 || rest[0] !== "-") {
    process.exit(64);
  }
  record();
  const password = stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin;
  const marker = /@([a-z0-9-]+)/u.exec(password)?.[1] ?? "ok";
  const behaviours = {
    ok() {
      process.stdout.write(`${Buffer.from(`obscured:${password}`).toString("base64url")}\n`);
    },
    /** 不输出、以非 0 退出。 */
    exit3() {
      process.exit(3);
    },
    /** 以 0 退出却什么都不输出：只看退出码的实现会写出空的 `pass`。 */
    empty() {},
    /** 输出不是 obscure 串的字母表：不校验输出的实现会把它原样写进 INI。 */
    garbage() {
      process.stdout.write("not an obscure string\n");
    },
    /** 一直不输出、不退出：等调用方的期限杀掉它。 */
    hang() {
      sleepThenExit();
    },
  };
  const behave = behaviours[marker];
  if (behave === undefined) {
    process.exit(64);
  }
  behave();
}

function mount() {
  const [source, mountPoint] = rest;
  const logFile = rest[rest.indexOf("--log-file") + 1];
  if (source === undefined || mountPoint === undefined || !rest.includes("--log-file")) {
    process.exit(64);
  }
  const config = rest[rest.indexOf("--config") + 1];
  record({
    logMode: modeOf(logFile),
    confHost: confHostOf(config),
    preMounted: mountedAt(mountPoint),
  });
  const colon = source.indexOf(":");
  const section = source.slice(0, colon);
  const remote = source.slice(colon + 1);
  const marker = nextMarker() ?? /@([a-z0-9-]+)/u.exec(remote)?.[1] ?? "ok";

  /** 挂出之后等 SIGTERM。 */
  const serve = () => {
    process.on("SIGTERM", () => process.exit(0));
    setTimeout(() => process.exit(0), MOUNTED_MS);
  };
  const behaviours = {
    ok() {
      appendMount(mountPoint, `${section}:${remote}`, "");
      serve();
    },
    /** 不写 mountinfo 就以非 0 退出（#1665 P11 sftp：错误口令时挂载出现之前 rc=1）。 */
    exit1() {
      process.exit(1);
    },
    /** 既不写也不退出，也不理 SIGTERM：等调用方的就绪窗口用尽或取消、以 SIGKILL 杀掉它。 */
    hang() {
      process.on("SIGTERM", () => undefined);
      sleepThenExit();
    },
    /** 落到别处（#1665 P15）：挂载点换成 `<挂载点>.alt`，来源 `<段名>:<远端>`，之后挂起。 */
    elsewhere() {
      appendMount(`${mountPoint}.alt`, `${section}:${remote}`, " shared:7");
      sleepThenExit();
    },
    /** 同上，来源带覆盖后缀 `<段名>{abcde}:<远端>`（#1665 P1′ sftp / smb 的形状）。 */
    "elsewhere-suffix"() {
      appendMount(`${mountPoint}.alt`, `${section}{abcde}:${remote}`, " shared:7 master:3");
      sleepThenExit();
    },
    /** 照常挂出，却不理 SIGTERM：只有 SIGKILL 结束得了它。 */
    stubborn() {
      appendMount(mountPoint, `${section}:${remote}`, "");
      process.on("SIGTERM", () => undefined);
      setTimeout(() => process.exit(0), MOUNTED_MS);
    },
  };
  const behave = behaviours[marker];
  if (behave === undefined) {
    process.exit(64);
  }
  behave();
}

/** 取走 `<state>/fake-rclone-next` 的第一行；文件不存在或已空为 undefined。 */
function nextMarker() {
  const queue = join(state, "fake-rclone-next");
  if (!existsSync(queue)) {
    return undefined;
  }
  const [first, ...others] = readFileSync(queue, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  writeFileSync(queue, others.map((line) => `${line}\n`).join(""));
  return first;
}

function confHostOf(file) {
  try {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((text) => text.startsWith("host = "));
    return line === undefined ? null : line.slice("host = ".length);
  } catch {
    return null;
  }
}

function unmangle(field) {
  return Buffer.from(
    field.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))),
    "latin1",
  ).toString("utf8");
}

function mountedAt(mountPoint) {
  return readFileSync(join(state, "fake-mountinfo"), "latin1")
    .split("\n")
    .some((line) => line !== "" && unmangle(line.split(" ")[4] ?? "") === mountPoint);
}

function modeOf(file) {
  try {
    return statSync(file).mode & 0o7777;
  } catch {
    return null;
  }
}

/** 内核 mountinfo 的写法：挂载点与来源里的空格、制表符、换行与反斜杠写成 `\ooo`。 */
function mangle(text) {
  return text.replace(
    /[ \t\n\\]/gu,
    (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
}

/** 一行：`<id> <父 id> <主:次> <根> <挂载点> <选项> [可选字段…] - <类型> <来源> <超级块选项>`。 */
function appendMount(mountPoint, source, optional) {
  const mountinfo = join(state, "fake-mountinfo");
  const lock = `${mountinfo}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) {
        process.exit(2);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    appendFileSync(
      mountinfo,
      `${process.pid} 1 0:${process.pid % 256} / ${mangle(mountPoint)} rw,nosuid,nodev,relatime${optional} - fuse.rclone ${mangle(source)} rw,user_id=0,group_id=0\n`,
    );
  } finally {
    rmdirSync(lock);
  }
}
