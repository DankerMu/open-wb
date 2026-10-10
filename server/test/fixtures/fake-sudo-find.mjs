#!/usr/bin/env node
/**
 * 记录型假 `sudo`（任务 14.3 / 14.5，#1072）：启动时清空 `work` 的测试把它链成临时 bin 目录里的
 * `sudo`，靠 `PATH` 首项命中，从不执行真的 `sudo` 或 `find`。
 *
 * 它自己什么都不删：从 argv 里取 `/usr/bin/find` 之后那一项当作 `work` 的路径，列一次目录、睡约
 * 150 毫秒、再列一次，把 `{argv, env, cwd, pid, entriesAtStart, entriesAtExit}` 写到
 * `<work 的上一级>/sudo.record.json`（先写临时名再改名）。两次列目录都还看得见遗留条目，就是
 * 「调用方等它结束之后才开始自己的删除」的判据。退出方式读同级的哨兵文件 `sudo.exit`：没有即 0；
 * 内容 `1` 即退出码 1；`signal` 即被信号结束（没有退出码）。
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SETTLE_MS = 150;

const argv = process.argv.slice(1);
const findAt = argv.indexOf("/usr/bin/find");
const work = findAt === -1 ? undefined : argv[findAt + 1];
if (work === undefined) {
  process.exit(64);
}
const beside = dirname(work);

function list() {
  try {
    return readdirSync(work).sort();
  } catch {
    return null;
  }
}

function exitMode() {
  try {
    return readFileSync(join(beside, "sudo.exit"), "utf8").trim();
  } catch {
    return "0";
  }
}

const entriesAtStart = list();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_MS);
const record = {
  argv,
  env: { ...process.env },
  cwd: process.cwd(),
  pid: process.pid,
  entriesAtStart,
  entriesAtExit: list(),
};
const path = join(beside, "sudo.record.json");
writeFileSync(`${path}.part`, JSON.stringify(record));
renameSync(`${path}.part`, path);

const mode = exitMode();
if (mode === "signal") {
  process.kill(process.pid, "SIGKILL");
} else {
  process.exit(mode === "1" ? 1 : 0);
}
