/**
 * compose `healthcheck` 用（office-preview「转换 sidecar 实现与镜像」）：`<spool>/heartbeat` 的
 * 年龄 < 10 s → 退出 0；否则（含缺席、读不出）→ 1。`<spool>` = `CONVERTER_SPOOL_DIR`（缺省 `/spool`）。
 */
import { statSync } from "node:fs";
import { join } from "node:path";

const FRESH_MS = 10_000;
const spool = process.env.CONVERTER_SPOOL_DIR ?? "/spool";

let age = Number.POSITIVE_INFINITY;
try {
  age = Date.now() - statSync(join(spool, "heartbeat")).mtimeMs;
} catch {
  // 缺席或读不出：不健康。
}
process.exit(age < FRESH_MS ? 0 : 1);
