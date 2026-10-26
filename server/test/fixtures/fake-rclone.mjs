#!/usr/bin/env node
/**
 * 假 `rclone`（s1b-workspace-mounts tasks 5.2，#1685）：凭证文件的测试对着它真实 spawn，不需要 rclone。
 * 这一刀只有 `obscure -`；`mount` 行为与假 `fusermount3` 在 #1686。
 *
 * 子进程环境只有 `PATH` 与 `HOME`（`HOME` = `<state>/mounts/<id>`），所以记录文件的位置从 `HOME` 推出：
 * 每次调用先向 `<state>/fake-rclone-calls.jsonl` 追加一行 `{argv, env, stdin, pid}`，再按标准输入里的
 * `@标记` 行事（同 `fake-soffice.mjs` 的标记写法），没有标记即正常输出。
 *
 * 正常输出（测试里另按同一公式算一遍来对）：口令去掉末尾一个换行（#1665 P2′：末尾换行不计入口令）后，
 * `obscured:<口令>` 的 base64url 编码加一个换行——与真 rclone 的 obscure 串同一字母表 `[A-Za-z0-9_-]`。
 * 凡睡眠都有上限，到时自行退出，不留长命进程。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SLEEP_MS = 30_000;

const [command, ...rest] = process.argv.slice(2);
if (command !== "obscure" || rest.length !== 1 || rest[0] !== "-" || !process.env.HOME) {
  process.exit(64);
}
const stdin = readFileSync(0, "utf8");
const calls = join(process.env.HOME, "..", "..", "fake-rclone-calls.jsonl");
appendFileSync(
  calls,
  `${JSON.stringify({ argv: process.argv.slice(1), env: { ...process.env }, stdin, pid: process.pid })}\n`,
);

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
    setTimeout(() => process.exit(0), SLEEP_MS);
  },
};

const behave = behaviours[marker];
if (behave === undefined) {
  process.exit(64);
}
behave();
