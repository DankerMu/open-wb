// 会话页源码模块划分（chat-web「会话页源码模块划分」）：值导入只沿 page.tsx → use-chat-session.ts → turn-actions.ts。
import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listRepoFiles, readRepoFile, stripTsComments } from "./ui-support";

const CHAT = "web/src/features/chat";
const INDEX = `${CHAT}/index.ts`;
const PAGE = `${CHAT}/page.tsx`;
const CONVERT = `${CHAT}/runtime-convert.ts`;
const SESSION = `${CHAT}/use-chat-session.ts`;
const TURN = `${CHAT}/turn-actions.ts`;

const repoRoot = resolve(import.meta.dirname, "../..");
const isSource = (path: string) => /\.tsx?$/.test(path);

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g;

/** 导入说明符指向的模块（仓库相对路径，去掉 `.js` / `.ts` / `.tsx` 后缀）；包名返回 `null`。 */
function resolveModule(from: string, specifier: string): string | null {
  const bare = specifier.replace(/\.(?:js|tsx?)$/, "");
  if (bare.startsWith("@/")) return posix.normalize(`web/src/${bare.slice(2)}`);
  if (bare.startsWith(".")) return posix.join(posix.dirname(from), bare);
  return null;
}

/**
 * `from` 处的源码 `text` 是否导入模块 `module`（无后缀的仓库相对路径）：静态导入、`export … from`、
 * 动态 `import()` 都算；指向目录的说明符算作导入该目录的 `index`。
 */
function importsModule(from: string, text: string, module: string): boolean {
  return [...stripTsComments(text).matchAll(SPECIFIER)].some(([, specifier = ""]) => {
    const target = resolveModule(from, specifier);
    return target === module || `${target}/index` === module;
  });
}

/** `web/src` 与 `web/test` 里导入该模块的文件。 */
function importersOf(module: string): string[] {
  return [...listRepoFiles("web/src", isSource), ...listRepoFiles("web/test", isSource)].filter(
    (path) => importsModule(path, readRepoFile(path), module),
  );
}

describe("会话页源码模块划分", () => {
  it("页面只被 index.ts 导入；use-chat-session.ts 与 turn-actions.ts 不导入页面、不经 index 绕回", () => {
    expect(importersOf(`${CHAT}/page`)).toEqual([INDEX]);
    const viaIndex = importersOf(`${CHAT}/index`);
    expect(viaIndex.length).toBeGreaterThan(0);
    for (const downstream of [SESSION, TURN]) {
      expect(viaIndex, downstream).not.toContain(downstream);
    }
    expect(importersOf(`${CHAT}/use-chat-session`)).not.toContain(TURN);
  });

  it("导入者扫描自证：无后缀、带后缀、别名、再导出、动态导入与目录说明符都算，别处的同名模块与注释不算", () => {
    const page = `${CHAT}/page`;
    const from = (path: string, line: string, module = page) => importsModule(path, line, module);
    expect(from(SESSION, 'import { ChatPage } from "./page";')).toBe(true);
    expect(from(SESSION, 'import { ChatPage } from "./page.js";')).toBe(true);
    expect(from(SESSION, 'import type { X } from "../chat/page.tsx";')).toBe(true);
    expect(from(SESSION, 'export { ChatPage } from "./page.js";')).toBe(true);
    expect(from(SESSION, 'const page = await import("./page.js");')).toBe(true);
    // 别名说明符经变量拼入：写成字面量的话，这一行自己就成了对页面的导入。
    const alias = "@/features/chat/page";
    expect(from(SESSION, `import { ChatPage } from "${alias}";`)).toBe(true);
    expect(from(SESSION, '// import { ChatPage } from "./page.js";')).toBe(false);
    expect(from(SESSION, 'import { x } from "./page-support.js";')).toBe(false);
    expect(from("web/src/features/files/index.ts", 'export { F } from "./page.js";')).toBe(false);
    const index = `${CHAT}/index`;
    expect(from(TURN, 'import { ChatPage } from "./index.js";', index)).toBe(true);
    expect(from(TURN, 'import { ChatPage } from ".";', index)).toBe(true);
    expect(from("web/src/routes/a.tsx", 'import { C } from "../features/chat";', index)).toBe(true);
    expect(from(TURN, 'import { Icon } from "../../ui/index.js";', index)).toBe(false);
  });

  it("turn-actions.ts 的导出只被 use-chat-session.ts 消费，后者的导出只被 page.tsx 消费", () => {
    expect(importersOf(`${CHAT}/turn-actions`)).toEqual([SESSION]);
    expect(importersOf(`${CHAT}/use-chat-session`)).toEqual([PAGE]);
    expect(readRepoFile(PAGE)).toContain("useChatSession(");
    expect(readRepoFile(SESSION)).toContain("useTurnActions(");
  });

  it("runtime-convert.ts 是纯模块：不导入 React、不含 JSX、不持有模块级可变状态", () => {
    expect(existsSync(resolve(repoRoot, `${CHAT}/runtime-convert.tsx`))).toBe(false);
    const code = stripTsComments(readRepoFile(CONVERT));
    expect(code).toContain("export function convertMessage(");
    expect(code).not.toMatch(/from\s*["']react(?:-dom)?(?:\/[^"']*)?["']/);
    for (const impure of ["</", "/>", "<>", "createElement(", "useState", "useRef", "\nlet "]) {
      expect(code, impure).not.toContain(impure);
    }
    // 对运行时包只有类型导入（编译后不留痕迹）。
    const runtimeImports = code.match(/^import .*from "@assistant-ui\/react";$/gm) ?? [];
    expect(runtimeImports).toHaveLength(1);
    expect(runtimeImports[0]).toMatch(/^import type /);
  });

  it("use-chat-session.ts 不含 JSX、不渲染 UI", () => {
    expect(existsSync(resolve(repoRoot, `${CHAT}/use-chat-session.tsx`))).toBe(false);
    const code = stripTsComments(readRepoFile(SESSION));
    for (const jsx of ["</", "/>", "<>", "react/jsx-runtime", "createElement("]) {
      expect(code, jsx).not.toContain(jsx);
    }
  });

  it("公共入口只导出 ChatPage，页面状态与 fence 不留在 page.tsx", () => {
    expect(readRepoFile(`${CHAT}/index.ts`).trim()).toBe('export { ChatPage } from "./page.js";');
    const page = stripTsComments(readRepoFile(PAGE));
    expect(page).toContain("export function ChatPage(");
    for (const moved of [
      "useState(",
      "useState<",
      "useRef(",
      "useRef<",
      "useEffect(",
      "AbortController",
    ]) {
      expect(page, moved).not.toContain(moved);
    }
    expect(existsSync(resolve(repoRoot, `${CHAT}/stream-steps.ts`))).toBe(true);
  });
});
