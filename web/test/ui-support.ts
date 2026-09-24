import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 仓库根目录（web/test 上两级）。 */
const repoRoot = resolve(import.meta.dirname, "../..");

/** 颜色字面量（hex / rgb(a)）；`(?![\w-])` 让 `#root`、`#fade-in` 这类 id 选择器不误中。 */
export const COLOR_LITERAL_PATTERNS = [/#[0-9a-fA-F]{3,8}(?![\w-])/, /rgba?\(/];

export function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** 递归列出 `dir`（仓库相对路径）下满足 `accept` 的文件，返回仓库相对路径。 */
export function listRepoFiles(dir: string, accept: (path: string) => boolean): string[] {
  const root = join(repoRoot, dir);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)))
    .filter(accept)
    .sort();
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 从 `opener` 首次出现处的 `{` 起按括号配对取块体（不含外层花括号）。 */
export function blockBody(css: string, opener: RegExp): string {
  const match = opener.exec(css);
  if (!match) throw new Error(`未找到块 ${opener}`);
  const start = css.indexOf("{", match.index) + 1;
  let depth = 1;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index);
  }
  throw new Error(`块 ${opener} 未闭合`);
}
