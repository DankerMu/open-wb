import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/**
 * 知识库的 API 客户端（s2a-kb-ragflow design D19）：状态、设置、知识库、文档、上传，十四个方法对应十四条路由。
 * 应答形状以 knowledge-bases 与 ragflow-backend 两份 spec 为准，严格解析：多键、少键、类型不符即无效应答。
 * 只判键集、类型与枚举，不交叉判字段之间的关系（`chunkCount` 只在 `done` 时为数字之类是服务端的契约）。
 */

const TEMPLATES = [
  "naive",
  "book",
  "email",
  "laws",
  "manual",
  "one",
  "paper",
  "picture",
  "presentation",
  "qa",
  "table",
] as const;
const BASE_STATES = ["ready", "rebuilding", "rebuild_failed"] as const;
const COMPILE_STATES = ["pending", "running", "done", "failed", "off"] as const;
const DOCUMENT_SOURCES = ["workspace", "upload"] as const;
const DOCUMENT_STATUSES = [
  "queued",
  "parsing",
  "done",
  "failed",
  "cancelled",
  "unparsed",
  "missing",
] as const;
const REJECT_REASONS = [
  "outside",
  "not_file",
  "too_large",
  "unsupported_type",
  "empty",
  "offline",
  "duplicate",
  "limit",
  "changed",
  "rejected",
  "unavailable",
] as const;
const PROBE_STATUSES = ["never", "ok", "failed"] as const;

type CompileState = (typeof COMPILE_STATES)[number];

/** `GET /api/kb/status`：关闭时恰一键，开启时恰六键。 */
export type KbStatus =
  | { enabled: false }
  | {
      enabled: true;
      available: boolean;
      embeddingReady: boolean;
      compileReady: boolean;
      uploadMaxBytes: number;
      uploadMaxFiles: number;
    };

/** 嵌入或重排模型的读视图一项：两者同一形状。 */
type KbModelView = {
  name: string;
  baseUrl: string;
  probe: {
    status: (typeof PROBE_STATUSES)[number];
    message: string | null;
    at: number | null;
  };
};

/** 设置读视图：`GET` / `PUT /api/kb/settings`、`…/probe`、`…/rebuild` 共用，永不带密钥。 */
export type KbSettingsView = {
  embedding: KbModelView | null;
  chatModelId: string | null;
  rerank: KbModelView | null;
  bases: number;
  compileBases: number;
  documents: number;
  rebuilding: number;
  rebuildFailed: number;
};

/** 嵌入或重排模型的 input：`apiKey` 省略即保留已存的值。 */
type KbModelInput = { name: string; baseUrl: string; apiKey?: string };

/** `PUT /api/kb/settings` 的 body：`embedding`、`chatModelId` 与 `rerank` 至少含其一，只发所给的键；`rerank:null` 即清除。 */
export type UpdateKbSettingsInput = { confirmRebuild?: true } & (
  | { embedding: KbModelInput; chatModelId?: string | null; rerank?: KbModelInput | null }
  | { embedding?: KbModelInput; chatModelId: string | null; rerank?: KbModelInput | null }
  | { embedding?: KbModelInput; chatModelId?: string | null; rerank: KbModelInput | null }
);

/** `compile` 为 `null`：这一次没有读到编译状态。 */
export type BaseView = {
  id: string;
  name: string;
  template: (typeof TEMPLATES)[number];
  raptor: boolean;
  graph: boolean;
  state: (typeof BASE_STATES)[number];
  stateMessage: string | null;
  documents: number;
  compile: { raptor: CompileState; graph: CompileState } | null;
  /** 该库的检索参数；0–1 由服务端保证。 */
  retrieval: { threshold: number; vectorWeight: number };
  createdAt: number;
};

/** `POST /api/kb/bases` 的 body：只发所给的键。 */
export type CreateKnowledgeBaseInput = {
  name: string;
  template: BaseView["template"];
  raptor?: boolean;
  graph?: boolean;
};

/** `chunkCount` 可以是 0；`sourceChanged` 的 `null` 是「不知道」或本地上传。 */
export type DocumentView = {
  id: string;
  name: string;
  size: number;
  source: (typeof DOCUMENT_SOURCES)[number];
  workspaceId: string | null;
  path: string | null;
  status: (typeof DOCUMENT_STATUSES)[number];
  chunkCount: number | null;
  message: string | null;
  sourceChanged: boolean | null;
  createdAt: number;
};

/** `POST …/documents` 的 body。 */
export type IngestFromWorkspaceInput = { workspaceId: string; paths: readonly string[] };

/** `POST …/documents` 的应答：请求合法即 201，被拒的条目逐条进 `rejected`。 */
export type KbIngestResult = {
  documents: DocumentView[];
  rejected: { path: string; reason: (typeof REJECT_REASONS)[number]; message: string }[];
};

/** 检索测试的一条命中：`documentId` 是本地文档 id；同一文档可有多条，次序同应答。 */
export type RetrievalHit = {
  documentId: string;
  name: string;
  similarity: number;
  content: string;
};

/** `POST …/retrieval` 的 body：原样序列化，不 trim。 */
export type KbRetrievalInput = { question: string; threshold: number; vectorWeight: number };

/** `POST …/retrieval` 的 200 应答：`hits` 可为空数组，`retrieval` 是写回后该库存的参数。 */
export type KbRetrievalResult = { hits: RetrievalHit[]; retrieval: BaseView["retrieval"] };

type KbTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  noContentRequest(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
  ): Promise<void>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
};

type KbMethods = Pick<
  ApiClient,
  | "getKbStatus"
  | "getKbSettings"
  | "updateKbSettings"
  | "probeKbEmbedding"
  | "retryKbRebuild"
  | "listKnowledgeBases"
  | "createKnowledgeBase"
  | "deleteKnowledgeBase"
  | "listKbDocuments"
  | "ingestFromWorkspace"
  | "uploadToKnowledgeBase"
  | "reingestKbDocument"
  | "removeKbDocument"
  | "retrieveFromKnowledgeBase"
>;

const STATUS_KEYS = [
  "enabled",
  "available",
  "embeddingReady",
  "compileReady",
  "uploadMaxBytes",
  "uploadMaxFiles",
];
const SETTINGS_KEYS = [
  "embedding",
  "chatModelId",
  "rerank",
  "bases",
  "compileBases",
  "documents",
  "rebuilding",
  "rebuildFailed",
];
const BASE_KEYS = [
  "id",
  "name",
  "template",
  "raptor",
  "graph",
  "state",
  "stateMessage",
  "documents",
  "compile",
  "retrieval",
  "createdAt",
];
const DOCUMENT_KEYS = [
  "id",
  "name",
  "size",
  "source",
  "workspaceId",
  "path",
  "status",
  "chunkCount",
  "message",
  "sourceChanged",
  "createdAt",
];

function isOneOf<T>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

/** 两个上传上限是配置值，服务端按正整数解析，`0` 不会出现。 */
function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function parseStatus(value: unknown): KbStatus | null {
  if (hasExactlyKeys(value, ["enabled"])) {
    return value.enabled === false ? { enabled: false } : null;
  }
  if (!hasExactlyKeys(value, STATUS_KEYS)) {
    return null;
  }
  const { enabled, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles } =
    value;
  return enabled === true &&
    typeof available === "boolean" &&
    typeof embeddingReady === "boolean" &&
    typeof compileReady === "boolean" &&
    isPositiveSafeInteger(uploadMaxBytes) &&
    isPositiveSafeInteger(uploadMaxFiles)
    ? { enabled, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles }
    : null;
}

function parseProbe(value: unknown): KbModelView["probe"] | null {
  if (!hasExactlyKeys(value, ["status", "message", "at"])) {
    return null;
  }
  const { status, message, at } = value;
  return isOneOf(PROBE_STATUSES, status) && isNullableString(message) && isNullableCount(at)
    ? { status, message, at }
    : null;
}

/** `embedding` 与 `rerank` 共用。`null` 是合法值（尚未配置），所以无效应答用 `undefined` 表示。 */
function parseModel(value: unknown): KbModelView | null | undefined {
  if (value === null) {
    return null;
  }
  if (!hasExactlyKeys(value, ["name", "baseUrl", "probe"])) {
    return undefined;
  }
  const { name, baseUrl } = value;
  const probe = parseProbe(value.probe);
  return typeof name === "string" && typeof baseUrl === "string" && probe
    ? { name, baseUrl, probe }
    : undefined;
}

function parseSettings(value: unknown): KbSettingsView | null {
  if (!hasExactlyKeys(value, SETTINGS_KEYS)) {
    return null;
  }
  const { chatModelId, bases, compileBases, documents, rebuilding, rebuildFailed } = value;
  const embedding = parseModel(value.embedding);
  const rerank = parseModel(value.rerank);
  return embedding !== undefined &&
    rerank !== undefined &&
    isNullableString(chatModelId) &&
    isNonNegativeSafeInteger(bases) &&
    isNonNegativeSafeInteger(compileBases) &&
    isNonNegativeSafeInteger(documents) &&
    isNonNegativeSafeInteger(rebuilding) &&
    isNonNegativeSafeInteger(rebuildFailed)
    ? {
        embedding,
        chatModelId,
        rerank,
        bases,
        compileBases,
        documents,
        rebuilding,
        rebuildFailed,
      }
    : null;
}

/** `null` 是合法值（这一次没有读到），所以无效应答用 `undefined` 表示。 */
function parseCompile(value: unknown): BaseView["compile"] | undefined {
  if (value === null) {
    return null;
  }
  if (!hasExactlyKeys(value, ["raptor", "graph"])) {
    return undefined;
  }
  const { raptor, graph } = value;
  return isOneOf(COMPILE_STATES, raptor) && isOneOf(COMPILE_STATES, graph)
    ? { raptor, graph }
    : undefined;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** 只认两键的有限数字，不在 web 侧校验 0–1（服务端 CHECK 是权威）。 */
function parseRetrieval(value: unknown): BaseView["retrieval"] | null {
  if (!hasExactlyKeys(value, ["threshold", "vectorWeight"])) {
    return null;
  }
  const { threshold, vectorWeight } = value;
  return isFiniteNumber(threshold) && isFiniteNumber(vectorWeight)
    ? { threshold, vectorWeight }
    : null;
}

function parseBaseView(value: unknown): BaseView | null {
  if (!hasExactlyKeys(value, BASE_KEYS)) {
    return null;
  }
  const { id, name, template, raptor, graph, state, stateMessage, documents, createdAt } = value;
  const compile = parseCompile(value.compile);
  const retrieval = parseRetrieval(value.retrieval);
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !isOneOf(TEMPLATES, template) ||
    typeof raptor !== "boolean" ||
    typeof graph !== "boolean" ||
    !isOneOf(BASE_STATES, state) ||
    !isNullableString(stateMessage) ||
    !isNonNegativeSafeInteger(documents) ||
    compile === undefined ||
    retrieval === null ||
    !isNonNegativeSafeInteger(createdAt)
  ) {
    return null;
  }
  return {
    id,
    name,
    template,
    raptor,
    graph,
    state,
    stateMessage,
    documents,
    compile,
    retrieval,
    createdAt,
  };
}

function parseBaseList(value: unknown): BaseView[] | null {
  return hasExactlyKeys(value, ["bases"]) ? parseJsonArray(value.bases, parseBaseView) : null;
}

function parseDocumentView(value: unknown): DocumentView | null {
  if (!hasExactlyKeys(value, DOCUMENT_KEYS)) {
    return null;
  }
  const {
    id,
    name,
    size,
    source,
    workspaceId,
    path,
    status,
    chunkCount,
    message,
    sourceChanged,
    createdAt,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !isNonNegativeSafeInteger(size) ||
    !isOneOf(DOCUMENT_SOURCES, source) ||
    !isNullableString(workspaceId) ||
    !isNullableString(path) ||
    !isOneOf(DOCUMENT_STATUSES, status) ||
    !isNullableCount(chunkCount) ||
    !isNullableString(message) ||
    (sourceChanged !== null && typeof sourceChanged !== "boolean") ||
    !isNonNegativeSafeInteger(createdAt)
  ) {
    return null;
  }
  return {
    id,
    name,
    size,
    source,
    workspaceId,
    path,
    status,
    chunkCount,
    message,
    sourceChanged,
    createdAt,
  };
}

function parseDocumentList(value: unknown): DocumentView[] | null {
  return hasExactlyKeys(value, ["documents"])
    ? parseJsonArray(value.documents, parseDocumentView)
    : null;
}

function parseRejected(value: unknown): KbIngestResult["rejected"][number] | null {
  if (!hasExactlyKeys(value, ["path", "reason", "message"])) {
    return null;
  }
  const { path, reason, message } = value;
  return typeof path === "string" && isOneOf(REJECT_REASONS, reason) && typeof message === "string"
    ? { path, reason, message }
    : null;
}

function parseIngestResult(value: unknown): KbIngestResult | null {
  if (!hasExactlyKeys(value, ["documents", "rejected"])) {
    return null;
  }
  const documents = parseJsonArray(value.documents, parseDocumentView);
  const rejected = parseJsonArray(value.rejected, parseRejected);
  return documents && rejected ? { documents, rejected } : null;
}

/** 与 `parseRetrieval` 一致，`similarity` 只认有限数字，不在 web 侧校验 0–1。 */
function parseRetrievalHit(value: unknown): RetrievalHit | null {
  if (!hasExactlyKeys(value, ["documentId", "name", "similarity", "content"])) {
    return null;
  }
  const { documentId, name, similarity, content } = value;
  return typeof documentId === "string" &&
    typeof name === "string" &&
    isFiniteNumber(similarity) &&
    typeof content === "string"
    ? { documentId, name, similarity, content }
    : null;
}

function parseRetrievalResult(value: unknown): KbRetrievalResult | null {
  if (!hasExactlyKeys(value, ["hits", "retrieval"])) {
    return null;
  }
  const hits = parseJsonArray(value.hits, parseRetrievalHit);
  const retrieval = parseRetrieval(value.retrieval);
  return hits && retrieval ? { hits, retrieval } : null;
}

function basePath(id: string): string {
  return `/api/kb/bases/${encodeURIComponent(id)}`;
}

function documentPath(baseId: string, suffix: string, documentId: string): string {
  return `${basePath(baseId)}/documents${suffix}?doc=${encodeURIComponent(documentId)}`;
}

function jsonBody(method: "POST" | "PUT", body: unknown, base: RequestInit): RequestInit {
  return {
    ...base,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createKbMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, noContentRequest, requestOptions, getRequestOptions, requestFailed }: KbTransport,
): KbMethods {
  /** 一次请求加严格解析；`status` 同时是期望的成功状态码与解析失败时 `requestFailed` 的 status。 */
  async function parsed<T>(
    path: string,
    init: RequestInit,
    status: number,
    parse: (value: unknown) => T | null,
  ): Promise<T> {
    const result = parse(await request(path, init, onUnauthorized, status));
    if (result === null) {
      throw requestFailed(status);
    }
    return result;
  }
  /** 无 body 的 POST：不带 body，也不带 Content-Type（路由见到任意 body 即 400）。 */
  const bodyless = (signal?: AbortSignal): RequestInit => ({
    ...requestOptions(signal),
    method: "POST",
  });
  const remove = (path: string, signal?: AbortSignal) =>
    noContentRequest(path, { ...requestOptions(signal), method: "DELETE" }, onUnauthorized);

  return {
    getKbStatus(options) {
      return parsed("/api/kb/status", getRequestOptions(options?.signal), 200, parseStatus);
    },

    getKbSettings(options) {
      return parsed("/api/kb/settings", getRequestOptions(options?.signal), 200, parseSettings);
    },

    updateKbSettings(input, options) {
      const init = jsonBody("PUT", input, requestOptions(options?.signal));
      return parsed("/api/kb/settings", init, 200, parseSettings);
    },

    probeKbEmbedding(options) {
      return parsed("/api/kb/settings/probe", bodyless(options?.signal), 200, parseSettings);
    },

    retryKbRebuild(options) {
      return parsed("/api/kb/settings/rebuild", bodyless(options?.signal), 200, parseSettings);
    },

    listKnowledgeBases(options) {
      return parsed("/api/kb/bases", getRequestOptions(options?.signal), 200, parseBaseList);
    },

    createKnowledgeBase(input, options) {
      const init = jsonBody("POST", input, requestOptions(options?.signal));
      return parsed("/api/kb/bases", init, 201, parseBaseView);
    },

    deleteKnowledgeBase(id, options) {
      return remove(basePath(id), options?.signal);
    },

    listKbDocuments(baseId, options) {
      const path = `${basePath(baseId)}/documents`;
      return parsed(path, getRequestOptions(options?.signal), 200, parseDocumentList);
    },

    ingestFromWorkspace(baseId, input, options) {
      const init = jsonBody("POST", input, requestOptions(options?.signal));
      return parsed(`${basePath(baseId)}/documents`, init, 201, parseIngestResult);
    },

    /** 请求体就是 File：`fetch` 按它的大小带 `Content-Length`，路由缺这个头即 400。 */
    uploadToKnowledgeBase(baseId, file, options) {
      const path = `${basePath(baseId)}/uploads?name=${encodeURIComponent(file.name)}`;
      const init = {
        ...requestOptions(options?.signal),
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      };
      return parsed(path, init, 201, parseDocumentView);
    },

    reingestKbDocument(baseId, documentId, options) {
      const path = documentPath(baseId, "/reingest", documentId);
      return parsed(path, bodyless(options?.signal), 200, parseDocumentView);
    },

    removeKbDocument(baseId, documentId, options) {
      return remove(documentPath(baseId, "", documentId), options?.signal);
    },

    retrieveFromKnowledgeBase(id, input, options) {
      return parsed(
        `${basePath(id)}/retrieval`,
        jsonBody("POST", input, requestOptions(options?.signal)),
        200,
        parseRetrievalResult,
      );
    },
  };
}
