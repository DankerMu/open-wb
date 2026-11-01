/**
 * s2a-kb-ragflow 组 5（design D17）：进程内的假 RAGFlow，本 change 全部用例的上游。行为分两类，评审时分开看：
 *
 * - 协议应答：路径、字段、状态值与 code 全部抄自 `docs/reviews/2026-10-28-ragflow-rc2-api.md`，注释写小节号。
 *   处理函数名带 `Absent` 的路由只有「不存在」一支：本组没有实现存在分支，存在时落到未知路由。`answer()` 是
 *   用例脚本化的协议应答，`code` 只收记录里出现过的值，所以 `108`、`109` 进不来。
 * - 故障注入：`fault()`，只限 tasks.md 头部的四种，种类是闭集，在 `fake-ragflow-script.mjs`。夹具不做分块下载。
 *
 * 文档状态是静态的：解析与停止按当前状态应答，不自动迁移，状态由用例经 `setDocumentStatus` 设置（实测里迁移
 * 是异步的，用例要的是确定的状态）。
 *
 * 请求在请求头到达时入记录，请求体读完后补全；请求体没读完连接就断了，记录标 `aborted`，不进状态。密钥不进
 * 记录，只记 Bearer 对不对。未知路由回 §12 的 404 并标 `unknown`：夹具没有清空缺省与删除模型配置的路由，这些
 * 请求落在这里（design D17）。组 8、9、11 按需加路由。
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createScript, JSON_TYPE, send } from "./fake-ragflow-script.mjs";

const DEFAULT_KEY = "fake-ragflow-key";
const VERSION = "v1.0.0-rc2";
const API = "/api/v1";
const NOT_FOUND = "Resource not found";
const INVALID_UUID = "Invalid UUID format";
const UUID_SHAPE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/iu;
const ALL_ZERO = /^[0-]+$/u;
/** §4.1 建数据集接受的字段。 */
const DATASET_FIELDS = new Set([
  "name",
  "embedding_model",
  "parser_config",
  "language",
  "permission",
  "parser_id",
  "pipeline_id",
  "parse_type",
]);
const PARSER_IDS = new Set([
  "general",
  "qa",
  "manual",
  "table",
  "paper",
  "book",
  "laws",
  "presentation",
  "picture",
  "one",
  "audio",
  "email",
]);
const PARSER_ERROR =
  "input should be 'general', 'qa', 'manual', 'table', 'paper', 'book', 'laws', 'presentation', 'picture', 'one', 'audio' or 'email'";
const EMBEDDING_FORMAT = "embedding model identifier must follow <model_name>@<provider> format";
/** 表 C 末列的并集：不在其中即 §7.1 的不支持。 */
const SUFFIXES = new Set(
  (
    "doc docx htm html md markdown mdx pdf xls xlsx csv txt py js java c cpp h php go ts sh cs kt sql " +
    "eml ppt pptx bmp gif jpeg jpg png svg tif tiff webp 3gp 3gpp avi flv mkv mov mp4 mpeg mpg webm wmv " +
    "aac aiff ape au da flac midi mp3 ogg oggvorbis realaudio vqf wav wave wma"
  ).split(" "),
);
/** §8.5：这两种状态下删除回 `deleted:0`。 */
const UNDELETABLE = new Set(["RUNNING", "STOPPING"]);
/** §8.1：这三种状态才会新启动任务。 */
const PARSEABLE = new Set(["UNSTART", "FAILED", "STOPPED"]);
/** §8.2：这两种状态不能停止。 */
const UNSTOPPABLE = new Set(["UNSTART", "COMPLETED"]);
const CANT_STOP = "Can't stop parsing document that has not started or already completed";
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

const newId = () => randomBytes(16).toString("hex");
const failure = (code, message, extra = {}) => ({ json: { code, data: null, message, ...extra } });
const notFound = () => failure(404, NOT_FOUND);
const success = (data, message = "success") => ({ json: { code: 0, data, message } });

/** §9.1：文档不存在时没有 `data` 键，数据集不存在时有。 */
const NOT_FOUND_DOCUMENT = '{"code":404,"message":"Resource not found"}';
const NOT_FOUND_DATASET = '{"code":404,"data":null,"message":"Resource not found"}';
/** §9：0 字节文件的下载。 */
const EMPTY_FILE = '{"code":500,"message":"Failed to download document"}';

function versionAnswer() {
  return success(VERSION);
}

function extraField(body, allowed) {
  const extra = Object.keys(body).find((name) => !allowed.has(name));
  return extra === undefined ? undefined : failure(101, `Extra inputs are not permitted: ${extra}`);
}

/** §4.3：`parse_type` 的字符串取值回 102 与 Go 解码错误，记录没有原文，这里只保证 code。 */
function templateRejection({
  parse_type: parseType,
  parser_id: parserId,
  pipeline_id: pipelineId,
}) {
  if (parseType === undefined) {
    return failure(102, "parse_type is required");
  }
  if (parseType === 2) {
    return failure(
      102,
      pipelineId === undefined
        ? "pipeline_id is required when parse_type is Pipeline"
        : "canvas is not accessible",
    );
  }
  if (parseType !== 1) {
    return failure(102, `invalid parse_type: ${String(parseType)} (must be 1 or 2)`);
  }
  if (parserId === undefined) {
    return failure(102, "parser_id is required when parse_type is BuiltIn");
  }
  if (pipelineId !== undefined) {
    return failure(102, "pipeline_id must not be set when parse_type is BuiltIn");
  }
  return parserId === "naive" || PARSER_IDS.has(parserId) ? undefined : failure(102, PARSER_ERROR);
}

/** §4.4：账号没有名为 `default` 的实例，两段式查不到。 */
function embeddingRejection(model) {
  if (model === undefined) {
    return undefined;
  }
  const parts = String(model).split("@");
  if (parts.length === 2 && parts.every((part) => part !== "")) {
    return failure(
      102,
      'model configuration unavailable: instance "default" lookup failed: record not found',
    );
  }
  return parts.length === 3 && parts.every((part) => part !== "")
    ? undefined
    : failure(102, EMBEDDING_FORMAT);
}

function createDataset(state, request) {
  const body = request.body;
  const rejection =
    extraField(body, DATASET_FIELDS) ??
    templateRejection(body) ??
    embeddingRejection(body.embedding_model);
  if (rejection !== undefined) {
    return rejection;
  }
  const dataset = state.add(body.name, body.parser_id, body.embedding_model);
  return {
    json: {
      code: 0,
      data: {
        chunk_count: 0,
        document_count: 0,
        embedding_model: dataset.embeddingModel,
        id: dataset.id,
        language: "English",
        name: dataset.name,
        parser_id: dataset.parserId,
        permission: "me",
        token_num: 0,
      },
      message: null,
    },
  };
}

const isUuid = (id) => UUID_SHAPE.test(id) && !ALL_ZERO.test(id);

function deleteDatasets(state, request) {
  const body = request.body;
  const extra = extraField(body, new Set(["ids"]));
  if (extra !== undefined) {
    return extra;
  }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) {
    return { json: { code: 0, data: { deleted: [] }, message: null } };
  }
  if (!ids.every(isUuid)) {
    return failure(101, INVALID_UUID);
  }
  if (!ids.every((id) => state.datasets.has(id))) {
    return failure(403, "Permission denied");
  }
  for (const id of ids) {
    state.datasets.delete(id);
  }
  return { json: { code: 0, data: { errors: [], success_count: ids.length }, message: null } };
}

function partOf(bytes) {
  const end = bytes.indexOf(HEADER_END);
  const head = bytes.subarray(0, end).toString("utf8");
  const content = bytes.subarray(end + HEADER_END.length);
  const encoded = /filename\*=UTF-8''([^;\r\n]+)/iu.exec(head)?.[1];
  const quoted = /filename="((?:[^"\\]|\\.)*)"/u.exec(head)?.[1]?.replaceAll('\\"', '"');
  const filename = encoded === undefined ? quoted : decodeURIComponent(encoded);
  return {
    field: /name="([^"]*)"/u.exec(head)?.[1] ?? "",
    filename: (filename ?? "").split("/").at(-1),
    content,
  };
}

function parseMultipart(contentType, bytes) {
  const boundary = /boundary="?([^";]+)"?/u.exec(contentType)?.[1];
  if (boundary === undefined) {
    return null;
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.concat([CRLF, delimiter]);
  const parts = [];
  let at = bytes.indexOf(delimiter);
  while (
    at !== -1 &&
    bytes.subarray(at + delimiter.length, at + delimiter.length + 2).toString() !== "--"
  ) {
    const start = at + delimiter.length + CRLF.length;
    const end = bytes.indexOf(closing, start);
    if (end === -1) {
      break;
    }
    parts.push(partOf(bytes.subarray(start, end)));
    at = end + CRLF.length;
  }
  return parts;
}

function suffixOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

/** §7.1：同名改名，内容相同与否都一样。 */
function freeName(dataset, name) {
  const names = new Set([...dataset.documents.values()].map((document) => document.name));
  if (!names.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const [stem, tail] = dot === -1 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
  let round = 1;
  while (names.has(`${stem}(${round})${tail}`)) {
    round += 1;
  }
  return `${stem}(${round})${tail}`;
}

function uploadedRow(dataset, document) {
  return {
    chunk_count: 0,
    dataset_id: dataset.id,
    id: document.id,
    ingestion_status: document.ingestionStatus,
    location: document.name,
    name: document.name,
    parser_id: dataset.parserId,
    size: document.content.length,
    source_type: "local",
    suffix: suffixOf(document.name),
    token_count: 0,
    type: "doc",
  };
}

function upload(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return failure(102, `Can't find the dataset with ID ${datasetId}!`);
  }
  const files = (request.parts ?? []).filter((part) => part.field === "file");
  if (files.length === 0) {
    return failure(101, "No file part!");
  }
  const refused = files.find((file) => !SUFFIXES.has(suffixOf(file.filename).toLowerCase()));
  if (refused !== undefined) {
    return failure(500, `${refused.filename}: This type of file has not been supported yet!`);
  }
  const rows = files.map((file) => {
    const name = freeName(dataset, file.filename);
    return uploadedRow(dataset, state.addDocument(dataset, name, file.content));
  });
  return { json: { code: 0, data: rows, message: null } };
}

function deleteDocuments(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const ids = request.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return failure(102, "should either provide doc ids or set delete_all(true)");
  }
  const absent = ids.find((id) => !dataset.documents.has(id));
  if (absent !== undefined) {
    return failure(
      102,
      `These documents do not belong to dataset ${datasetId} or Document not found: ${absent}`,
    );
  }
  const removable = ids.filter((id) => !UNDELETABLE.has(dataset.documents.get(id).ingestionStatus));
  for (const id of removable) {
    dataset.documents.delete(id);
  }
  return success({ deleted: removable.length });
}

function documentIds(request) {
  const ids = request.body.document_ids;
  return Array.isArray(ids) && ids.length > 0 ? ids : undefined;
}

function parseDocuments(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const ids = documentIds(request);
  if (ids === undefined) {
    return failure(102, "`document_ids` is required");
  }
  const started = ids.filter((id) => PARSEABLE.has(dataset.documents.get(id)?.ingestionStatus));
  return success({ success_count: started.length });
}

function stopDocuments(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const ids = documentIds(request);
  if (ids === undefined) {
    return undefined; // 空 `document_ids` 的停止，记录里没有。
  }
  const absent = ids.filter((id) => !dataset.documents.has(id));
  if (absent.length > 0) {
    return failure(100, `Documents not found: [${absent.map((id) => `'${id}'`).join(", ")}]`);
  }
  const blocked = ids.some((id) => UNSTOPPABLE.has(dataset.documents.get(id).ingestionStatus));
  return blocked
    ? success({ errors: [CANT_STOP], success_count: 0 })
    : success({ success_count: ids.length });
}

function rawJson(text) {
  return { bytes: Buffer.from(text), headers: { "content-type": JSON_TYPE } };
}

function download(state, _request, [datasetId, documentId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return rawJson(NOT_FOUND_DATASET);
  }
  const document = dataset.documents.get(documentId);
  if (document === undefined) {
    return rawJson(NOT_FOUND_DOCUMENT);
  }
  if (document.content.length === 0) {
    return rawJson(EMPTY_FILE);
  }
  // 非 ASCII 名是未编码的原始 UTF-8，`"` 不转义（§9.2）。
  const filename = Buffer.from(document.name).toString("latin1");
  return {
    bytes: document.content,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  };
}

/** 表 B：这些路由本组只有「不存在」一支。 */
function datasetAbsent(state, _request, [id]) {
  return state.datasets.has(id) ? undefined : notFound();
}

function putDatasetAbsent(state, request, [id]) {
  return isUuid(id) ? datasetAbsent(state, request, [id]) : failure(101, INVALID_UUID);
}

function listDocumentsAbsent(state, request, [id]) {
  const dataset = state.datasets.get(id);
  if (dataset === undefined) {
    return notFound();
  }
  const documentId = request.params.get("id");
  return documentId === null || dataset.documents.has(documentId)
    ? undefined
    : failure(102, `you don't own the document ${documentId}`, { data: { docs: [], total: 0 } });
}

const agentAbsent = (message) => () => failure(103, message);

function groupAbsent(_state, _request, [id]) {
  return failure(404, `Cannot find compilation template group ${id}.`);
}

const segment = "([^/]+)";
const DATASET = `${API}/datasets/${segment}`;
const DOCUMENTS = `${DATASET}/documents`;
const GROUP = `${API}/compilation-template-groups/${segment}`;
/** `[方法, 路径, 处理函数]`。处理函数返回 `undefined` 即落到未知路由。 */
const ROUTES = [
  ["GET", `${API}/system/version`, versionAnswer, { open: true }],
  ["POST", `${API}/datasets`, createDataset],
  ["DELETE", `${API}/datasets`, deleteDatasets],
  ["POST", DOCUMENTS, upload, { multipart: true }],
  ["DELETE", DOCUMENTS, deleteDocuments],
  ["POST", `${DOCUMENTS}/parse`, parseDocuments],
  ["POST", `${DOCUMENTS}/stop`, stopDocuments],
  ["GET", `${DOCUMENTS}/${segment}`, download],
  ["GET", DATASET, datasetAbsent],
  ["PUT", DATASET, putDatasetAbsent],
  ["GET", DOCUMENTS, listDocumentsAbsent],
  ["GET", `${DATASET}/compilation/status`, datasetAbsent],
  [
    "GET",
    `${API}/agents/${segment}`,
    agentAbsent("Make sure you have permission to access the agent."),
  ],
  [
    "DELETE",
    `${API}/agents/${segment}`,
    agentAbsent("Only the owner of the agent is authorized for this operation."),
  ],
  ["GET", GROUP, groupAbsent],
  ["DELETE", GROUP, groupAbsent],
].map(([method, path, handler, options]) => ({
  method,
  pattern: new RegExp(`^${path}$`, "u"),
  handler,
  open: options?.open === true,
  multipart: options?.multipart === true,
}));

/** §12：`Bearer` 大小写与裸密钥都被接受，错了一律 `Invalid access token`。 */
function authFailure(header, key) {
  if (header === undefined) {
    return { status: 401, ...failure(401, "Missing Authorization header") };
  }
  return header.replace(/^bearer /iu, "") === key
    ? undefined
    : { status: 401, ...failure(401, "Invalid access token") };
}

function bearerOf(header, key) {
  if (header === undefined) {
    return "missing";
  }
  return header === `Bearer ${key}` ? "ok" : "other";
}

function routeOf(method, path) {
  for (const route of ROUTES) {
    const match = route.method === method ? route.pattern.exec(path) : null;
    if (match !== null) {
      return { route, captures: match.slice(1) };
    }
  }
  return undefined;
}

/** §4.5：畸形 JSON 与错的 `Content-Type` 都回 101。 */
function readJsonBody(bytes, contentType) {
  if (bytes.length === 0) {
    return { body: {} };
  }
  if (!contentType.startsWith("application/json")) {
    return { rejection: failure(101, "Unsupported content type") };
  }
  try {
    const body = JSON.parse(bytes.toString("utf8"));
    return { body: body !== null && typeof body === "object" ? body : {}, parsed: body };
  } catch {
    return { rejection: failure(101, "Malformed JSON syntax") };
  }
}

/** 收到结尾才算读完：连接先断就是中断的上传（§7.2）。 */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("close", () => resolve(null));
  });
}

function entryOf(request, url, key) {
  const declared = request.headers["content-length"];
  return {
    method: request.method ?? "",
    path: url.pathname,
    query: url.search.slice(1),
    bearer: bearerOf(request.headers.authorization, key),
    contentLength: declared === undefined ? null : Number(declared),
    json: null,
    multipart: null,
    unknown: false,
    aborted: false,
  };
}

function createState() {
  const datasets = new Map();
  return {
    datasets,
    add(name, parserId, embeddingModel) {
      const canonical = parserId === "naive" ? "general" : parserId;
      const dataset = {
        id: newId(),
        name,
        parserId: canonical,
        embeddingModel: embeddingModel ?? "",
        documents: new Map(),
      };
      datasets.set(dataset.id, dataset);
      return dataset;
    },
    addDocument(dataset, name, content, ingestionStatus = "UNSTART") {
      const document = { id: newId(), name, content, ingestionStatus };
      dataset.documents.set(document.id, document);
      return document;
    },
  };
}

function documentOf(state, datasetId, documentId) {
  const document = state.datasets.get(datasetId)?.documents.get(documentId);
  if (document === undefined) {
    throw new Error("fake-ragflow has no such document");
  }
  return document;
}

export async function start(options = {}) {
  const key = options.apiKey ?? DEFAULT_KEY;
  const state = createState();
  const requests = [];
  const script = createScript();

  function fillRecord(entry, bytes, contentType) {
    if (contentType.startsWith("application/json")) {
      entry.json = readJsonBody(bytes, contentType).parsed ?? null;
    }
    if (!contentType.startsWith("multipart/form-data")) {
      return null;
    }
    const parts = parseMultipart(contentType, bytes);
    entry.multipart =
      parts?.map(({ field, filename, content }) => ({ field, filename, bytes: content.length })) ??
      null;
    return parts;
  }

  /** 路由与鉴权：脚本没有接管的请求走这里。 */
  function routed(entry, request, bytes, parts, url) {
    const found = routeOf(entry.method, entry.path);
    if (found === undefined) {
      return undefined;
    }
    const denied = found.route.open ? undefined : authFailure(request.headers.authorization, key);
    if (denied !== undefined) {
      return denied;
    }
    const jsonBody = found.route.multipart
      ? { body: {} }
      : readJsonBody(bytes, request.headers["content-type"] ?? "");
    if (jsonBody.rejection !== undefined) {
      return jsonBody.rejection;
    }
    const call = { body: jsonBody.body, parts, params: url.searchParams };
    return found.route.handler(state, call, found.captures);
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://fake-ragflow.invalid");
    const entry = entryOf(request, url, key);
    requests.push(entry);
    const bytes = await readBody(request);
    if (bytes === null) {
      entry.aborted = true;
      return;
    }
    const parts = fillRecord(entry, bytes, request.headers["content-type"] ?? "");
    if (await script.serve(entry.method, entry.path, response)) {
      return;
    }
    const reply = routed(entry, request, bytes, parts, url);
    if (reply === undefined) {
      entry.unknown = true;
      send(response, { status: 404, ...failure(404, `Not Found: ${entry.path}`) });
      return;
    }
    send(response, reply);
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake-ragflow did not bind a TCP address");
  }
  let closed = false;
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests.map((entry) => structuredClone(entry)),
    unknownRoutes: () =>
      requests.filter((entry) => entry.unknown).map((entry) => structuredClone(entry)),
    answer: script.answer,
    fault: script.fault,
    addDataset: (name = "owb-seed") => state.add(name, "general", "").id,
    addDocument(datasetId, seed) {
      const dataset = state.datasets.get(datasetId);
      if (dataset === undefined) {
        throw new Error("fake-ragflow has no such dataset");
      }
      const content = Buffer.from(seed.content);
      return state.addDocument(dataset, seed.name, content, seed.ingestionStatus).id;
    },
    setDocumentStatus(datasetId, documentId, status) {
      documentOf(state, datasetId, documentId).ingestionStatus = status;
    },
    datasets: () =>
      [...state.datasets.values()].map(({ id, name, parserId, embeddingModel }) => ({
        id,
        name,
        parserId,
        embeddingModel,
      })),
    documents: (datasetId) =>
      [...(state.datasets.get(datasetId)?.documents.values() ?? [])].map(
        ({ id, name, content, ingestionStatus }) => ({
          id,
          name,
          size: content.length,
          ingestionStatus,
        }),
      ),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      script.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
