import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { act, fireEvent } from "@testing-library/react";

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

/** 顶层规则块（@media 等嵌套块作为整体一项），按出现顺序。 */
export function topLevelBlocks(css: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      if (depth === 0) open = index;
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, index) });
        start = index + 1;
      }
    }
  }
  return blocks;
}

/** 按选择器（逗号分隔列表中的任一项全等）取顶层规则块体。 */
export function ruleBody(css: string, selector: string): string {
  const block = topLevelBlocks(css).find((candidate) =>
    candidate.prelude.split(",").some((part) => part.trim() === selector),
  );
  if (!block) throw new Error(`未找到规则 ${selector}`);
  return block.body;
}

/** 在 act 内以真实计时器等待 `ms` 毫秒。 */
export function waitMs(ms: number) {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/** FocusScope 卸载归还在 setTimeout(0) 里跑；每个用例结束后让出一个宏任务，避免残留计时器串到下一个用例。 */
export function yieldMacrotask() {
  return waitMs(0);
}

/**
 * 真实浏览器里一次指针按压的完整事件序列（pointerdown→mousedown→pointerup→mouseup→click），
 * 供 Radix DismissableLayer 外点判定：无论该层在 pointerdown 即判定还是登记后等 click 到达
 * （`deferPointerDownOutside`），都走得通。调用前须先 `yieldMacrotask()`：DismissableLayer 的
 * document pointerdown 监听在挂载后的 setTimeout(0) 里才注册。
 */
export function pressPointer(target: Element) {
  fireEvent.pointerDown(target);
  fireEvent.mouseDown(target);
  fireEvent.pointerUp(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}
