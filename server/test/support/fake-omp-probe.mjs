/**
 * fake-omp 的 IO 探针（从 fake-omp.mjs 搬出，s1d-experts-skills #1656 加 `read:` / `list:`）：
 * omp-test-harness「假 omp probe 回报」。以子进程自己的凭据实际做一次 IO，只回报结果码，
 * 不回报文件内容或目录条目名。无模块级可变状态、不发帧；只依赖 node: 内建，
 * 绝不导入 fake-omp.mjs（它有 argv/ready/stdin 模块级副作用）。
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** `<label>=ok`，或该次 IO 的 errno（如 `EACCES`）。 */
function outcome(label, io) {
  try {
    io();
    return `${label}=ok`;
  } catch (error) {
    return `${label}=${error.code}`;
  }
}

/**
 * 一条 prompt 的探针回报；不是探针时返回 undefined。`inbound` 是入站帧 type 记录（`frames=`）。
 * `rename:<path>` 把 path 改名为 `<path>.moved`；`read:<path>` 读文件、`list:<path>` 列目录，
 * 只回报 `read=` / `listed=`；`probe:<pid>:<writePath>` 回报身份、环境与两次 IO。
 */
export function probeReport(message, inbound) {
  const text = String(message ?? "");
  if (text.startsWith("rename:")) {
    const path = text.slice(7);
    return outcome("renamed", () => renameSync(path, `${path}.moved`));
  }
  if (text.startsWith("read:")) {
    return outcome("read", () => readFileSync(text.slice(5)));
  }
  if (text.startsWith("list:")) {
    return outcome("listed", () => readdirSync(text.slice(5)));
  }
  if (!text.startsWith("probe:")) {
    return undefined;
  }
  const rest = text.slice(6);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const pid = rest.slice(0, colon);
  const writePath = rest.slice(colon + 1);
  if (!/^[0-9]+$/u.test(pid) || writePath.length === 0) {
    return undefined;
  }
  let wrote = "ok";
  try {
    writeFileSync(writePath, "probe", "utf8");
  } catch (error) {
    wrote = error.code;
  }
  let environ = "readable";
  try {
    readFileSync(`/proc/${pid}/environ`);
  } catch (error) {
    environ = error.code;
  }
  const env = Object.keys(process.env).sort().join(",");
  const xdg = (kind) => process.env[`XDG_${kind}_HOME`] ?? "";
  return `uid=${process.getuid()} gid=${process.getgid()} env=${env} home=${process.env.HOME ?? ""} xdgdata=${xdg("DATA")} xdgstate=${xdg("STATE")} xdgcache=${xdg("CACHE")} environ=${environ} wrote=${wrote} frames=${inbound.join(",")} cwd=${process.cwd()}`;
}
