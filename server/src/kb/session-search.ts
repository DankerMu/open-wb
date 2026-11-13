/**
 * 会话检索（s2c-kb-session D5；knowledge-bases「会话检索 `kb_search`」，ADR-0017）：给会话里的模型一个宿主工具的定义与执行，
 * 以及知识库引用的解析。`registerKb` 在知识库开启时建它并交回给 `app.ts`，由 `app.ts` 注入 sessions；kb 不导入 sessions，
 * 这里的结构类型由 sessions 侧各写同构的一份。
 *
 * - 「该账号的库」只有一份读取：三个函数都经 `listBases(ownerId)` 读一次（本地库表，按建库时间升序），按 id 建表判定。
 *   不在表里即 `not_found`：不存在与属于别人是同一种结果，文本与 `details` 都不回显名称，不能据此探测别人的库。
 * - 检索只经单轮检索那一个函数（kb 里唯一的检索实现），带调用方的中止信号；`ready` 之外的库不检索。各库彼此并发。
 *   参数取该库已存的值，这里不写回、不审计。
 * - 给模型的文本只有切片原文与出处（库、文档名、相似度），没有整篇文档（CONTEXT.md 不变量 2）；结构化命中只进 `details`。
 *   这里不写任何日志，切片原文不进日志与 stderr。
 * - 参数判定次序：键集 → `question`（与检索测试端点同一个判定函数）→ `kb_ids` 的形状 → 按首次出现去重后的个数（1–5）。
 *   参数错误的结果没有 `details` 键。
 */
import { isNonEmptyString, isRecord } from "./ragflow-route.js";
import { isQuestion, type RetrievalHit, retrieveForBase } from "./retrieval.js";
import type { createKbStore, KnowledgeBase } from "./store.js";

const TOOL_NAME = "kb_search";
const MAX_BASES = 5;
const ARG_KEYS = ["question", "kb_ids"];
const DESCRIPTION = [
  "检索当前账号的知识库，返回与问句相关的切片与出处（知识库、文档名、相似度），不返回整篇文档。",
  "一次至多检索 5 个知识库，每个知识库至多返回 6 条命中。",
  "证据不足时可以改写问句或换库再次调用。",
  "可检索的知识库：",
].join("\n");
const PARAMETERS = {
  type: "object",
  properties: {
    question: { type: "string" },
    kb_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_BASES },
  },
  required: ["question", "kb_ids"],
  additionalProperties: false,
};

type SingleRoundDependencies = Parameters<typeof retrieveForBase>[0];

interface SessionSearchDependencies extends SingleRoundDependencies {
  store: SingleRoundDependencies["store"] & Pick<ReturnType<typeof createKbStore>, "listBases">;
}

interface BaseRef {
  id: string;
  name: string;
}

/** 宿主工具定义，键集与次序固定。 */
interface KbSearchTool {
  name: string;
  label: string;
  description: string;
  parameters: typeof PARAMETERS;
  loadMode: "essential";
}

type BaseStatus = "ok" | "not_found" | "not_ready" | "failed";

interface BaseOutcome {
  kbId: string;
  name: string | null;
  status: BaseStatus;
  hits: RetrievalHit[];
}

interface SearchResult {
  text: string;
  details?: { bases: BaseOutcome[] };
  isError: boolean;
}

interface SearchArgs {
  question: string;
  kbIds: string[];
}

/** 合规时给出去重后的参数，否则给出说明不符之处的文本。 */
function parseArgs(args: unknown): SearchArgs | string {
  if (
    !isRecord(args) ||
    Object.keys(args).length !== ARG_KEYS.length ||
    !ARG_KEYS.every((key) => Object.hasOwn(args, key))
  ) {
    return "参数须恰为 question 与 kb_ids";
  }
  const { question, kb_ids: kbIds } = args;
  if (!isQuestion(question)) {
    return "question 须为非空字符串，至多 1000 字，不含控制字符";
  }
  if (!Array.isArray(kbIds) || !kbIds.every(isNonEmptyString)) {
    return "kb_ids 须为由非空字符串组成的数组";
  }
  const unique = [...new Set(kbIds)];
  if (unique.length === 0) {
    return "kb_ids 至少含一个知识库 id";
  }
  if (unique.length > MAX_BASES) {
    return `一次至多检索 ${MAX_BASES} 个知识库`;
  }
  return { question, kbIds: unique };
}

const outcome = (
  kbId: string,
  base: KnowledgeBase | undefined,
  status: BaseStatus,
  hits: RetrievalHit[] = [],
): BaseOutcome => ({ kbId, name: base?.name ?? null, status, hits });

function render(entry: BaseOutcome): string {
  const label = `知识库「${entry.name}」（${entry.kbId}）`;
  switch (entry.status) {
    case "not_found":
      return `知识库 ${entry.kbId}：未找到该知识库`;
    case "not_ready":
      return `${label}：正在重建，本轮未检索`;
    case "failed":
      return `${label}：检索失败`;
    case "ok":
      return [
        `${label}：命中 ${entry.hits.length} 条`,
        ...entry.hits.flatMap((hit, index) => [
          `[${index + 1}] ${hit.name}（相似度 ${hit.similarity.toFixed(4)}）`,
          hit.content,
        ]),
      ].join("\n");
  }
}

export function createKbSessionSearch(dependencies: SessionSearchDependencies) {
  const { store } = dependencies;

  const ownedBases = (ownerId: string): Map<string, KnowledgeBase> =>
    new Map(store.listBases(ownerId).map((base) => [base.id, base]));

  async function searchOne(
    kbId: string,
    base: KnowledgeBase | undefined,
    question: string,
    signal: AbortSignal,
  ): Promise<BaseOutcome> {
    if (base === undefined) {
      return outcome(kbId, base, "not_found");
    }
    if (base.state !== "ready") {
      return outcome(kbId, base, "not_ready");
    }
    const result = await retrieveForBase(dependencies, base, question, signal);
    return result.kind === "ok"
      ? outcome(kbId, base, "ok", result.value)
      : outcome(kbId, base, "failed");
  }

  return {
    /** 该账号的工具定义与注册比较的库清单；一个库都没有时为 `null`。不访问 RAGFlow。 */
    definitionFor(ownerId: string): { tool: KbSearchTool; bases: BaseRef[] } | null {
      const bases = store.listBases(ownerId).map(({ id, name }) => ({ id, name }));
      if (bases.length === 0) {
        return null;
      }
      const listed = bases.map(({ id, name }) => `- ${name}（${id}）`);
      return {
        tool: {
          name: TOOL_NAME,
          label: "知识库检索",
          description: [DESCRIPTION, ...listed].join("\n"),
          parameters: PARAMETERS,
          loadMode: "essential",
        },
        bases,
      };
    },

    /** 以 `ownerId` 执行一次调用：逐库判定，`isError` 当且仅当没有一个库是 `ok`。 */
    async execute(ownerId: string, args: unknown, signal: AbortSignal): Promise<SearchResult> {
      const parsed = parseArgs(args);
      if (typeof parsed === "string") {
        return { text: parsed, isError: true };
      }
      const owned = ownedBases(ownerId);
      const bases = await Promise.all(
        parsed.kbIds.map((kbId) => searchOne(kbId, owned.get(kbId), parsed.question, signal)),
      );
      return {
        text: bases.map(render).join("\n\n"),
        details: { bases },
        isError: !bases.some(({ status }) => status === "ok"),
      };
    },

    /** 知识库引用的解析：全部是该账号的库时按输入次序给 `{id, name}`，否则 `null`。重复的 id 原样逐个解析。 */
    resolveReferences(ownerId: string, ids: readonly string[]): BaseRef[] | null {
      const owned = ownedBases(ownerId);
      const resolved: BaseRef[] = [];
      for (const id of ids) {
        const base = owned.get(id);
        if (base === undefined) {
          return null;
        }
        resolved.push({ id, name: base.name });
      }
      return resolved;
    },
  };
}
