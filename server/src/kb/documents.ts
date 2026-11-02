/**
 * 知识库的文档（s2a-kb-ragflow D10、D12、D13、D20；knowledge-bases「工作空间来源入库」「文档列表与状态」「重新入库与移出」）。
 * 组 10：工作空间来源入库与 RAGFlow 文档的删除写法；组 11：列表；本地上传在 `uploads.ts`（组 12）；组 13：移出与重新入库。
 *
 * 入库：整批在该库的写锁下顺序处理。快判到取锁之间没有 `await`：`locks.ts` 的准入是同步的（D20）。取锁后重判库、工作空间
 * 与 `state`，排队期间库可能已删除或转入重建。之后的 `state` 变化（确认重建）不再看：重建器要等这把锁，等到时才枚举文档。
 *
 * 每条依次：解析 → 查重 → 500 上限 → 后缀 → 打开 → 大小 → 上传 → 解析触发 → 同事务插行与 `kb.ingest`。查重与计数在锁内
 * 逐条算，批内的上一条算数。被拒的条目写一条 `kb.ingest_reject`。
 *
 * 逐条失败有三种落点：
 * - 上传得 `kb_rejected`：`rejected`，没有文档要删。解析触发得 `kb_rejected` 或 `parse_not_started`：删文档，`rejected`。
 * - 上传得 `unsupported_file`：`unsupported_type`。按通用映射它是不可达，会中止整批，所以客户端先判（D4）。
 * - `kb_unavailable` 或 `not_found`（数据集没了）：有文档就删，该条与其后全部 `unavailable`，其后的条目什么都不做。
 *
 * 字节计数中止后 `uploadDocument` 回 `kb_unavailable`，所以先看 `sourceFailure()`：源的问题是这一条的事，`changed` 或
 * `offline`，继续下一条。中断的上传不留文档（§7.2），不发删除。成功的上传不看它：结束边界只在字节数对上时才发。
 *
 * 插行或审计失败是本地的失败，没有对应的 `reason`：删掉刚上传的文档，抛出，整批 500，已提交的行留着（同 `bases.ts` 的建库）。
 *
 * 补偿删除一律走 `removeRagflowDocument`，失败只写一行 `kb_document_leak`，不改变该条的结果。
 *
 * RAGFlow 文档的删除写法：`code:0` 不代表删成了，`RUNNING`、`STOPPING` 回 `deleted:0` 且行仍在（§8.5）。停止只发一次：
 * `STOPPING` 时重复是空操作（§8.2）。它不碰本地行，也不取锁：调用方在写锁内调用。
 *
 * 列表：先读本地行，再读全 RAGFlow 的文档，按 RAGFlow 文档 id 关联，不取锁、不判 `state`（D12）。次序不能反：反过来，翻页
 * 之后才提交的文档会显示 `missing`。`readRagflowDocuments` 读到 `total` 为止，不设页数上限，所以 `kb_document_leak` 留下的文档
 * 不会把真实文档挤成 `missing`；读到空页也停：`total` 是这一页说的，翻页期间可能变。结果不抛错：数据集 not-found 在这里
 * 是全部 `missing`，在编译状态（组 9 第三刀）是读取失败，由调用方映射。
 *
 * 运行状态只看 `ingestion_status`。八种之外是协议漂移，不看这一行有没有本地行，整个请求 503。`sourceChanged` 排在 RAGFlow
 * 之后：RAGFlow 失败时不碰文件系统。`sources.stat` 不写审计，所以这个读取整体没有审计。
 *
 * 移出：取锁之前依次判定 `doc` 参数（400）→ `state`（`rebuilding` 409，`rebuild_failed` 允许）→ 文档归属（404），所有权已在路由
 * 判定。取锁后重判这三步里的库、`state` 与文档行，删除用锁内读到的 RAGFlow 文档 id：排在前面的写操作可能已删掉或换掉它。
 * 先按上面的写法删 RAGFlow 文档，`deleted` 才删行，同事务写 `kb.document_delete`；`busy` 与 `failed` 行都不动。不读沙箱，源文件不动。
 *
 * 重新入库：取锁之前依次判定 `doc` 参数（400）→ `state` 不是 `ready`（409，`rebuild_failed` 也拒）→ 文档归属（404）→ 上传来源
 * （400），取锁后重判，旧 RAGFlow 文档 id 取锁内读到的。之后走入库的第 1 步与第 4–7 步（同一份 `transfer`）：查重、上限与后缀
 * 不判，这一行就是它自己，模板也没变。读取被拒（含工作空间已不可见：facade 的 404 在 `resolve` 里归 `not_file`）一律 409
 * `kb_source_unreadable`，不写 `kb.ingest_reject`：审计表没有重新入库的拒绝记录。上传与解析触发的失败按 D11 映射；任何失败都在
 * 换行之前，行不动，上传成功后的失败删掉新文档。都成功后单事务换行内的 RAGFlow id、大小与 `mtimeMs` 并写 `kb.ingest`，再删旧
 * 文档：旧文档可能还在解析，`busy`、`failed` 都只写 `kb_document_leak`，应答照常 200。先建后删：中途失败时行总指向一份在的文档。
 */
import { basename } from "node:path";
import { HttpError, type HttpErrorCode } from "../core/errors/index.js";
import { ownedBase } from "./bases.js";
import type { createKbLocks } from "./locks.js";
import { multipartUpload } from "./multipart.js";
import { type createRagflowClient, isRecord, type ListedDocument } from "./ragflow-client.js";
import { type createSourceFiles, isMountOffline, type OpenedSource } from "./source-file.js";
import type { createKbStore, KbDocument, KnowledgeBase } from "./store.js";
import { acceptsFile } from "./templates.js";

const BODY_KEYS = new Set(["workspaceId", "paths"]);
export const MAX_DOCUMENTS_PER_BASE = 500;
/** 单条路径 UTF-8 编码的字节上限，同 PATH_MAX。被拒的路径原文进审计，而审计行不清理，所以过长的在这里就拦下。 */
const MAX_PATH_BYTES = 4096;
const DEFAULT_TIMING: DocumentRemovalTiming = { retryMs: 500, deadlineMs: 5000 };
const FAILED_MESSAGE = "解析失败";
const REMOVE_TITLE = "知识库移出文档";
const REINGEST_TITLE = "知识库重新入库文档";

/** knowledge-bases「工作空间来源入库」的固定文案。 */
const REASON_MESSAGES = {
  outside: "目标路径不在你的沙箱内",
  not_file: "不是普通文件，或文件不存在",
  too_large: "文件超过大小上限",
  unsupported_type: "这个模板不支持这种文件",
  empty: "文件是空的，不能入库",
  offline: "挂载已离线",
  duplicate: "已在知识库里",
  limit: "知识库文档数已达上限",
  changed: "读取期间文件发生了变化",
  rejected: "知识库服务拒绝了这个文件",
  unavailable: "知识库服务暂不可用",
} as const;

type RejectReason = keyof typeof REASON_MESSAGES;

/** 读取与上传链路（第 1、4–7 步）自己的拒绝原因：查重、上限与后缀在 `admit`。 */
type TransferReason = Exclude<RejectReason, "duplicate" | "limit">;

/** 重新入库的应答（D13）：读取被拒都是源不可读，上传与解析触发的失败同本地上传（D11）。 */
const REINGEST_FAILURES: Record<TransferReason, HttpErrorCode> = {
  outside: "kb_source_unreadable",
  not_file: "kb_source_unreadable",
  offline: "kb_source_unreadable",
  empty: "kb_source_unreadable",
  too_large: "kb_source_unreadable",
  changed: "kb_source_unreadable",
  rejected: "kb_rejected",
  unsupported_type: "kb_file_unsupported",
  unavailable: "kb_unavailable",
};

const UPLOAD_REJECTIONS = {
  kb_rejected: "rejected",
  unsupported_file: "unsupported_type",
  kb_unavailable: "unavailable",
  not_found: "unavailable",
} as const;

const PARSE_REJECTIONS = {
  kb_rejected: "rejected",
  parse_not_started: "rejected",
  kb_unavailable: "unavailable",
  not_found: "unavailable",
} as const;

/** 实测记录表 A。是 `Map`：运行状态是 RAGFlow 的字符串，`constructor` 这样的值不能命中对象原型。 */
const RUN_STATUSES = new Map<string, DocumentStatus>([
  ["UNSTART", "unparsed"],
  ["CREATED", "queued"],
  ["SCHEDULED", "queued"],
  ["RUNNING", "parsing"],
  ["STOPPING", "parsing"],
  ["STOPPED", "cancelled"],
  ["COMPLETED", "done"],
  ["FAILED", "failed"],
]);

type DocumentStatus =
  | "queued"
  | "parsing"
  | "done"
  | "failed"
  | "cancelled"
  | "unparsed"
  | "missing";

/** 视图里来自 RAGFlow 的三个字段。 */
interface RunState {
  status: DocumentStatus;
  chunkCount: number | null;
  message: string | null;
}

/** 解析刚触发成功，写端点不读 RAGFlow（D10）。 */
export const JUST_INGESTED: RunState = { status: "queued", chunkCount: null, message: null };
const MISSING: RunState = { status: "missing", chunkCount: null, message: null };

/** 重发删除的节奏：期限经装配注入（D13）。 */
export interface DocumentRemovalTiming {
  retryMs: number;
  deadlineMs: number;
}

type DocumentRemoval =
  | { outcome: "deleted" }
  | { outcome: "busy" }
  | { outcome: "failed"; kind: "kb_unavailable" | "kb_rejected" };

/** 文档留在了 RAGFlow、本地却没有行：补偿删除失败时写的 stderr 记录。 */
export interface KbDocumentRecord {
  event: "kb_document_leak";
  documentId: string;
}

type Client = Pick<
  ReturnType<typeof createRagflowClient>,
  "listDocuments" | "uploadDocument" | "parseDocument" | "stopDocument" | "deleteDocument"
>;

/** `readRagflowDocuments` 的结果：`not_found` 与失败原样带出来。 */
type ReadDocuments =
  | { kind: "ok"; value: ListedDocument[] }
  | Exclude<Awaited<ReturnType<Client["listDocuments"]>>, { kind: "ok" }>;

interface AuditEvent {
  kind: "kb.ingest" | "kb.ingest_reject" | "kb.document_delete";
  actorId: string;
  title: string;
  detail: object;
  /** 工作空间来源的记录才有（knowledge-bases「知识库审计」）。 */
  workspaceId?: string;
}

interface KbDocumentsDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    | "getBase"
    | "getDocument"
    | "findDocumentBySource"
    | "listDocuments"
    | "countDocuments"
    | "addDocument"
    | "replaceDocument"
    | "removeDocument"
  >;
  client: Client;
  locks: Pick<ReturnType<typeof createKbLocks>, "write">;
  sources: ReturnType<typeof createSourceFiles>;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  /** 受管 stderr writer。 */
  log: (record: KbDocumentRecord) => void;
  uploadMaxBytes: number;
  uploadMaxFiles: number;
  removalTiming?: DocumentRemovalTiming | undefined;
}

interface IngestRequest {
  workspaceId: string;
  paths: string[];
}

/** 正在处理的一条：`path` 是规范写法，文档行、审计与查重都用它。 */
interface Item {
  base: KnowledgeBase;
  actorId: string;
  workspaceId: string;
  path: string;
}

function parseIngest(body: unknown, maxFiles: number): IngestRequest {
  if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    throw new HttpError("bad_request");
  }
  const { workspaceId, paths } = body;
  const pathList = Array.isArray(paths) ? (paths as unknown[]) : [];
  const valid =
    typeof workspaceId === "string" &&
    pathList.length >= 1 &&
    pathList.length <= maxFiles &&
    pathList.every((path) => typeof path === "string" && Buffer.byteLength(path) <= MAX_PATH_BYTES);
  if (!valid) {
    throw new HttpError("bad_request");
  }
  return { workspaceId, paths: pathList as string[] };
}

/** 查询参数 `doc`：Fastify 已解码；缺失、空串与多值（数组）一律 400。移出与重新入库共用。 */
function documentIdOf(query: unknown): string {
  const doc = isRecord(query) ? query.doc : undefined;
  if (typeof doc !== "string" || doc === "") {
    throw new HttpError("bad_request");
  }
  return doc;
}

/** 上传途中源的失败：这一条的事，不是 RAGFlow 的。 */
function sourceRejection(failure: unknown): TransferReason {
  return isMountOffline(failure) ? "offline" : "changed";
}

/** 空段与 `.` 段不算：`./a.md`、`a.md/` 与 `a.md` 是同一条路径，唯一约束才有意义。 */
function canonicalPath(path: string): string {
  return path
    .split("/")
    .filter((component) => component !== "" && component !== ".")
    .join("/");
}

export function viewOf(document: KbDocument, run: RunState, sourceChanged: boolean | null) {
  const { id, name, size, source, workspaceId, sourcePath, createdAt } = document;
  return {
    id,
    name,
    size,
    source,
    workspaceId,
    path: sourcePath,
    ...run,
    sourceChanged,
    createdAt,
  };
}

export type DocumentView = ReturnType<typeof viewOf>;

function runStateOf({ ingestionStatus, chunkCount }: ListedDocument): RunState {
  const status = RUN_STATUSES.get(ingestionStatus);
  if (status === undefined) {
    throw new HttpError("kb_unavailable");
  }
  return {
    status,
    chunkCount: status === "done" ? chunkCount : null,
    message: status === "failed" ? FAILED_MESSAGE : null,
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** D13 的写法，结果给调用方映射：组 12、13、14 复用。不抛错。 */
export async function removeRagflowDocument(
  client: Pick<Client, "stopDocument" | "deleteDocument">,
  { datasetId, documentId }: { datasetId: string; documentId: string },
  timing: DocumentRemovalTiming = DEFAULT_TIMING,
): Promise<DocumentRemoval> {
  const first = await client.deleteDocument(datasetId, documentId);
  if (first.kind === "ok" || first.kind === "not_found") {
    return { outcome: "deleted" };
  }
  if (first.kind !== "not_deleted") {
    return { outcome: "failed", kind: first.kind };
  }
  const stopped = await client.stopDocument(datasetId, documentId);
  if (stopped.kind !== "ok" && stopped.kind !== "not_found") {
    return { outcome: "failed", kind: stopped.kind };
  }
  const deadline = Date.now() + timing.deadlineMs;
  for (;;) {
    await delay(timing.retryMs);
    const retried = await client.deleteDocument(datasetId, documentId);
    if (retried.kind === "ok" || retried.kind === "not_found") {
      return { outcome: "deleted" };
    }
    if (retried.kind !== "not_deleted") {
      return { outcome: "failed", kind: retried.kind };
    }
    if (Date.now() >= deadline) {
      return { outcome: "busy" };
    }
  }
}

/** 补偿删除：尽力而为，不改变调用方的结果。失败只写一行 `kb_document_leak`（D10、D11）。 */
export async function discardRagflowDocument(
  dependencies: {
    client: Pick<Client, "stopDocument" | "deleteDocument">;
    log: (record: KbDocumentRecord) => void;
    removalTiming?: DocumentRemovalTiming | undefined;
  },
  target: { datasetId: string; documentId: string },
): Promise<void> {
  const { client, log, removalTiming } = dependencies;
  const removal = await removeRagflowDocument(client, target, removalTiming);
  if (removal.outcome !== "deleted") {
    log({ event: "kb_document_leak", documentId: target.documentId });
  }
}

/** 读全一个数据集在 RAGFlow 的文档（D12）：组 9 第三刀复用。结果给调用方映射，不抛错。 */
export async function readRagflowDocuments(
  client: Pick<Client, "listDocuments">,
  datasetId: string,
): Promise<ReadDocuments> {
  const value: ListedDocument[] = [];
  for (let page = 1; ; page += 1) {
    const result = await client.listDocuments(datasetId, page);
    if (result.kind !== "ok") {
      return result;
    }
    const { documents, total } = result.value;
    value.push(...documents);
    if (documents.length === 0 || value.length >= total) {
      return { kind: "ok", value };
    }
  }
}

export function createKbDocuments(dependencies: KbDocumentsDependencies) {
  const { store, client, locks, sources, audit } = dependencies;
  const { uploadMaxBytes, uploadMaxFiles } = dependencies;

  /** 取锁前后各判一次；次序同 spec：工作空间先于 `state`。 */
  function ingestable(id: string, actorId: string, workspaceId: string): KnowledgeBase {
    const base = ownedBase(store, id, actorId);
    sources.assertVisible({ id: actorId }, workspaceId);
    if (base.state !== "ready") {
      throw new HttpError("kb_rebuilding");
    }
    return base;
  }

  /** 移出的判定，取锁前后各一次：见文件头。 */
  function removable(id: string, actorId: string, documentId: string) {
    const base = ownedBase(store, id, actorId);
    if (base.state === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    const document = store.getDocument(id, documentId);
    if (document === undefined) {
      throw new HttpError("not_found");
    }
    return { base, document };
  }

  /** 写锁下执行；锁正被重建器持有时不排队，409（D20）。 */
  async function underWriteLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = await locks.write(id, work);
    if (result.outcome === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    return result.value;
  }

  /** 重新入库的判定，取锁前后各一次：见文件头。返回的 `item` 是这一行的源。 */
  function reingestable(id: string, actorId: string, documentId: string) {
    const base = ownedBase(store, id, actorId);
    if (base.state !== "ready") {
      throw new HttpError("kb_rebuilding");
    }
    const document = store.getDocument(id, documentId);
    if (document === undefined) {
      throw new HttpError("not_found");
    }
    const { workspaceId, sourcePath } = document;
    if (workspaceId === null || sourcePath === null) {
      throw new HttpError("bad_request");
    }
    return { document, item: { base, actorId, workspaceId, path: sourcePath } };
  }

  /** 第 3 步（D13）：单事务换行并写 `kb.ingest`。`documentId` 是本地文档 id，取自这一行，不是查询参数。 */
  function replace(
    item: Item,
    documentId: string,
    opened: OpenedSource,
    ragflowDocumentId: string,
  ) {
    const { base, actorId, workspaceId } = item;
    const { size, mtimeMs: sourceMtimeMs } = opened;
    const document = store.replaceDocument(
      base.id,
      documentId,
      { ragflowDocumentId, size, sourceMtimeMs },
      () => {
        audit({
          kind: "kb.ingest",
          actorId,
          title: REINGEST_TITLE,
          detail: { id: base.id, source: "workspace", reingest: true, documentId },
          workspaceId,
        });
      },
    );
    return viewOf(document, JUST_INGESTED, false);
  }

  async function reingestLocked(id: string, documentId: string, actorId: string) {
    const { document, item } = reingestable(id, actorId, documentId);
    const resolved = sources.resolve({ id: actorId }, item.workspaceId, item.path);
    const outcome =
      "reason" in resolved
        ? resolved.reason
        : await transfer(item, resolved.absPath, (opened, ragflowDocumentId) =>
            replace(item, document.id, opened, ragflowDocumentId),
          );
    if (typeof outcome === "string") {
      throw new HttpError(REINGEST_FAILURES[outcome]);
    }
    await discardRagflowDocument(dependencies, {
      datasetId: item.base.datasetId,
      documentId: document.ragflowDocumentId,
    });
    return outcome;
  }

  async function removeLocked(id: string, documentId: string, actorId: string): Promise<void> {
    const { base, document } = removable(id, actorId, documentId);
    const removal = await removeRagflowDocument(
      client,
      { datasetId: base.datasetId, documentId: document.ragflowDocumentId },
      dependencies.removalTiming,
    );
    if (removal.outcome === "busy") {
      throw new HttpError("kb_document_busy");
    }
    if (removal.outcome === "failed") {
      throw new HttpError(removal.kind);
    }
    store.removeDocument(id, documentId, ({ workspaceId }) => {
      audit({
        kind: "kb.document_delete",
        actorId,
        title: REMOVE_TITLE,
        detail: { id, documentId },
        ...(workspaceId === null ? {} : { workspaceId }),
      });
    });
  }

  function record(item: Item, opened: OpenedSource, ragflowDocumentId: string): DocumentView {
    const { base, actorId, workspaceId, path } = item;
    const document = store.addDocument(
      {
        kbId: base.id,
        ragflowDocumentId,
        name: basename(path),
        size: opened.size,
        source: "workspace",
        workspaceId,
        sourcePath: path,
        sourceMtimeMs: opened.mtimeMs,
      },
      ({ id: documentId }) => {
        audit({
          kind: "kb.ingest",
          actorId,
          title: "知识库入库文档",
          detail: { id: base.id, source: "workspace", workspaceId, path, documentId },
          workspaceId,
        });
      },
    );
    return viewOf(document, JUST_INGESTED, false);
  }

  /** 第 7、8 步：文档已在 RAGFlow，这里的任何失败都要把它删掉。`commit` 是同事务的本地写入与审计。 */
  async function parseAndCommit(
    datasetId: string,
    documentId: string,
    commit: () => DocumentView,
  ): Promise<DocumentView | TransferReason> {
    const parsed = await client.parseDocument(datasetId, documentId);
    if (parsed.kind !== "ok") {
      await discardRagflowDocument(dependencies, { datasetId, documentId });
      return PARSE_REJECTIONS[parsed.kind];
    }
    try {
      return commit();
    } catch (error) {
      await discardRagflowDocument(dependencies, { datasetId, documentId });
      throw error;
    }
  }

  /** 第 4–8 步，入库与重新入库共用：打开 → 大小 → 上传（先看字节计数，见文件头）→ 解析触发 → `commit`。 */
  async function transfer(
    item: Item,
    absPath: string,
    commit: (opened: OpenedSource, ragflowDocumentId: string) => DocumentView,
  ): Promise<DocumentView | TransferReason> {
    const { base, workspaceId, path } = item;
    const opened = await sources.open(workspaceId, path, absPath);
    if ("reason" in opened) {
      return opened.reason;
    }
    if (opened.size === 0 || opened.size > uploadMaxBytes) {
      opened.close();
      return opened.size === 0 ? "empty" : "too_large";
    }
    const upload = multipartUpload({
      name: basename(path),
      size: opened.size,
      source: opened.stream(),
    });
    const uploaded = await client.uploadDocument(base.datasetId, upload);
    if (uploaded.kind === "ok") {
      const { id } = uploaded.value;
      return parseAndCommit(base.datasetId, id, () => commit(opened, id));
    }
    const failure = upload.sourceFailure();
    return failure === undefined ? UPLOAD_REJECTIONS[uploaded.kind] : sourceRejection(failure);
  }

  /** 第 1–3 步，都不打开文件。 */
  function admit(item: Item, requested: string): { absPath: string } | RejectReason {
    const { base, actorId, workspaceId, path } = item;
    const resolved = sources.resolve({ id: actorId }, workspaceId, requested);
    if ("reason" in resolved) {
      return resolved.reason;
    }
    if (store.findDocumentBySource(base.id, workspaceId, path) !== undefined) {
      return "duplicate";
    }
    if (store.countDocuments(base.id) >= MAX_DOCUMENTS_PER_BASE) {
      return "limit";
    }
    return acceptsFile(base.template, basename(path)) ? resolved : "unsupported_type";
  }

  async function ingestOne(item: Item, requested: string): Promise<DocumentView | RejectReason> {
    const admitted = admit(item, requested);
    if (typeof admitted === "string") {
      return admitted;
    }
    return transfer(item, admitted.absPath, (opened, id) => record(item, opened, id));
  }

  async function ingestLocked(id: string, request: IngestRequest, actorId: string) {
    const { workspaceId, paths } = request;
    const base = ingestable(id, actorId, workspaceId);
    const documents: DocumentView[] = [];
    const rejected: { path: string; reason: RejectReason; message: string }[] = [];
    let halted = false;
    for (const requested of paths) {
      const item = { base, actorId, workspaceId, path: canonicalPath(requested) };
      const outcome: DocumentView | RejectReason = halted
        ? "unavailable"
        : await ingestOne(item, requested);
      if (typeof outcome !== "string") {
        documents.push(outcome);
        continue;
      }
      halted = outcome === "unavailable";
      rejected.push({ path: requested, reason: outcome, message: REASON_MESSAGES[outcome] });
      audit({
        kind: "kb.ingest_reject",
        actorId,
        title: "知识库入库被拒",
        detail: { id, source: "workspace", workspaceId, path: requested, reason: outcome },
        workspaceId,
      });
    }
    return { documents, rejected };
  }

  /** 工作空间来源比对入库记录；上传来源没有源文件，`null`。 */
  async function sourceChangedOf(document: KbDocument, actorId: string): Promise<boolean | null> {
    const { workspaceId, sourcePath, size, sourceMtimeMs } = document;
    if (workspaceId === null || sourcePath === null) {
      return null;
    }
    const stats = await sources.stat({ id: actorId }, workspaceId, sourcePath);
    if (stats === null) {
      return null;
    }
    return stats === "absent" || stats.size !== size || stats.mtimeMs !== sourceMtimeMs;
  }

  return {
    /** `GET /api/kb/bases/:id/documents`：见文件头。 */
    async list(id: string, actorId: string): Promise<DocumentView[]> {
      const base = ownedBase(store, id, actorId);
      const documents = store.listDocuments(id);
      const listed = await readRagflowDocuments(client, base.datasetId);
      if (listed.kind === "kb_unavailable" || listed.kind === "kb_rejected") {
        throw new HttpError(listed.kind);
      }
      const rows = listed.kind === "ok" ? listed.value : [];
      const states = new Map(rows.map((row) => [row.id, runStateOf(row)]));
      return Promise.all(
        documents.map(async (document) =>
          viewOf(
            document,
            states.get(document.ragflowDocumentId) ?? MISSING,
            await sourceChangedOf(document, actorId),
          ),
        ),
      );
    },

    /** `POST /api/kb/bases/:id/documents`：请求合法且本地写入没有失败即 201，被拒的条目逐条进 `rejected`。 */
    async ingest(id: string, body: unknown, actorId: string) {
      const request = parseIngest(body, uploadMaxFiles);
      ingestable(id, actorId, request.workspaceId);
      return underWriteLock(id, () => ingestLocked(id, request, actorId));
    },

    /** `DELETE /api/kb/bases/:id/documents?doc=<文档 id>`：在该库的写锁下，见文件头。 */
    async remove(id: string, query: unknown, actorId: string): Promise<void> {
      const documentId = documentIdOf(query);
      removable(id, actorId, documentId);
      await underWriteLock(id, () => removeLocked(id, documentId, actorId));
    },

    /** `POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`：在该库的写锁下，见文件头。 */
    async reingest(id: string, query: unknown, actorId: string): Promise<DocumentView> {
      const documentId = documentIdOf(query);
      reingestable(id, actorId, documentId);
      return underWriteLock(id, () => reingestLocked(id, documentId, actorId));
    },
  };
}
