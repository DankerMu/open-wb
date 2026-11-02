/**
 * RAGFlow 客户端：`kb` 模块唯一的出站点（s2a-kb-ragflow D4；ragflow-backend「RAGFlow 出站请求」）。
 *
 * 三种调用，都是 `agent:false`、不跟随重定向、不重试：
 * - JSON：连接 10 s、总 30 s（版本接口总 5 s，D5），响应体至多 1 MiB，超出即失败。
 * - 流式上传：连接 10 s、空闲 60 s，没有总期限；调用方给好 multipart 的流与长度（`kb/multipart.ts`，组 10）。
 * - 流式下载：同上，按响应头判别（D8）：HTTP 200 且带 `Content-Disposition` 是文件，正文一律不解析；否则按
 *   JSON 读。文件流交出之后空闲期限照走，到期时流报错。
 *
 * 对外是一个路由一个方法，三种调用本身不导出：调用方拼不出路径，所以 `GET …/instances/<实例>`（明文回显上游
 * 密钥）、清空账号缺省与 `/providers` 下的删除（D7）在这里根本没有写法，不靠黑名单。`PATCH /models/default` 是设与
 * 清共用的路径，`setDefaultModel` 拒绝空名字，所以这个调用面只能设。模型下发一块在 `ragflow-models.ts`，判定原语在
 * `ragflow-route.ts`：兄弟文件只在 `createRagflowClient` 里经闭包参数拿到 `json`，模块级没有发请求的写法。
 *
 * 结果按次序判定：路由专属组合（只认 HTTP 200，实测全部如此，§12 未知路由的 HTTP 404 + `code:404` 不能算不存
 * 在）→ 2xx 且 `code:0` → `code` 101 / 102 为 `kb_rejected` → HTTP 401 或 `code` 401 / 403 为 `kb_unavailable`
 * 并写一行 `kb_upstream_auth_failed`（60 秒至多一行）→ 其余 `kb_unavailable`。3xx 不读正文。
 *
 * RAGFlow 的 message 只用于上面的前缀判定，结果只有 `kind` 与调用点要读的字段，不带 message、正文与原始 `code`。
 * 密钥只进请求头，一个请求读一次句柄。任何错误都不外抛：不发出的请求（空 id、空 `api_key`）同样是
 * `kb_unavailable`，绝不能是 `not_found`，那会被调用点当成已删除。
 *
 * 重建器用到的方法收一个可选的 `signal`（#1852，关停时中止在途请求）：中止与期限到期同一写法，结果是 `kb_unavailable`；
 * 已中止的不发出。文件流交出之后照样受它管：中止即销毁请求，流报错。上传的请求体随出站销毁。
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import type { KbKeyHandle } from "./key-file.js";
import { modelCalls } from "./ragflow-models.js";
import {
  API,
  type Envelope,
  fieldOf,
  isNonEmptyString,
  isRecord,
  REJECTED,
  type Result,
  type Route,
  UNAVAILABLE,
  usable,
} from "./ragflow-route.js";

export { isBlankApiKey, type ModelInfo, PROVIDER } from "./ragflow-models.js";
export { isRecord } from "./ragflow-route.js";

const CONNECT_MS = 10_000;
const TOTAL_MS = 30_000;
const VERSION_TOTAL_MS = 5_000;
const IDLE_MS = 60_000;
const MAX_JSON_BYTES = 1_048_576;
const RECORD_INTERVAL_MS = 60_000;
const PAGE_SIZE = 100;
const NOT_FOUND = { kind: "not_found" } as const;
const UNSUPPORTED_FILE = { kind: "unsupported_file" } as const;
const PARSE_NOT_STARTED = { kind: "parse_not_started" } as const;
const NOT_DELETED = { kind: "not_deleted" } as const;

/** `status: null`：没有等到应答头。`body` 为 `undefined`：正文读不全、超限或不是 JSON。 */
interface Answer {
  status: number | null;
  body?: unknown;
}

type Wire = Answer | { file: Readable };

const NO_ANSWER: Answer = { status: null };

interface Outbound {
  method: string;
  path: string;
  /** 只有版本接口是 false。 */
  keyed: boolean;
  /** 有它即 JSON 调用的总期限；没有即按空闲期限。 */
  totalMs?: number;
  json?: unknown;
  upload?: Upload;
  /** 下载：应答可以是文件。 */
  file?: boolean;
  signal?: AbortSignal | undefined;
}

interface Upload {
  body: Readable;
  contentType: string;
  contentLength: number;
}

type Json = Record<string, unknown>;

export interface ListedDocument {
  id: string;
  ingestionStatus: string;
  chunkCount: number;
}

export interface Deadlines {
  connectMs: number;
  totalMs: number;
  versionTotalMs: number;
  idleMs: number;
}

function envelopeOf(body: unknown): Envelope | undefined {
  return isRecord(body) ? { code: body.code, message: body.message, data: body.data } : undefined;
}

const messageStarts = (envelope: Envelope, prefix: string): boolean =>
  typeof envelope.message === "string" && envelope.message.startsWith(prefix);

const unitWhen = (holds: boolean): null | undefined => (holds ? null : undefined);

/** 删画布与删模板组的成功应答（§5.1 (7)）。 */
const deleted = (data: unknown): null | undefined => unitWhen(data === true);

const VERSION: Route<string, never> = {
  read: (data) => (isNonEmptyString(data) ? data : undefined),
};

/** 建数据集、模板组与画布的应答：都只读 `data.id`。 */
const CREATED: Route<{ id: string }, never> = {
  read(data) {
    const id = fieldOf(data, "id");
    return isNonEmptyString(id) ? { id } : undefined;
  },
};

const DELETE_DATASET: Route<null, typeof NOT_FOUND> = {
  typed: (envelope) => (envelope.code === 403 ? NOT_FOUND : undefined),
  read: (data) => unitWhen(fieldOf(data, "success_count") === 1),
};

const LIST_DOCUMENTS: Route<{ documents: ListedDocument[]; total: number }, typeof NOT_FOUND> = {
  typed: (envelope) => (envelope.code === 404 ? NOT_FOUND : undefined),
  read(data) {
    const docs = fieldOf(data, "docs");
    const total = fieldOf(data, "total");
    if (!Array.isArray(docs) || typeof total !== "number") {
      return undefined;
    }
    const documents = docs.flatMap((row: unknown) => listedRow(row) ?? []);
    return documents.length === docs.length ? { documents, total } : undefined;
  },
};

/** `status` 恒为 `"1"`，运行状态是 `ingestion_status`（§8.3）。 */
function listedRow(row: unknown): ListedDocument | undefined {
  const id = fieldOf(row, "id");
  const ingestionStatus = fieldOf(row, "ingestion_status");
  const chunkCount = fieldOf(row, "chunk_count");
  return isNonEmptyString(id) && isNonEmptyString(ingestionStatus) && typeof chunkCount === "number"
    ? { id, ingestionStatus, chunkCount }
    : undefined;
}

export interface IngestionLog {
  taskType: string;
  operationStatus: string;
  /** `DONE` 日志的 `dsl.entries[].doc_id`；别的状态不读 `dsl`，为空。 */
  documentIds: string[];
}

/** 数据集任务日志（§5.3）：类型取行上的 `task_type`，不看 `variants`。 */
const LIST_INGESTIONS: Route<{ logs: IngestionLog[]; total: number }, never> = {
  read(data) {
    const logs = fieldOf(data, "logs");
    const total = fieldOf(data, "total");
    if (!Array.isArray(logs) || typeof total !== "number") {
      return undefined;
    }
    const rows = logs.flatMap((row: unknown) => ingestionRow(row) ?? []);
    return rows.length === logs.length ? { logs: rows, total } : undefined;
  },
};

/** `dsl` 只在 `DONE` 时读：`done` 靠它，读不出即失败；`RUNNING` 行的 `dsl` 记录里没有原文。 */
function ingestionRow(row: unknown): IngestionLog | undefined {
  const taskType = fieldOf(row, "task_type");
  const operationStatus = fieldOf(row, "operation_status");
  if (!isNonEmptyString(taskType) || !isNonEmptyString(operationStatus)) {
    return undefined;
  }
  if (operationStatus !== "DONE") {
    return { taskType, operationStatus, documentIds: [] };
  }
  const entries = fieldOf(fieldOf(row, "dsl"), "entries");
  const ids = Array.isArray(entries)
    ? entries.map((entry: unknown) => fieldOf(entry, "doc_id"))
    : [];
  return Array.isArray(entries) && ids.every(isNonEmptyString)
    ? { taskType, operationStatus, documentIds: ids }
    : undefined;
}

const UPLOAD_DOCUMENT: Route<{ id: string }, typeof NOT_FOUND | typeof UNSUPPORTED_FILE> = {
  typed(envelope) {
    if (envelope.code === 102 && messageStarts(envelope, "Can't find the dataset with ID")) {
      return NOT_FOUND;
    }
    const unsupported =
      envelope.code === 500 &&
      typeof envelope.message === "string" &&
      envelope.message.includes("This type of file has not been supported yet!");
    return unsupported ? UNSUPPORTED_FILE : undefined;
  },
  read(data) {
    const [row, ...rest] = Array.isArray(data) ? (data as unknown[]) : [];
    const id = fieldOf(row, "id");
    return isNonEmptyString(id) && rest.length === 0 ? { id } : undefined;
  },
};

const PARSE_DOCUMENT: Route<null, typeof NOT_FOUND | typeof PARSE_NOT_STARTED> = {
  typed(envelope) {
    if (envelope.code === 404) {
      return NOT_FOUND;
    }
    const silent = envelope.code === 0 && fieldOf(envelope.data, "success_count") === 0;
    return silent ? PARSE_NOT_STARTED : undefined;
  },
  read: (data) => unitWhen(fieldOf(data, "success_count") === 1),
};

const STOP_DOCUMENT: Route<{ successCount: number }, typeof NOT_FOUND> = {
  typed(envelope) {
    const absent =
      envelope.code === 404 ||
      (envelope.code === 100 && messageStarts(envelope, "Documents not found:"));
    return absent ? NOT_FOUND : undefined;
  },
  read(data) {
    const successCount = fieldOf(data, "success_count");
    return typeof successCount === "number" ? { successCount } : undefined;
  },
};

const DELETE_DOCUMENT: Route<null, typeof NOT_FOUND | typeof NOT_DELETED> = {
  typed(envelope) {
    const absent =
      envelope.code === 404 ||
      (envelope.code === 102 &&
        messageStarts(envelope, "These documents do not belong to dataset"));
    if (absent) {
      return NOT_FOUND;
    }
    const silent = envelope.code === 0 && fieldOf(envelope.data, "deleted") === 0;
    return silent ? NOT_DELETED : undefined;
  },
  read: (data) => unitWhen(fieldOf(data, "deleted") === 1),
};

const DOWNLOAD_DOCUMENT: Route<never, typeof NOT_FOUND> = {
  typed: (envelope) => (envelope.code === 404 ? NOT_FOUND : undefined),
  // 走到这里就是不带 `Content-Disposition` 的 `code:0`：没有文件可读（D8：代理剥掉头时判失败）。
  read: () => undefined,
};

const DELETE_CANVAS: Route<null, typeof NOT_FOUND> = {
  typed: (envelope) => (envelope.code === 103 ? NOT_FOUND : undefined),
  read: deleted,
};

const DELETE_TEMPLATE_GROUP: Route<null, typeof NOT_FOUND> = {
  typed: (envelope) => (envelope.code === 404 ? NOT_FOUND : undefined),
  read: deleted,
};

/** 内置编译模板（§5.1 (1)）：`id` 与 `config`。 */
const BUILTIN_TEMPLATES: Route<{ id: string; config: Json }[], never> = {
  read(data) {
    const rows = Array.isArray(data) ? (data as unknown[]) : [];
    const templates = rows.flatMap((row) => {
      const id = fieldOf(row, "id");
      const config = fieldOf(row, "config");
      return isNonEmptyString(id) && isRecord(config) ? [{ id, config }] : [];
    });
    return Array.isArray(data) && templates.length === data.length ? templates : undefined;
  },
};

/** 内置 pipeline 的 DSL（§5.1 (3)）：只要求是对象，改写由 `kb/pipeline.ts` 校验。 */
const BUILTIN_PIPELINE: Route<Json, never> = {
  read(data) {
    const dsl = fieldOf(data, "dsl");
    return isRecord(dsl) ? dsl : undefined;
  },
};

const documentsPath = (datasetId: string): string =>
  `${API}/datasets/${encodeURIComponent(datasetId)}/documents`;

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** 读完才判定；超过上限、断开都是 `undefined`，由 `done` 决定收尾。 */
function readJson(response: IncomingMessage, done: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      done(undefined);
      return;
    }
    chunks.push(chunk);
  });
  response.once("end", () => done(parseJson(Buffer.concat(chunks))));
  response.once("error", () => done(undefined));
  response.once("close", () => done(undefined));
}

function headersOf(
  outbound: Outbound,
  key: KbKeyHandle,
  text: string | undefined,
): Record<string, string> {
  const { upload, keyed } = outbound;
  return {
    ...(keyed ? { authorization: `Bearer ${key.read()}` } : {}),
    ...(text === undefined
      ? {}
      : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        }),
    ...(upload === undefined
      ? {}
      : { "content-type": upload.contentType, "content-length": String(upload.contentLength) }),
  };
}

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

function isFile(response: IncomingMessage, outbound: Outbound): boolean {
  return (
    outbound.file === true &&
    response.statusCode === 200 &&
    response.headers["content-disposition"] !== undefined
  );
}

function openRequest(
  outbound: Outbound,
  baseUrl: string,
  headers: Record<string, string>,
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const target = new URL(outbound.path, baseUrl);
  const tls = target.protocol === "https:";
  const { method } = outbound;
  const req = (tls ? https : http).request(target, { method, agent: false, headers }, onResponse);
  return { req, tls };
}

/** 一次请求：先定结果再销毁，销毁引发的错误改不了结果（写法同 `models/probe.ts`）。 */
function exchange(
  outbound: Outbound,
  baseUrl: string,
  key: KbKeyHandle,
  deadlines: Deadlines,
): Promise<Wire> {
  const { upload, totalMs, signal } = outbound;
  const text = outbound.json === undefined ? undefined : JSON.stringify(outbound.json);
  return new Promise((resolve) => {
    let settled = false;
    let status: number | null = null;
    let req: ClientRequest | undefined;
    const settle = (wire: Wire): void => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        if (!("file" in wire)) {
          signal?.removeEventListener("abort", abandon);
        }
        resolve(wire);
      }
    };
    const abandon = (): void => {
      settle({ status, body: undefined });
      req?.destroy();
    };
    const finish = (body: unknown): void => {
      settle({ status, body });
      req?.destroy();
    };
    const onResponse = (response: IncomingMessage): void => {
      clearTimeout(connectTimer);
      status = response.statusCode ?? 0;
      if (isFile(response, outbound)) {
        response.once("close", () => signal?.removeEventListener("abort", abandon));
        settle({ file: response });
      } else if (isRedirect(status)) {
        abandon();
      } else {
        readJson(response, finish);
      }
    };
    const connectTimer = setTimeout(abandon, deadlines.connectMs);
    const totalTimer = totalMs === undefined ? undefined : setTimeout(abandon, totalMs);
    if (signal?.aborted === true) {
      upload?.body.destroy();
      abandon();
      return;
    }
    let tls = false;
    try {
      ({ req, tls } = openRequest(outbound, baseUrl, headersOf(outbound, key, text), onResponse));
    } catch {
      upload?.body.destroy();
      abandon();
      return;
    }
    req.on("error", abandon);
    signal?.addEventListener("abort", abandon, { once: true });
    // 每个请求一条新连接：TCP（与 TLS）建好，连接期限就结束了。
    req.on("socket", (socket: Socket) => {
      socket.once(tls ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    if (totalMs === undefined) {
      req.setTimeout(deadlines.idleMs, abandon);
    }
    if (upload === undefined) {
      req.end(text);
    } else {
      pipeline(upload.body, req, (error) => {
        if (error !== undefined && error !== null) {
          abandon();
        }
      });
    }
  });
}

/** 结果映射，次序见文件头。 */
function interpret<T, Typed>(
  wire: Answer,
  route: Route<T, Typed>,
  onAuthFailure: () => void,
): Result<T, Typed> {
  const { status, body } = wire;
  const envelope = envelopeOf(body);
  if (status === 200 && envelope !== undefined) {
    const typed = route.typed?.(envelope);
    if (typed !== undefined) {
      return typed;
    }
  }
  if (status !== null && status >= 200 && status < 300 && envelope?.code === 0) {
    const value = route.read(envelope.data);
    return value === undefined ? UNAVAILABLE : { kind: "ok", value };
  }
  if (envelope?.code === 101 || envelope?.code === 102) {
    return REJECTED;
  }
  if (status === 401 || envelope?.code === 401 || envelope?.code === 403) {
    onAuthFailure();
  }
  return UNAVAILABLE;
}

/** 一条 stderr 记录的限频：同一进程 60 秒内至多一行。状态在返回的闭包里，所以每条记录只建一次。 */
export function perMinute(now: () => number, write: () => void): () => void {
  let last: number | undefined;
  return () => {
    const at = now();
    if (last === undefined || at - last >= RECORD_INTERVAL_MS) {
      last = at;
      write();
    }
  };
}

export function createRagflowClient(options: {
  /** 只有协议与 authority（`kb/config.ts`）。 */
  baseUrl: string;
  key: KbKeyHandle;
  /** 受管 stderr writer。 */
  log: (record: { event: "kb_upstream_auth_failed" }) => void;
  now?: () => number;
  deadlines?: Partial<Deadlines>;
}) {
  const { baseUrl, key, log, now = Date.now } = options;
  const deadlines: Deadlines = {
    connectMs: CONNECT_MS,
    totalMs: TOTAL_MS,
    versionTotalMs: VERSION_TOTAL_MS,
    idleMs: IDLE_MS,
    ...options.deadlines,
  };
  const logAuthFailure = perMinute(now, () => log({ event: "kb_upstream_auth_failed" }));

  async function send<T, Typed>(
    outbound: Outbound,
    route: Route<T, Typed>,
  ): Promise<Result<T, Typed>> {
    const wire = await exchange(outbound, baseUrl, key, deadlines);
    return interpret("file" in wire ? NO_ANSWER : wire, route, logAuthFailure);
  }

  const json = <T, Typed>(
    method: string,
    path: string,
    route: Route<T, Typed>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Result<T, Typed>> =>
    send({ method, path, keyed: true, totalMs: deadlines.totalMs, json: body, signal }, route);

  return {
    ...modelCalls(json),

    /** 版本串，不带密钥。 */
    version(): Promise<Result<string>> {
      const path = `${API}/system/version`;
      return send(
        { method: "GET", path, keyed: false, totalMs: deadlines.versionTotalMs },
        VERSION,
      );
    },

    /** `parserId` 是内置模板（`parse_type:1`），`pipelineId` 是画布（`parse_type:2`，§5.1 (5)）；`embeddingModel` 为三段式。 */
    createDataset(
      dataset: { name: string; embeddingModel: string } & (
        | { parserId: string }
        | { pipelineId: string }
      ),
      signal?: AbortSignal,
    ): Promise<Result<{ id: string }>> {
      const template =
        "pipelineId" in dataset
          ? { parse_type: 2, pipeline_id: dataset.pipelineId }
          : { parser_id: dataset.parserId, parse_type: 1 };
      const body = { name: dataset.name, ...template, embedding_model: dataset.embeddingModel };
      return json("POST", `${API}/datasets`, CREATED, body, signal);
    },

    listBuiltinTemplates(signal?: AbortSignal): Promise<Result<{ id: string; config: Json }[]>> {
      const path = `${API}/compilation-templates/builtins`;
      return json("GET", path, BUILTIN_TEMPLATES, undefined, signal);
    },

    /** body 形状见 §5.1 (2)：`templates` 的项是 `{name, kind, description, config}`。 */
    createTemplateGroup(
      name: string,
      templates: readonly Json[],
      signal?: AbortSignal,
    ): Promise<Result<{ id: string }>> {
      const body = { name, description: "", templates };
      return json("POST", `${API}/compilation-template-groups`, CREATED, body, signal);
    },

    /** RAGFlow 不要求这条带密钥（§15），这里照带：每个请求一个写法。 */
    async readBuiltinPipeline(parserId: string, signal?: AbortSignal): Promise<Result<Json>> {
      if (!usable(parserId)) {
        return UNAVAILABLE;
      }
      const path = `${API}/pipelines/${encodeURIComponent(parserId)}`;
      return json("GET", path, BUILTIN_PIPELINE, undefined, signal);
    },

    createCanvas(title: string, dsl: Json, signal?: AbortSignal): Promise<Result<{ id: string }>> {
      const body = { title, canvas_category: "dataflow_canvas", dsl };
      return json("POST", `${API}/agents`, CREATED, body, signal);
    },

    /** `ids` 恰一个非空 id：空 `ids` 回 `code:0` 什么也不删（§4.6），混合批次全部不删（§10）。 */
    async deleteDataset(id: string, signal?: AbortSignal): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      return json("DELETE", `${API}/datasets`, DELETE_DATASET, { ids: [id] }, signal);
    },

    /** 一页文档：`page_size` 超过 100 会静默回落到 10（§8.3）。 */
    async listDocuments(
      datasetId: string,
      page: number,
    ): Promise<Result<{ documents: ListedDocument[]; total: number }, typeof NOT_FOUND>> {
      if (!usable(datasetId)) {
        return UNAVAILABLE;
      }
      const query = `page=${String(page)}&page_size=${String(PAGE_SIZE)}&orderby=create_time&desc=false`;
      return json("GET", `${documentsPath(datasetId)}?${query}`, LIST_DOCUMENTS);
    },

    /**
     * 一页数据集任务日志（§5.3）：`orderby=id` 不能省，缺省次序在并列时翻页丢行（§18 #26）。`task_type` 是静默忽略的参数，
     * `keywords` 是关键字匹配，`log_type=file` 超过 1 MiB，都不发。
     */
    async listIngestionLogs(
      datasetId: string,
      page: number,
    ): Promise<Result<{ logs: IngestionLog[]; total: number }>> {
      if (!usable(datasetId)) {
        return UNAVAILABLE;
      }
      const path = `${API}/datasets/${encodeURIComponent(datasetId)}/ingestions`;
      const query = `page=${String(page)}&page_size=${String(PAGE_SIZE)}&orderby=id`;
      return json("GET", `${path}?${query}`, LIST_INGESTIONS);
    },

    async uploadDocument(
      datasetId: string,
      upload: Upload,
      signal?: AbortSignal,
    ): Promise<Result<{ id: string }, typeof NOT_FOUND | typeof UNSUPPORTED_FILE>> {
      if (!usable(datasetId)) {
        upload.body.destroy();
        return UNAVAILABLE;
      }
      const path = documentsPath(datasetId);
      return send({ method: "POST", path, keyed: true, upload, signal }, UPLOAD_DOCUMENT);
    },

    /** 只触发这一份：`success_count` 才能对应到文档（§8.1）。 */
    async parseDocument(
      datasetId: string,
      documentId: string,
      signal?: AbortSignal,
    ): Promise<Result<null, typeof NOT_FOUND | typeof PARSE_NOT_STARTED>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      const body = { document_ids: [documentId] };
      return json("POST", `${documentsPath(datasetId)}/parse`, PARSE_DOCUMENT, body, signal);
    },

    /** `successCount` 为 0 是文档已不在运行（§8.2），不是失败。 */
    async stopDocument(
      datasetId: string,
      documentId: string,
    ): Promise<Result<{ successCount: number }, typeof NOT_FOUND>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      return json("POST", `${documentsPath(datasetId)}/stop`, STOP_DOCUMENT, {
        document_ids: [documentId],
      });
    },

    async deleteDocument(
      datasetId: string,
      documentId: string,
    ): Promise<Result<null, typeof NOT_FOUND | typeof NOT_DELETED>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      return json("DELETE", documentsPath(datasetId), DELETE_DOCUMENT, { ids: [documentId] });
    },

    /** `value.body` 是文件字节：调用方必须读完或销毁它。 */
    async downloadDocument(
      datasetId: string,
      documentId: string,
      signal?: AbortSignal,
    ): Promise<Result<{ body: Readable }, typeof NOT_FOUND>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      const path = `${documentsPath(datasetId)}/${encodeURIComponent(documentId)}`;
      const outbound = { method: "GET", path, keyed: true, file: true, signal };
      const wire = await exchange(outbound, baseUrl, key, deadlines);
      if ("file" in wire) {
        return { kind: "ok", value: { body: wire.file } };
      }
      return interpret(wire, DOWNLOAD_DOCUMENT, logAuthFailure);
    },

    /** 只有 `kb/pipeline.ts` 调用：删除次序由它保证（D9）。 */
    async deleteCanvas(id: string, signal?: AbortSignal): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      const path = `${API}/agents/${encodeURIComponent(id)}`;
      return json("DELETE", path, DELETE_CANVAS, undefined, signal);
    },

    async deleteTemplateGroup(
      id: string,
      signal?: AbortSignal,
    ): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      const path = `${API}/compilation-template-groups/${encodeURIComponent(id)}`;
      return json("DELETE", path, DELETE_TEMPLATE_GROUP, undefined, signal);
    },
  };
}
