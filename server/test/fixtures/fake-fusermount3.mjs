#!/usr/bin/env node
/**
 * 假 `fusermount3`（s1b-workspace-mounts tasks 5.2，#1686）：mount-manager 的测试把它复制进一个只给
 * manager 用的 bin 目录、真实 spawn。只认 `-uz <路径>`：从同目录 `mountinfo.path` 文件里写的那个假
 * mountinfo 中删去挂载点（第 5 字段，按 `\ooo` 八进制转义还原后）等于 `<路径>` 的行，先写临时名再改名；
 * 没有这样的行即同真 fusermount3 一样报 not found、以 1 退出。每次调用都向同目录的
 * `fusermount3-calls.jsonl` 追加一行 `{argv, removed}`。
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

let removed = 0;
if (args.length === 2 && args[0] === "-uz") {
  const lines = readFileSync(mountinfo, "latin1").split("\n");
  const kept = lines.filter((line) => line === "" || decode(line.split(" ")[4] ?? "") !== args[1]);
  removed = lines.length - kept.length;
  if (removed > 0) {
    writeFileSync(`${mountinfo}.part`, kept.join("\n"), "latin1");
    renameSync(`${mountinfo}.part`, mountinfo);
  }
}
appendFileSync(
  join(here, "fusermount3-calls.jsonl"),
  `${JSON.stringify({ argv: args, removed })}\n`,
);
if (removed === 0) {
  process.stderr.write(`fusermount3: entry for ${args[1]} not found in /etc/mtab\n`);
  process.exit(1);
}
