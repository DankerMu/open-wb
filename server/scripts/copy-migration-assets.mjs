/**
 * 构建收尾：把受跟踪的 migrations/ 完整递归树逐文件逐字节带入 dist 的对应位置，
 * 使编译产物的 `import.meta.url`（dist/core/db/migration-assets.js）解析到同一份 schema 源。
 * 先删除目标再复制，避免任何 stale 文件残留。
 */
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(serverRoot, "src", "core", "db", "migrations");
const target = join(serverRoot, "dist", "core", "db", "migrations");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
