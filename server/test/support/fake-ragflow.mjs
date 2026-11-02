/**
 * s2a-kb-ragflow 组 5（design D17）：进程内的假 RAGFlow，本 change 全部用例的上游。行为分两类，评审时分开看：
 *
 * - 协议应答：路径、字段、状态值与 code 全部抄自 `docs/reviews/2026-10-28-ragflow-rc2-api.md`，注释写小节号。
 *   处理函数名带 `Absent` 的路由只有「不存在」一支：本组没有实现存在分支，存在时落到未知路由。`answer()` 是
 *   用例脚本化的协议应答，HTTP 状态与 `code` 只收记录里的配对，所以 `108`、`109` 进不来。
 * - 故障注入：`fault()`，只限 tasks.md 头部的四种，种类是闭集，在 `fake-ragflow-script.mjs`。
 *
 * 记录里没有的行为落到未知路由，不猜。处理函数返回 `undefined` 的情形：解析与停止遇到 §8.1、§8.2 表外的状态；
 * 批量停止与空 `document_ids` 的停止；§10 混合批次之外的批量删文档；`DELETE /datasets` 的 `ids` 不是数组、含
 * 重复；上传带 `?type=` 的合法取值；multipart 缺结束边界；一次多个文件里有被拒的。
 *
 * 文档列表在 `fake-ragflow-list.mjs`（组 11），线上字节计数在 `fake-ragflow-wire.mjs`（组 12）。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - 缺 `name` 的 `102` 来自 §12 的「缺字段」，message 借用全空白名字的那句；`name`、`parser_id`、`embedding_model`
 *   的校验次序里，只有 `parser_id` 先于 `name` 有依据（§4.3 不带 `name` 的行）。
 * - `ids` 含重复的 `101` 只有 code（§8.5），message 是这里写的。
 *
 * 与实例的差异：
 * - 上传应答带 `Content-Length`，实例走 chunked（§7.1）。tasks.md 头部「分块下载不进夹具」只限下载，上传应答
 *   用哪种分帧不影响客户端；下载与实例一样始终带 `Content-Length`（§9）。
 *
 * 文档状态是静态的：解析与停止按当前状态应答，不自动迁移，状态由用例经 `setDocumentStatus` 设置（实测里迁移
 * 是异步的，用例要的是确定的状态）。
 *
 * 请求在请求头到达时入记录，请求体读完后补全；请求体没读完连接就断了，记录标 `aborted`，不进状态。密钥不进
 * 记录，只记 Bearer 对不对。未知路由回 §12 的 404 并标 `unknown`：夹具没有清空缺省与删除模型配置的路由，这些
 * 请求落在这里（design D17）。组 9、11 按需加路由。模型路由与 `embedding_model` 的引用校验在
 * `fake-ragflow-models.mjs`（组 8）。
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { documentRow, listDocuments, suffixOf } from "./fake-ragflow-list.mjs";
import {
  API,
  createModelState,
  embeddingRejection,
  MODEL_ROUTES,
  modelViews,
  seedModel,
} from "./fake-ragflow-models.mjs";
import {
  createScript,
  failure,
  JSON_TYPE,
  notFound,
  send,
  success,
} from "./fake-ragflow-script.mjs";
import { wireCounter } from "./fake-ragflow-wire.mjs";

const DEFAULT_KEY = "fake-ragflow-key";
const VERSION = "v1.0.0-rc2";
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
/**
 * 表 C 末列的并集，加 §9 上传成功的 `json`。只有 §7.1 的 `bin.exe`、`thing.zzz`、`noext` 是实测的拒绝，其余不在
 * 这里的后缀被拒都是由表 C 推断的。
 */
const SUFFIXES = new Set(
  (
    "doc docx htm html md markdown mdx pdf xls xlsx csv txt py js java c cpp h php go ts sh cs kt sql " +
    "eml ppt pptx bmp gif jpeg jpg png svg tif tiff webp 3gp 3gpp avi flv mkv mov mp4 mpeg mpg webm wmv " +
    "aac aiff ape au da flac midi mp3 ogg oggvorbis realaudio vqf wav wave wma json"
  ).split(" "),
);
const MAX_DATASET_NAME = 128;
const MAX_FILE_NAME_BYTES = 255;
/** §7.1 的 message 列出的取值。 */
const UPLOAD_TYPES = new Set(["local", "web", "empty"]);
/** §8.5：这两种状态下删除回 `deleted:0`。 */
const UNDELETABLE = new Set(["RUNNING", "STOPPING"]);
/** §8.1 的表：状态到 `success_count`。 */
const PARSE_STARTED = new Map([
  ["UNSTART", 1],
  ["FAILED", 1],
  ["STOPPED", 1],
  ["RUNNING", 0],
  ["COMPLETED", 0],
]);
/** §8.2 的表：状态到能不能停止。 */
const STOPPABLE = new Map([
  ["RUNNING", true],
  ["SCHEDULED", true],
  ["STOPPED", true],
  ["STOPPING", true],
  ["UNSTART", false],
  ["COMPLETED", false],
]);
const CANT_STOP = "Can't stop parsing document that has not started or already completed";
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

/** §8.3：`create_time` 是毫秒，逐份上传没有并列。 */
const FIRST_CREATE_TIME = 1_793_000_000_000;

const newId = () => randomBytes(16).toString("hex");

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

/** §4.5。缺 `name` 的 message 是外推，见文件头。 */
function nameRejection(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return failure(102, "dataset name can't be empty");
  }
  return name.length > MAX_DATASET_NAME
    ? failure(102, `Dataset name length is ${name.length} which is large than 128`)
    : undefined;
}

function createDataset(state, request) {
  const body = request.body;
  const rejection =
    extraField(body, DATASET_FIELDS) ??
    templateRejection(body) ??
    nameRejection(body.name) ??
    embeddingRejection(body.embedding_model, state.models);
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
  const ids = body.ids ?? [];
  if (!Array.isArray(ids)) {
    return undefined; // §4.6 只有空数组、缺失与 `null`。
  }
  if (ids.length === 0) {
    return { json: { code: 0, data: { deleted: [] }, message: null } };
  }
  if (!ids.every(isUuid)) {
    return failure(101, INVALID_UUID);
  }
  if (new Set(ids).size !== ids.length) {
    return undefined; // 重复的 id 只在删文档上测过（§8.5）。
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

/** 部件列表；没有 `boundary` 或缺结束边界时是 `null`：这样的请求体记录里没有。 */
function parseMultipart(contentType, bytes) {
  const boundary = /boundary="?([^";]+)"?/u.exec(contentType)?.[1];
  if (boundary === undefined) {
    return null;
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.concat([CRLF, delimiter]);
  const parts = [];
  let at = bytes.indexOf(delimiter);
  while (at !== -1) {
    const after = at + delimiter.length;
    if (bytes.subarray(after, after + 2).toString() === "--") {
      return parts;
    }
    const start = after + CRLF.length;
    const end = bytes.indexOf(closing, start);
    if (end === -1) {
      return null;
    }
    parts.push(partOf(bytes.subarray(start, end)));
    at = end + CRLF.length;
  }
  return null;
}

/** 重名时加序号，取第一个没被占的；`fold` 决定比较时算不算大小写。 */
function numberedName(names, stem, tail, fold) {
  const taken = new Set(names.map(fold));
  let name = `${stem}${tail}`;
  for (let round = 1; taken.has(fold(name)); round += 1) {
    name = `${stem}(${round})${tail}`;
  }
  return name;
}

/** §4.5：`OWB-DUP` 撞上 `owb-dup`、`owb-dup(1)` 得 `OWB-DUP(2)`。 */
function freeDatasetName(datasets, name) {
  const names = [...datasets.values()].map((dataset) => dataset.name);
  return numberedName(names, name, "", (text) => text.toLowerCase());
}

/** §7.1：同名改名，内容相同与否都一样。 */
function freeName(dataset, name) {
  const names = [...dataset.documents.values()].map((document) => document.name);
  const dot = name.lastIndexOf(".");
  const [stem, tail] = dot === -1 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
  return numberedName(names, stem, tail, (text) => text);
}

function fileRejection({ filename }) {
  if (Buffer.byteLength(filename) > MAX_FILE_NAME_BYTES) {
    return failure(101, "File name must be 255 bytes or less.");
  }
  return SUFFIXES.has(suffixOf(filename).toLowerCase())
    ? undefined
    : failure(500, `${filename}: This type of file has not been supported yet!`);
}

function upload(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return failure(102, `Can't find the dataset with ID ${datasetId}!`);
  }
  const type = request.params.get("type");
  if (type !== null) {
    // 合法取值的行为没有测过，所以落到未知路由。
    return UPLOAD_TYPES.has(type)
      ? undefined
      : failure(101, '"type" must be one of "local", "web", or "empty".');
  }
  if (request.parts === null) {
    return undefined;
  }
  const files = request.parts.filter((part) => part.field === "file");
  if (files.length === 0) {
    return failure(101, "No file part!");
  }
  const rejections = files.flatMap((file) => fileRejection(file) ?? []);
  if (rejections.length > 0) {
    // 一次多个文件只测过全部成功（§7.1）。
    return files.length === 1 ? rejections[0] : undefined;
  }
  const rows = files.map((file) => {
    const name = freeName(dataset, file.filename);
    return {
      ...documentRow(dataset, state.addDocument(dataset, name, file.content)),
      source_type: "local",
    };
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
  if (new Set(ids).size !== ids.length) {
    return failure(101, "Duplicate ids"); // 记录只有 code（§8.5）。
  }
  const absent = ids.find((id) => !dataset.documents.has(id));
  if (absent !== undefined) {
    return failure(
      102,
      `These documents do not belong to dataset ${datasetId} or Document not found: ${absent}`,
    );
  }
  if (ids.length > 1) {
    return undefined; // 批量只有上面的混合批次有记录（§10），`deleted` 的部分成功没有。
  }
  const [id] = ids;
  if (UNDELETABLE.has(dataset.documents.get(id).ingestionStatus)) {
    return success({ deleted: 0 });
  }
  dataset.documents.delete(id);
  return success({ deleted: 1 });
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
  const present = ids.flatMap((id) => dataset.documents.get(id) ?? []); // 不存在的算 0（§8.1）。
  const started = present.map((document) => PARSE_STARTED.get(document.ingestionStatus));
  return started.includes(undefined)
    ? undefined
    : success({ success_count: started.reduce((sum, count) => sum + count, 0) });
}

function stopDocuments(state, request, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const ids = documentIds(request);
  if (ids?.length !== 1) {
    return undefined; // 空 `document_ids` 与批量的停止，记录里没有。
  }
  const [id] = ids;
  const document = dataset.documents.get(id);
  if (document === undefined) {
    return failure(100, `Documents not found: ['${id}']`);
  }
  const stoppable = STOPPABLE.get(document.ingestionStatus);
  if (stoppable === undefined) {
    return undefined;
  }
  return stoppable
    ? success({ success_count: 1 })
    : success({ errors: [CANT_STOP], success_count: 0 });
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
  ["GET", DOCUMENTS, listDocuments],
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
  ...MODEL_ROUTES,
].map(([method, path, handler, options]) => ({
  method,
  pattern: new RegExp(`^${path}$`, "u"),
  handler,
  open: options?.open === true,
  multipart: options?.multipart === true,
}));

/** §12：`Bearer`、`bearer` 与裸密钥被接受，别的写法没有测过，错了一律 `Invalid access token`。 */
function authFailure(header, key) {
  if (header === undefined) {
    return { status: 401, ...failure(401, "Missing Authorization header") };
  }
  return header.replace(/^[Bb]earer /u, "") === key
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
    received: 0,
    json: null,
    multipart: null,
    unknown: false,
    aborted: false,
  };
}

function createState() {
  const datasets = new Map();
  let createTime = FIRST_CREATE_TIME;
  return {
    datasets,
    models: createModelState(),
    add(name, parserId, embeddingModel) {
      const canonical = parserId === "naive" ? "general" : parserId;
      const dataset = {
        id: newId(),
        name: freeDatasetName(datasets, name),
        parserId: canonical,
        embeddingModel: embeddingModel ?? "",
        documents: new Map(),
      };
      datasets.set(dataset.id, dataset);
      return dataset;
    },
    addDocument(dataset, name, content, seed = {}) {
      const { ingestionStatus = "UNSTART", chunkCount = 0, eventMessage } = seed;
      if (chunkCount !== 0 && ingestionStatus !== "COMPLETED") {
        throw new Error(`fake-ragflow chunkCount needs COMPLETED, not ${ingestionStatus}`);
      }
      createTime += 1;
      const document = {
        id: newId(),
        name,
        content,
        ingestionStatus,
        chunkCount,
        eventMessage,
        createTime,
      };
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
      return []; // 不是 multipart 就没有文件字段（§7.1 的 `No file part!`）。
    }
    const parts = parseMultipart(contentType, bytes);
    entry.multipart =
      parts?.map(({ field, filename, content }) => ({ field, filename, bytes: content.length })) ??
      null;
    return parts;
  }

  /** 路由与鉴权：脚本没有接管的请求走这里。 */
  function routed(found, denied, request, bytes, parts, url) {
    if (found === undefined) {
      return undefined;
    }
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
    trackWire(request, response, entry);
    const bytes = await readBody(request);
    if (bytes === null) {
      entry.aborted = true;
      return;
    }
    const parts = fillRecord(entry, bytes, request.headers["content-type"] ?? "");
    const found = routeOf(entry.method, entry.path);
    const denied = found?.route.open ? undefined : authFailure(request.headers.authorization, key);
    if (await script.serve(entry.method, entry.path, response, denied)) {
      return;
    }
    const reply = routed(found, denied, request, bytes, parts, url);
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
  const trackWire = wireCounter(server);
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
    addModel: (instance, name, modelType) => seedModel(state.models, instance, name, modelType),
    addDocument(datasetId, seed) {
      const dataset = state.datasets.get(datasetId);
      if (dataset === undefined) {
        throw new Error("fake-ragflow has no such dataset");
      }
      return state.addDocument(dataset, seed.name, Buffer.from(seed.content), seed).id;
    },
    setDocumentStatus(datasetId, documentId, status) {
      documentOf(state, datasetId, documentId).ingestionStatus = status;
    },
    ...modelViews(state.models),
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
