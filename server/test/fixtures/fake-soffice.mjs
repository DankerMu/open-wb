#!/usr/bin/env node
/**
 * 假 `soffice`（任务 14.4，#1071）：办公文档转换器测试对着它真实 spawn，不需要 LibreOffice。
 *
 * 作业目录取自 argv 里 `--outdir` 的上一级——以 `sudo` 为名被启动时 `officeBin` 前面还有前缀，
 * 所以按参数名找、不按位置数。行为由最后一个 argv（输入路径）文件名里的 `@标记` 决定，没有标记即
 * 正常转换。启动后先把收到的 argv、环境与 pid 写到 `<work>/<作业目录名>.record.json`（先写临时名
 * 再改名，轮询的一方读不到半截）。凡睡眠都有上限，到时自行退出，不留长命进程。
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";

/** 正常转换写出的全部字节；测试里另抄一份字面量来对。 */
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const SLEEP_MS = 30_000;
const PROFILE_PREFIX = "-env:UserInstallation=file://";

const argv = process.argv.slice(1);
const outdirAt = argv.indexOf("--outdir");
const outdir = outdirAt === -1 ? undefined : argv[outdirAt + 1];
const input = argv.at(-1);
if (outdir === undefined || input === undefined) {
  process.exit(64);
}
const job = dirname(outdir);
const output = join(outdir, `${parse(basename(input)).name}.pdf`);
const marker = /@([a-z0-9-]+)/u.exec(basename(input))?.[1] ?? "ok";

const record = { argv, env: { ...process.env }, pid: process.pid };

function writeRecord() {
  const path = join(dirname(job), `${basename(job)}.record.json`);
  writeFileSync(`${path}.part`, JSON.stringify(record));
  renameSync(`${path}.part`, path);
}

/** 真 soffice 自己建输出目录与用户配置目录；转换器不预建。 */
function prepareDirs() {
  mkdirSync(outdir, { recursive: true });
  const profile = argv.find((arg) => arg.startsWith(PROFILE_PREFIX));
  if (profile !== undefined) {
    mkdirSync(profile.slice(PROFILE_PREFIX.length), { recursive: true });
  }
}

function sleepThenExit() {
  setTimeout(() => process.exit(0), SLEEP_MS);
}

const behaviours = {
  ok() {
    writeFileSync(output, PDF);
  },
  /** 输出是完好的 PDF，只有退出码不对：不看退出码的实现会把它当成功。 */
  exit1() {
    writeFileSync(output, PDF);
    process.exit(1);
  },
  "no-output"() {},
  empty() {
    writeFileSync(output, "");
  },
  /** 链接目标是一个真实的非空 PDF：跟随链接的实现会把它当成功。 */
  symlink() {
    const elsewhere = join(job, "elsewhere.pdf");
    writeFileSync(elsewhere, PDF);
    symlinkSync(elsewhere, output);
  },
  /** 输出位置是一个没有写端的命名管道：阻塞式 open 会一直挂着。 */
  fifo() {
    execFileSync("mkfifo", [output]);
  },
  sleep() {
    sleepThenExit();
  },
  /** 子进程不 detached，与本进程同一个进程组；它自己也只活到上限。 */
  "spawn-sleep"() {
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${SLEEP_MS})`], {
      stdio: "ignore",
    });
    record.childPid = child.pid;
    writeRecord();
    sleepThenExit();
  },
  /** 作业目录里留一个删不掉的非空子目录（`OMP_USER` 模式下残留文件的同 uid 等价物）。 */
  "locked-dir"() {
    const locked = join(job, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "keep"), "x");
    chmodSync(locked, 0o500);
    writeFileSync(output, PDF);
  },
};

const behave = behaviours[marker];
if (behave === undefined) {
  process.exit(64);
}
writeRecord();
prepareDirs();
behave();
