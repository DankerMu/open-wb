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
 * 清共用的路径，`setDefaultModel` 拒绝空名字，所以这个调用面只能设。
 *
 * 结果按次序判定：路由专属组合（只认 HTTP 200，实测全部如此，§12 未知路由的 HTTP 404 + `code:404` 不能算不存
 * 在）→ 2xx 且 `code:0` → `code` 101 / 102 为 `kb_rejected` → HTTP 401 或 `code` 401 / 403 为 `kb_unavailable`
 * 并写一行 `kb_upstream_auth_failed`（60 秒至多一行）→ 其余 `kb_unavailable`。3xx 不读正文。
 *
 * RAGFlow 的 message 只用于上面的前缀判定，结果只有 `kind` 与调用点要读的字段，不带 message、正文与原始 `code`。
 * 密钥只进请求头，一个请求读一次句柄。任何错误都不外抛：不发出的请求（空 id、空 `api_key`）同样是
 * `kb_unavailable`，绝不能是 `not_found`，那会被调用点当成已删除。
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import type { KbKeyHandle } from "./key-file.js";

const CONNECT_MS = 10_000;
const TOTAL_MS = 30_000;
const VERSION_TOTAL_MS = 5_000;
const IDLE_MS = 60_000;
const MAX_JSON_BYTES = 1_048_576;
const RECORD_INTERVAL_MS = 60_000;
const PAGE_SIZE = 100;
const API = "/api/v1";
export const PROVIDER = "OpenAI-API-Compatible";
const INSTANCES = `${API}/providers/${PROVIDER}/instances`;

const UNAVAILABLE = { kind: "kb_unavailable" } as const;
const REJECTED = { kind: "kb_rejected" } as const;
const NOT_FOUND = { kind: "not_found" } as const;
const UNSUPPORTED_FILE = { kind: "unsupported_file" } as const;
const PARSE_NOT_STARTED = { kind: "parse_not_started" } as const;
const NOT_DELETED = { kind: "not_deleted" } as const;

type Failure = typeof UNAVAILABLE | typeof REJECTED;
type Ok<T> = { kind: "ok"; value: T };
type Result<T, Typed = never> = Ok<T> | Failure | Typed;

interface Envelope {
  code: unknown;
  message: unknown;
  data: unknown;
}

/**
 * 一条路由的判定。`typed` 是路由专属组合；`read` 在 `code:0` 时取调用点要读的字段，
 * 读不到返回 `undefined`（即「成功应答缺少调用点要读的字段」），没有要读的字段时返回 `null`。
 */
interface Route<T, Typed> {
  typed?: (envelope: Envelope) => Typed | undefined;
  read: (data: unknown) => T | undefined;
}

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
}

interface Upload {
  body: Readable;
  contentType: string;
  contentLength: number;
}

/** `model_info` 的一项（§11.1），键名就是线上的键名。 */
export interface ModelInfo {
  model_name: string;
  model_type: readonly string[];
  max_tokens: number;
}

interface ModelInstance {
  instanceName: string;
  /** 上游密钥。RAGFlow 按 trim 后的值写入，空值会清空实例密钥（§11.4），所以空串与纯空白都拒绝发出。 */
  apiKey: string;
  baseUrl: string;
  modelInfo: readonly ModelInfo[];
}

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

/** 语义对齐 RAGFlow 写入实例密钥时的 Go `strings.TrimSpace`：JS 的 `trim()` 不剥 U+0085，所以先去掉它。 */
export function isBlankApiKey(key: string): boolean {
  return key.replaceAll("\u0085", "").trim() === "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeOf(body: unknown): Envelope | undefined {
  return isRecord(body) ? { code: body.code, message: body.message, data: body.data } : undefined;
}

const messageStarts = (envelope: Envelope, prefix: string): boolean =>
  typeof envelope.message === "string" && envelope.message.startsWith(prefix);

const fieldOf = (data: unknown, name: string): unknown => (isRecord(data) ? data[name] : undefined);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const unitWhen = (holds: boolean): null | undefined => (holds ? null : undefined);

/** 删画布与删模板组的成功应答（§5.1 (7)）。 */
const deleted = (data: unknown): null | undefined => unitWhen(data === true);

const VERSION: Route<string, never> = {
  read: (data) => (isNonEmptyString(data) ? data : undefined),
};

const CREATE_DATASET: Route<{ id: string }, never> = {
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

/** 不读应答字段的下发路由（§11）：`PUT /providers`、实例的建与改、`PATCH /models/default`。 */
const ACKNOWLEDGED: Route<null, never> = { read: () => null };

/** 一行模型属于哪个实例；有实例就一定有行，系统从不删模型（D7）。 */
const MODEL_INSTANCES: Route<string[], never> = {
  read(data) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    const rows = data.map((row: unknown) => ({
      provider: fieldOf(row, "provider_name"),
      instance: fieldOf(row, "instance_name"),
    }));
    const named = rows.every(
      ({ provider, instance }) => isNonEmptyString(provider) && isNonEmptyString(instance),
    );
    if (!named) {
      return undefined;
    }
    const ours = rows.filter(({ provider }) => provider === PROVIDER);
    return [...new Set(ours.map(({ instance }) => instance as string))];
  },
};

function modelInfoOf(row: unknown): ModelInfo | undefined {
  const name = fieldOf(row, "name");
  const type = fieldOf(row, "model_type");
  const maxTokens = fieldOf(row, "max_tokens");
  return isNonEmptyString(name) && Array.isArray(type) && typeof maxTokens === "number"
    ? { model_name: name, model_type: type as string[], max_tokens: maxTokens }
    : undefined;
}

/** 实例的模型列表，读成 `PUT` 实例要带回去的 `model_info` 项。 */
const INSTANCE_MODELS: Route<ModelInfo[], never> = {
  read(data) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    const models = data.flatMap((row: unknown) => modelInfoOf(row) ?? []);
    return models.length === data.length ? models : undefined;
  },
};

/** 空 id 拼不出这条路由；`.`、`..` 编码后不变，会被 URL 解析吃掉，走到别的路由上。 */
function usable(...ids: readonly string[]): boolean {
  return ids.every((id) => id !== "" && id !== "." && id !== "..");
}

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
  const { upload, totalMs } = outbound;
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
        settle({ file: response });
      } else if (isRedirect(status)) {
        abandon();
      } else {
        readJson(response, finish);
      }
    };
    const connectTimer = setTimeout(abandon, deadlines.connectMs);
    const totalTimer = totalMs === undefined ? undefined : setTimeout(abandon, totalMs);
    let tls = false;
    try {
      ({ req, tls } = openRequest(outbound, baseUrl, headersOf(outbound, key, text), onResponse));
    } catch {
      upload?.body.destroy();
      abandon();
      return;
    }
    req.on("error", abandon);
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
  ): Promise<Result<T, Typed>> =>
    send({ method, path, keyed: true, totalMs: deadlines.totalMs, json: body }, route);

  const instanceBody = (instance: ModelInstance) => ({
    instance_name: instance.instanceName,
    api_key: instance.apiKey,
    base_url: instance.baseUrl,
    model_info: instance.modelInfo,
  });

  return {
    /** 版本串，不带密钥。 */
    version(): Promise<Result<string>> {
      const path = `${API}/system/version`;
      return send(
        { method: "GET", path, keyed: false, totalMs: deadlines.versionTotalMs },
        VERSION,
      );
    },

    /** 内置模板建数据集；`embeddingModel` 为三段式（§4.4）。 */
    createDataset(dataset: {
      name: string;
      parserId: string;
      embeddingModel: string;
    }): Promise<Result<{ id: string }>> {
      return json("POST", `${API}/datasets`, CREATE_DATASET, {
        name: dataset.name,
        parser_id: dataset.parserId,
        parse_type: 1,
        embedding_model: dataset.embeddingModel,
      });
    },

    /** `ids` 恰一个非空 id：空 `ids` 回 `code:0` 什么也不删（§4.6），混合批次全部不删（§10）。 */
    async deleteDataset(id: string): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      return json("DELETE", `${API}/datasets`, DELETE_DATASET, { ids: [id] });
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

    async uploadDocument(
      datasetId: string,
      upload: Upload,
    ): Promise<Result<{ id: string }, typeof NOT_FOUND | typeof UNSUPPORTED_FILE>> {
      if (!usable(datasetId)) {
        upload.body.destroy();
        return UNAVAILABLE;
      }
      const path = documentsPath(datasetId);
      return send({ method: "POST", path, keyed: true, upload }, UPLOAD_DOCUMENT);
    },

    /** 只触发这一份：`success_count` 才能对应到文档（§8.1）。 */
    async parseDocument(
      datasetId: string,
      documentId: string,
    ): Promise<Result<null, typeof NOT_FOUND | typeof PARSE_NOT_STARTED>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      return json("POST", `${documentsPath(datasetId)}/parse`, PARSE_DOCUMENT, {
        document_ids: [documentId],
      });
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
    ): Promise<Result<{ body: Readable }, typeof NOT_FOUND>> {
      if (!usable(datasetId, documentId)) {
        return UNAVAILABLE;
      }
      const path = `${documentsPath(datasetId)}/${encodeURIComponent(documentId)}`;
      const outbound = { method: "GET", path, keyed: true, file: true };
      const wire = await exchange(outbound, baseUrl, key, deadlines);
      if ("file" in wire) {
        return { kind: "ok", value: { body: wire.file } };
      }
      return interpret(wire, DOWNLOAD_DOCUMENT, logAuthFailure);
    },

    async deleteCanvas(id: string): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      return json("DELETE", `${API}/agents/${encodeURIComponent(id)}`, DELETE_CANVAS);
    },

    async deleteTemplateGroup(id: string): Promise<Result<null, typeof NOT_FOUND>> {
      if (!usable(id)) {
        return UNAVAILABLE;
      }
      const path = `${API}/compilation-template-groups/${encodeURIComponent(id)}`;
      return json("DELETE", path, DELETE_TEMPLATE_GROUP);
    },

    async createModelInstance(instance: ModelInstance): Promise<Result<null>> {
      if (isBlankApiKey(instance.apiKey)) {
        return UNAVAILABLE;
      }
      return json("POST", INSTANCES, ACKNOWLEDGED, instanceBody(instance));
    },

    async updateModelInstance(instance: ModelInstance): Promise<Result<null>> {
      if (isBlankApiKey(instance.apiKey) || !usable(instance.instanceName)) {
        return UNAVAILABLE;
      }
      const name = encodeURIComponent(instance.instanceName);
      return json("PUT", `${INSTANCES}/${name}`, ACKNOWLEDGED, instanceBody(instance));
    },

    /** 幂等（§11.4）。 */
    ensureProvider(): Promise<Result<null>> {
      return json("PUT", `${API}/providers`, ACKNOWLEDGED, { provider_name: PROVIDER });
    },

    /** `GET /models`：账号在本系统提供方下的实例名。这个列表不含密钥，单实例 `GET` 才有（D4）。 */
    listModelInstances(): Promise<Result<string[]>> {
      return json("GET", `${API}/models`, MODEL_INSTANCES);
    },

    async listInstanceModels(instanceName: string): Promise<Result<ModelInfo[]>> {
      if (!usable(instanceName)) {
        return UNAVAILABLE;
      }
      const name = encodeURIComponent(instanceName);
      return json("GET", `${INSTANCES}/${name}/models`, INSTANCE_MODELS);
    },

    /** 把账号缺省切到这个模型。名字为空就是清空缺省的写法（§11.2、§13），这里拒绝发出。 */
    async setDefaultModel(target: {
      instanceName: string;
      modelName: string;
      modelType: "embedding" | "chat";
    }): Promise<Result<null>> {
      if (target.instanceName === "" || target.modelName === "") {
        return UNAVAILABLE;
      }
      return json("PATCH", `${API}/models/default`, ACKNOWLEDGED, {
        model_provider: PROVIDER,
        model_instance: target.instanceName,
        model_name: target.modelName,
        model_type: target.modelType,
      });
    },
  };
}
