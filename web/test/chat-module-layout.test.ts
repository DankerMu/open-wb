// 会话页源码模块划分（chat-web「会话页源码模块划分」）：值导入只沿 page.tsx → use-chat-session.ts → turn-actions.ts。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listRepoFiles, readRepoFile, stripTsComments } from "./ui-support";

const CHAT = "web/src/features/chat";
const PAGE = `${CHAT}/page.tsx`;
const SESSION = `${CHAT}/use-chat-session.ts`;
const TURN = `${CHAT}/turn-actions.ts`;

const repoRoot = resolve(import.meta.dirname, "../..");
const isSource = (path: string) => /\.tsx?$/.test(path);

/** `web/src` 与 `web/test` 里导入（含 `export … from`、动态 `import()`）该模块的文件。 */
function importersOf(moduleFile: string): string[] {
  const specifier = new RegExp(
    `\\b(?:from|import)\\s*\\(?\\s*["'][^"'\\n]*/${moduleFile}(?:\\.js|\\.tsx?)?["']`,
  );
  return [...listRepoFiles("web/src", isSource), ...listRepoFiles("web/test", isSource)].filter(
    (path) => specifier.test(stripTsComments(readRepoFile(path))),
  );
}

describe("会话页源码模块划分", () => {
  it("use-chat-session.ts 与 turn-actions.ts 不导入页面，turn-actions.ts 不导入 hook", () => {
    const session = readRepoFile(SESSION);
    const turn = readRepoFile(TURN);
    expect(session).not.toContain("./page.js");
    expect(turn).not.toContain("./page.js");
    expect(turn).not.toContain("./use-chat-session.js");
  });

  it("turn-actions.ts 的导出只被 use-chat-session.ts 消费，后者的导出只被 page.tsx 消费", () => {
    expect(importersOf("turn-actions")).toEqual([SESSION]);
    expect(importersOf("use-chat-session")).toEqual([PAGE]);
    expect(readRepoFile(PAGE)).toContain("useChatSession(");
    expect(readRepoFile(SESSION)).toContain("useTurnActions(");
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
