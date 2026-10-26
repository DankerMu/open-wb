#!/usr/bin/env node
/**
 * 假 `fusermount3`（s1b-workspace-mounts tasks 5.2，#1686）：mount-manager 的测试把它复制进一个只给
 * manager 用的 bin 目录、真实 spawn。只认 `-uz <路径>`：从同目录 `mountinfo.path` 文件里写的那个假
 * mountinfo 中删去挂载点（第 5 字段，按 `\ooo` 八进制转义还原后）等于 `<路径>` 的行，先写临时名再改名；
 * 没有这样的行即同真 fusermount3 一样报 not found、以 1 退出。每次调用都向同目录的
 * `fusermount3-calls.jsonl` 追加一行 `{argv, removed}`。改写假 mountinfo 时持有 `<mountinfo>.lock`
 * （目录锁，假 rclone 追加行时同样持有）：并发的 `-uz` 不丢更新（#1687 关停时并行卸载）。
 * 同目录有 `fusermount3-hold` 时，恰一次调用把它改名为 `fusermount3-holding` 认领、先停住，等测试删掉
 * `fusermount3-holding`（至多 10 s）再照常行事（#1687：把一次离线处理钉在卸载这一步）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mountinfo = readFileSync(join(here, "mountinfo.path"), "utf8").trim();

const decode = (field) =>
  Buffer.from(
    field.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))),
    "latin1",
  ).toString("utf8");

/** 目录锁：`mkdir` 成功即持有；每 5 ms 重试，2 s 内拿不到即放弃（以 2 退出）。 */
function withLock(work) {
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
    return work();
  } finally {
    rmdirSync(lock);
  }
}

/** 认领到 `fusermount3-hold` 即停到 `fusermount3-holding` 被删。 */
function holdIfAsked() {
  const holding = join(here, "fusermount3-holding");
  try {
    renameSync(join(here, "fusermount3-hold"), holding);
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (existsSync(holding) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

holdIfAsked();
let removed = 0;
if (args.length === 2 && args[0] === "-uz") {
  removed = withLock(() => {
    const lines = readFileSync(mountinfo, "latin1").split("\n");
    const kept = lines.filter(
      (line) => line === "" || decode(line.split(" ")[4] ?? "") !== args[1],
    );
    if (lines.length > kept.length) {
      writeFileSync(`${mountinfo}.part`, kept.join("\n"), "latin1");
      renameSync(`${mountinfo}.part`, mountinfo);
    }
    return lines.length - kept.length;
  });
}
appendFileSync(
  join(here, "fusermount3-calls.jsonl"),
  `${JSON.stringify({ argv: args, removed })}\n`,
);
if (removed === 0) {
  process.stderr.write(`fusermount3: entry for ${args[1]} not found in /etc/mtab\n`);
  process.exit(1);
}
