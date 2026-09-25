import type { IconName } from "../../ui/index.js";

const ICON_BY_EXTENSION = new Map<string, IconName>([
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["zip", "archive"],
  ["tar", "archive"],
  ["gz", "archive"],
  ["csv", "table"],
  ["md", "file-text"],
  ["txt", "file-text"],
  ["log", "file-text"],
  ["json", "file-code"],
  ["js", "file-code"],
  ["ts", "file-code"],
  ["tsx", "file-code"],
  ["html", "file-code"],
]);

/** 扩展名取最后一个 `.` 之后、不区分大小写，与可预览判断同一规则。 */
export function fileIcon(name: string): IconName {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "file";
  return ICON_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? "file";
}

const UNITS = ["KB", "MB", "GB"] as const;

/** `< 1024` 显示字节原值；否则 KB/MB/GB 一位小数，舍入到 1024.0 时进位，GB 封顶。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
