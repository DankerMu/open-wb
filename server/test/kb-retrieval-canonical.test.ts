/**
 * s2b-kb-retrieval tasks 4.3（#1916）：knowledge-bases「单轮检索」的「只有一处检索实现」与「`kb_search` 工具契约」的
 * 「契约与检索测试同源」，扫描 `server/src` 的源码。匹配规则是 tasks.md「组 4 首刀约定」的三条正则与正向对照：
 * - 词 `retrieve`（客户端检索方法名，#1913 定；解构、字符串键、`Pick<…, "retrieve">` 都算）只在 `kb/ragflow-retrieval.ts`
 *   与 `kb/retrieval.ts`；
 * - RAGFlow 的检索路由片段（`${API}` 或 `/api/v1` 加 `/retrieval`）只在 `kb/ragflow-retrieval.ts`；本系统自己的
 *   `/api/kb/bases/:id/retrieval` 不算；
 * - 工具名 `kb_search` 零出现（含注释；S2c 再改这条）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const RETRIEVE_WORD = /\bretrieve\b/;
const RAGFLOW_ROUTE = /(?:\$\{API\}|\/api\/v1)\/retrieval\b/;
const TOOL_NAME = /kb_search/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

/** `server/src` 下每个文件，键为以 `/` 分隔的相对路径。 */
const sources = new Map(
  walk(SRC).map((path) => [relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8")]),
);

const filesMatching = (pattern: RegExp) =>
  [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);

describe("只有一处检索实现（server/src 源码扫描）", () => {
  it("扫描到的文件集合含 kb/rest.ts（防空过）", () => {
    expect([...sources.keys()]).toContain("kb/rest.ts");
  });

  it("客户端检索方法名只出现在 kb/ragflow-retrieval.ts 与 kb/retrieval.ts，且 kb/retrieval.ts 确有调用", () => {
    const files = filesMatching(RETRIEVE_WORD);
    expect(
      files.filter((file) => file !== "kb/ragflow-retrieval.ts" && file !== "kb/retrieval.ts"),
    ).toEqual([]);
    expect(files).toContain("kb/retrieval.ts");
  });

  it("RAGFlow 检索路由片段只出现在 kb/ragflow-retrieval.ts，且它确有一处", () => {
    expect(filesMatching(RAGFLOW_ROUTE)).toEqual(["kb/ragflow-retrieval.ts"]);
  });

  it("本系统自己的检索端点路由串不触发路由正则", () => {
    expect(RAGFLOW_ROUTE.test("/api/kb/bases/:id/retrieval")).toBe(false);
    expect(RAGFLOW_ROUTE.test(`json("POST", \`\${API}/retrieval\`)`)).toBe(true);
    expect(RAGFLOW_ROUTE.test("POST /api/v1/retrieval")).toBe(true);
  });
});

describe("kb_search 工具契约：本 change 不注册、不分派", () => {
  it("kb_search 在 server/src 里零出现（含注释）", () => {
    expect(filesMatching(TOOL_NAME)).toEqual([]);
  });
});
