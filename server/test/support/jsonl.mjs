/**
 * #1878（verification-harness「轮询读取并发追加的 JSONL 时只解析已结束的行」）：读另一个进程正在追加的 JSONL。
 * 写方（假 rclone、假 `fusermount3`）每条记录一次 `appendFileSync(JSON + "\n")`，`\n` 是这次写入的最后一个字节，
 * `JSON.stringify` 又转义了字符串里的换行，所以末尾没有 `\n` 的那一段就是没写完的半行：本次丢弃，下次轮询再读。
 * 已结束的行照常 `JSON.parse`，坏行照样抛错。文件不存在时返回空数组。
 *
 * 写成零依赖的 `.mjs`，`fixtures/threadpool-recovery.mjs` 这种由 `node` 直接起的子进程脚本也能导入同一份。
 */
import { existsSync, readFileSync } from "node:fs";

export function readCompleteJsonl(file) {
  if (!existsSync(file)) {
    return [];
  }
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}
