/**
 * s2b-kb-retrieval tasks 4.3（#1916）：knowledge-bases「单轮检索」的「只有一处检索实现」，扫描 `server/src` 的源码。匹配规则是
 * tasks.md「组 4 首刀约定」的正则与正向对照，s2c-kb-session tasks 2.5（#1963）加会话检索一条：
 * - 词 `retrieve`（客户端检索方法名，#1913 定；解构、字符串键、`Pick<…, "retrieve">` 都算）只在 `kb/ragflow-retrieval.ts`
 *   与 `kb/retrieval.ts`；
 * - RAGFlow 的检索路由片段（`${API}` 或 `/api/v1` 加 `/retrieval`）只在 `kb/ragflow-retrieval.ts`；本系统自己的
 *   `/api/kb/bases/:id/retrieval` 不算；
 * - 会话检索 `kb/session-search.ts` 在扫描集合里，且调用单轮检索 `retrieveForBase`：它不调客户端的检索方法由第一条保证。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const RETRIEVE_WORD = /\bretrieve\b/;
const RAGFLOW_ROUTE = /(?:\$\{API\}|\/api\/v1)\/retrieval\b/;
const SINGLE_ROUND_CALL = /\bretrieveForBase\(/;

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

  it("会话检索只经单轮检索：kb/session-search.ts 在扫描集合里，且调用 retrieveForBase", () => {
    expect([...sources.keys()]).toContain("kb/session-search.ts");
    expect(sources.get("kb/session-search.ts")).toMatch(SINGLE_ROUND_CALL);
  });

  it("本系统自己的检索端点路由串不触发路由正则", () => {
    expect(RAGFLOW_ROUTE.test("/api/kb/bases/:id/retrieval")).toBe(false);
    expect(RAGFLOW_ROUTE.test(`json("POST", \`\${API}/retrieval\`)`)).toBe(true);
    expect(RAGFLOW_ROUTE.test("POST /api/v1/retrieval")).toBe(true);
  });
});
