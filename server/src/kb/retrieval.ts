/**
 * 单轮检索（s2b-kb-retrieval D1、D2、D3；knowledge-bases「单轮检索」，ADR-0017）：kb 模块里唯一的检索实现。检索测试端点
 * 与 S2c 的会话内检索工具都只经 `retrieveForBase` 检索；这里没有改写问句、充分性判定与第二轮。
 *
 * - 请求：对该库当前的 `datasetId`（不是 `rebuildDatasetId`）调一次客户端的检索方法，阈值与向量权重取该库行上已存的值，
 *   恒显式传，调用方不逐次覆盖。不判 `state`：`state` 的判定只约束检索测试端点（D4）。
 * - 映射：「检索失败」（本刀不带重排）为 `kb_unavailable`（D3）；`kb_rejected` / `kb_unavailable` 原样。调用方照 `bases.ts`
 *   的写法 `throw new HttpError(result.kind)`。
 * - 命中关联：切片的 RAGFlow 文档 id 只对本库的本地文档行（`listDocuments(base.id)`）关联，名称取本地记录；关联不上的丢弃，
 *   不暴露 RAGFlow 侧或别的库的文档名。同一文档的多条切片各成一条命中，次序同应答。零候选或全部丢弃时为空数组。
 *
 * 检索测试端点（D4；knowledge-bases「检索测试端点」）是 `createKbRetrieval` 的 `test`：判定次序为 body → 所有权重读 → `state` →
 * 参数比较（所有权的第一次判定在路由的 preParsing，先于 body 解析）。参数与已存值相同时不取锁、不写、不审计，直接检索。不同则经
 * `locks.write` 取该库写锁（重建器持锁即 409），锁内重读：不在 404，非 `ready` 409，再比较一次，仍不同才经 `saveRetrieval` 在同一
 * 事务里写两列并审计 `kb.retrieval_settings`（`before` 取锁内重读的值）。写入或审计失败时错误原样抛出，事务回滚，通用 500，
 * 不检索。检索在锁外，用的是库里存的行（写回的返回值或重读的行），不用请求 body；应答的 `retrieval` 同取这一行。
 */
import { HttpError } from "../core/errors/index.js";
import { ownedBase } from "./bases.js";
import type { createKbLocks } from "./locks.js";
import type { createRagflowClient } from "./ragflow-client.js";
import { isRecord, type Result, UNAVAILABLE } from "./ragflow-route.js";
import type { createKbStore, KbDocument, KnowledgeBase } from "./store.js";

const BODY_KEYS = ["question", "threshold", "vectorWeight"];
const MAX_QUESTION_CODE_POINTS = 1000;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const DEL = 0x7f;

/** 一条命中（D2）：`documentId` 是本地文档 id，`similarity` 与 `content` 原样取 RAGFlow 的值。 */
export interface RetrievalHit {
  documentId: string;
  name: string;
  similarity: number;
  content: string;
}

interface RetrievalDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "listDocuments">;
  client: Pick<ReturnType<typeof createRagflowClient>, "retrieve">;
}

interface RetrievalParameters {
  threshold: number;
  vectorWeight: number;
}

/** 通过了校验的检索测试 body。 */
interface TestRequest extends RetrievalParameters {
  question: string;
}

interface AuditEvent {
  kind: "kb.retrieval_settings";
  actorId: string;
  title: string;
  detail: { id: string; before: RetrievalParameters; after: RetrievalParameters };
}

interface KbRetrievalDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "getBase" | "listDocuments" | "saveRetrieval">;
  client: Pick<ReturnType<typeof createRagflowClient>, "retrieve">;
  locks: Pick<ReturnType<typeof createKbLocks>, "write">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
}

/** 对一个知识库的一次检索。 */
export async function retrieveForBase(
  deps: RetrievalDependencies,
  base: KnowledgeBase,
  question: string,
): Promise<Result<RetrievalHit[]>> {
  const result = await deps.client.retrieve({
    question,
    datasetId: base.datasetId,
    threshold: base.retrievalThreshold,
    vectorWeight: base.retrievalVectorWeight,
  });
  if (result.kind === "retrieval_failed") {
    return UNAVAILABLE;
  }
  if (result.kind !== "ok") {
    return result;
  }
  const local = new Map<string, KbDocument>(
    deps.store.listDocuments(base.id).map((document) => [document.ragflowDocumentId, document]),
  );
  const hits = result.value.flatMap((chunk): RetrievalHit[] => {
    const document = local.get(chunk.ragflowDocumentId);
    return document === undefined
      ? []
      : [
          {
            documentId: document.id,
            name: document.name,
            similarity: chunk.similarity,
            content: chunk.content,
          },
        ];
  });
  return { kind: "ok", value: hits };
}

/** C0 控制字符（`\t`、`\n` 除外）与 DEL。 */
function hasForbiddenCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== TAB && code !== LINE_FEED) || code === DEL) {
      return true;
    }
  }
  return false;
}

/** 去掉首尾空白后非空、至多 1000 码点、没有禁用字符；不 trim，原样发出。 */
const isQuestion = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  [...value].length <= MAX_QUESTION_CODE_POINTS &&
  !hasForbiddenCharacter(value);

/** 0–1 的有限数字，含两端（迁移 051 的 CHECK 是同一条规则）。 */
const isUnitInterval = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function parseTest(body: unknown): TestRequest {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== BODY_KEYS.length ||
    !BODY_KEYS.every((key) => Object.hasOwn(body, key))
  ) {
    throw new HttpError("bad_request");
  }
  const { question, threshold, vectorWeight } = body;
  if (!isQuestion(question) || !isUnitInterval(threshold) || !isUnitInterval(vectorWeight)) {
    throw new HttpError("bad_request");
  }
  return { question, threshold, vectorWeight };
}

const parametersOf = (base: KnowledgeBase): RetrievalParameters => ({
  threshold: base.retrievalThreshold,
  vectorWeight: base.retrievalVectorWeight,
});

/** 数值相等（D4）：界面以 0.01 为步长，JSON 往返不失真。 */
const sameParameters = (base: KnowledgeBase, request: RetrievalParameters): boolean =>
  base.retrievalThreshold === request.threshold &&
  base.retrievalVectorWeight === request.vectorWeight;

/** 写回只对 `ready` 的库（D4 第 3 步）：`rebuild_failed` 也拒。 */
function readyBase(
  store: KbRetrievalDependencies["store"],
  id: string,
  ownerId: string,
): KnowledgeBase {
  const base = ownedBase(store, id, ownerId);
  if (base.state !== "ready") {
    throw new HttpError("kb_rebuilding");
  }
  return base;
}

export function createKbRetrieval(dependencies: KbRetrievalDependencies) {
  const { store, locks, audit } = dependencies;

  /** 锁内：重读、再比较，仍不同才写两列并审计。返回检索要用的行。 */
  function saveLocked(id: string, request: TestRequest, ownerId: string): KnowledgeBase {
    const base = readyBase(store, id, ownerId);
    if (sameParameters(base, request)) {
      return base;
    }
    const after = { threshold: request.threshold, vectorWeight: request.vectorWeight };
    const saved = store.saveRetrieval(id, after, () => {
      audit({
        kind: "kb.retrieval_settings",
        actorId: ownerId,
        title: "修改检索参数",
        detail: { id, before: parametersOf(base), after },
      });
    });
    if (saved === undefined) {
      throw new HttpError("not_found");
    }
    return saved;
  }

  async function writeBack(id: string, request: TestRequest, ownerId: string) {
    const result = await locks.write(id, () =>
      Promise.resolve().then(() => saveLocked(id, request, ownerId)),
    );
    if (result.outcome === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    return result.value;
  }

  return {
    /** `POST /api/kb/bases/:id/retrieval`：200 恰为 `{hits, retrieval}`。检索本身不审计。 */
    async test(id: string, body: unknown, ownerId: string) {
      const request = parseTest(body);
      const base = readyBase(store, id, ownerId);
      const used = sameParameters(base, request) ? base : await writeBack(id, request, ownerId);
      const result = await retrieveForBase(dependencies, used, request.question);
      if (result.kind !== "ok") {
        throw new HttpError(result.kind);
      }
      return { hits: result.value, retrieval: parametersOf(used) };
    },
  };
}
