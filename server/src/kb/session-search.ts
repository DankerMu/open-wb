/**
 * 会话检索（s2c-kb-session D5；knowledge-bases「会话检索 `kb_search`」，ADR-0017）：给会话里的模型一个宿主工具的定义与执行，
 * 以及知识库引用的解析。`registerKb` 在知识库开启时建它并交回给 `app.ts`，由 `app.ts` 注入 sessions；kb 不导入 sessions，
 * 这里的结构类型由 sessions 侧各写同构的一份。
 *
 * - 「可见的库」只有一份读取：三个函数都经 `visibleBases(viewerId)` 读一次（D2 次序：自有在前，再按建库时间、id），按 id 建表。
 *   不在表里即 `not_found`：不存在与不可见是同一种结果，文本与 `details` 都不回显名称，不能据此探测别人的库。
 * - 检索只经单轮检索那一个函数（kb 里唯一的检索实现），带调用方的中止信号；`ready` 之外的库不检索。各库并发，参数取已存的值，不写回。
 * - 可见、`ready` 的非自有库先查中止信号，再写 `kb.shared_retrieval`（`shared-audit.ts`），写失败该库 `failed`、不检索；自有库不审计。
 * - 给模型的文本只有切片原文与出处（库、文档名、相似度），没有整篇文档（CONTEXT.md 不变量 2）；结构化命中只进 `details`。
 *   这里不写任何日志，切片原文不进日志与 stderr。
 * - 参数判定次序：键集 → `question`（与检索测试端点同一个判定函数）→ `kb_ids` 的形状 → 原始个数（1–5，与 schema `maxItems`
 *   同一口径）→ 按首次出现去重。
 *   参数错误的结果没有 `details` 键。
 */
import { isNonEmptyString, isRecord } from "./ragflow-route.js";
import { isQuestion, type RetrievalHit, retrieveForBase } from "./retrieval.js";
import { auditSharedRetrieval, type SharedRetrievalEvent } from "./shared-audit.js";
import type { KnowledgeBase } from "./store.js";
import type { BaseAccess, createKbVisibility } from "./visibility.js";

const TOOL_NAME = "kb_search";
const MAX_BASES = 5;
const ARG_KEYS = ["question", "kb_ids"];
const DESCRIPTION = [
  "检索当前账号可见的知识库（含共享给它的），返回与问句相关的切片与出处（知识库、文档名、相似度），不返回整篇文档。",
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
  visibility: Pick<ReturnType<typeof createKbVisibility>, "visibleBases">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: SharedRetrievalEvent) => void;
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
  if (kbIds.length === 0) {
    return "kb_ids 至少含一个知识库 id";
  }
  if (kbIds.length > MAX_BASES) {
    return `一次至多检索 ${MAX_BASES} 个知识库`;
  }
  return { question, kbIds: [...new Set(kbIds)] };
}

const outcome = (
  kbId: string,
  base: KnowledgeBase | undefined,
  status: BaseStatus,
  hits: RetrievalHit[] = [],
): BaseOutcome => ({ kbId, name: base?.name ?? null, status, hits });

function render(entry: BaseOutcome, state: KnowledgeBase["state"] | undefined): string {
  const label = `知识库「${entry.name}」（${entry.kbId}）`;
  switch (entry.status) {
    case "not_found":
      return `知识库 ${entry.kbId}：未找到该知识库`;
    case "not_ready":
      return `${label}：${state === "rebuild_failed" ? "重建失败" : "正在重建"}，本轮未检索`;
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
  const { visibility } = dependencies;

  const visibleOf = (viewerId: string): Map<string, BaseAccess> =>
    new Map(visibility.visibleBases(viewerId).map((access) => [access.base.id, access]));

  async function searchOne(
    kbId: string,
    access: BaseAccess | undefined,
    viewerId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<BaseOutcome> {
    const base = access?.base;
    if (access === undefined) {
      return outcome(kbId, base, "not_found");
    }
    if (access.base.state !== "ready") {
      return outcome(kbId, base, "not_ready");
    }
    if (!access.owned && signal.aborted) {
      return outcome(kbId, base, "failed");
    }
    try {
      auditSharedRetrieval(dependencies, viewerId, access);
    } catch {
      return outcome(kbId, base, "failed");
    }
    const result = await retrieveForBase(dependencies, access.base, question, signal);
    return result.kind === "ok"
      ? outcome(kbId, base, "ok", result.value)
      : outcome(kbId, base, "failed");
  }

  return {
    /** 该账号的工具定义与注册比较的库清单；可见的库一个都没有时为 `null`。不访问 RAGFlow。 */
    definitionFor(viewerId: string): { tool: KbSearchTool; bases: BaseRef[] } | null {
      const visible = [...visibleOf(viewerId).values()];
      if (visible.length === 0) {
        return null;
      }
      const bases = visible.map(({ base: { id, name } }) => ({ id, name }));
      const listed = visible.map(({ base: { id, name }, owned, owner }) =>
        owned ? `- ${name}（${id}）` : `- ${name}（${id}，所有者 ${owner.account}）`,
      );
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

    /** 以 `viewerId` 执行一次调用：逐库判定，`isError` 当且仅当没有一个库是 `ok`。 */
    async execute(viewerId: string, args: unknown, signal: AbortSignal): Promise<SearchResult> {
      const parsed = parseArgs(args);
      if (typeof parsed === "string") {
        return { text: parsed, isError: true };
      }
      const visible = visibleOf(viewerId);
      const bases = await Promise.all(
        parsed.kbIds.map((kbId) =>
          searchOne(kbId, visible.get(kbId), viewerId, parsed.question, signal),
        ),
      );
      return {
        text: bases.map((entry) => render(entry, visible.get(entry.kbId)?.base.state)).join("\n\n"),
        details: { bases },
        isError: !bases.some(({ status }) => status === "ok"),
      };
    },

    /** 知识库引用的解析：全部可见时按输入次序给 `{id, name}`（此刻的名称），否则 `null`。重复的 id 原样逐个解析。 */
    resolveReferences(viewerId: string, ids: readonly string[]): BaseRef[] | null {
      const visible = visibleOf(viewerId);
      const resolved: BaseRef[] = [];
      for (const id of ids) {
        const access = visible.get(id);
        if (access === undefined) {
          return null;
        }
        resolved.push({ id, name: access.base.name });
      }
      return resolved;
    },
  };
}
