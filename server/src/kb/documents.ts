/**
 * 知识库的文档（s2a-kb-ragflow D10、D13、D20；knowledge-bases「工作空间来源入库」「重新入库与移出」）。组 10：工作空间来源
 * 入库与 RAGFlow 文档的删除写法；列表、重新入库与移出在组 11、13 加进来。
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
 */
import { basename } from "node:path";
import { HttpError } from "../core/errors/index.js";
import { ownedBase } from "./bases.js";
import type { createKbLocks } from "./locks.js";
import { multipartUpload } from "./multipart.js";
import { type createRagflowClient, isRecord } from "./ragflow-client.js";
import { type createSourceFiles, isMountOffline, type OpenedSource } from "./source-file.js";
import type { createKbStore, KbDocument, KnowledgeBase } from "./store.js";
import { acceptsFile } from "./templates.js";

const BODY_KEYS = new Set(["workspaceId", "paths"]);
const MAX_DOCUMENTS_PER_BASE = 500;
const DEFAULT_TIMING: DocumentRemovalTiming = { retryMs: 500, deadlineMs: 5000 };

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
  "uploadDocument" | "parseDocument" | "stopDocument" | "deleteDocument"
>;

interface AuditEvent {
  kind: "kb.ingest" | "kb.ingest_reject";
  actorId: string;
  title: string;
  detail: object;
  workspaceId: string;
}

interface KbDocumentsDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    "getBase" | "findDocumentBySource" | "countDocuments" | "addDocument"
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
    pathList.every((path) => typeof path === "string");
  if (!valid) {
    throw new HttpError("bad_request");
  }
  return { workspaceId, paths: pathList as string[] };
}

/** 上传途中源的失败：这一条的事，不是 RAGFlow 的。 */
function sourceRejection(failure: unknown): RejectReason {
  return isMountOffline(failure) ? "offline" : "changed";
}

/** 空段与 `.` 段不算：`./a.md`、`a.md/` 与 `a.md` 是同一条路径，唯一约束才有意义。 */
function canonicalPath(path: string): string {
  return path
    .split("/")
    .filter((component) => component !== "" && component !== ".")
    .join("/");
}

function viewOf(document: KbDocument) {
  const { id, name, size, source, workspaceId, sourcePath, createdAt } = document;
  return {
    id,
    name,
    size,
    source,
    workspaceId,
    path: sourcePath,
    status: "queued",
    chunkCount: null,
    message: null,
    sourceChanged: false,
    createdAt,
  };
}

type DocumentView = ReturnType<typeof viewOf>;

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

export function createKbDocuments(dependencies: KbDocumentsDependencies) {
  const { store, client, locks, sources, audit, log } = dependencies;
  const { uploadMaxBytes, uploadMaxFiles, removalTiming } = dependencies;

  /** 取锁前后各判一次；次序同 spec：工作空间先于 `state`。 */
  function ingestable(id: string, actorId: string, workspaceId: string): KnowledgeBase {
    const base = ownedBase(store, id, actorId);
    sources.assertVisible({ id: actorId }, workspaceId);
    if (base.state !== "ready") {
      throw new HttpError("kb_rebuilding");
    }
    return base;
  }

  /** 尽力而为：不改变调用方的结果。 */
  async function discard(datasetId: string, documentId: string): Promise<void> {
    const removal = await removeRagflowDocument(client, { datasetId, documentId }, removalTiming);
    if (removal.outcome !== "deleted") {
      log({ event: "kb_document_leak", documentId });
    }
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
    return viewOf(document);
  }

  /** 第 7、8 步：文档已在 RAGFlow，这里的任何失败都要把它删掉。 */
  async function parseAndRecord(
    item: Item,
    opened: OpenedSource,
    documentId: string,
  ): Promise<DocumentView | RejectReason> {
    const { datasetId } = item.base;
    const parsed = await client.parseDocument(datasetId, documentId);
    if (parsed.kind !== "ok") {
      await discard(datasetId, documentId);
      return PARSE_REJECTIONS[parsed.kind];
    }
    try {
      return record(item, opened, documentId);
    } catch (error) {
      await discard(datasetId, documentId);
      throw error;
    }
  }

  /** 第 6 步，先看字节计数：见文件头。 */
  async function transfer(item: Item, opened: OpenedSource): Promise<DocumentView | RejectReason> {
    const upload = multipartUpload({
      name: basename(item.path),
      size: opened.size,
      source: opened.stream(),
    });
    const uploaded = await client.uploadDocument(item.base.datasetId, upload);
    if (uploaded.kind === "ok") {
      return parseAndRecord(item, opened, uploaded.value.id);
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
    const opened = await sources.open(item.workspaceId, item.path, admitted.absPath);
    if ("reason" in opened) {
      return opened.reason;
    }
    if (opened.size === 0 || opened.size > uploadMaxBytes) {
      opened.close();
      return opened.size === 0 ? "empty" : "too_large";
    }
    return transfer(item, opened);
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

  return {
    /** `POST /api/kb/bases/:id/documents`：请求合法即 201，被拒的条目逐条进 `rejected`。 */
    async ingest(id: string, body: unknown, actorId: string) {
      const request = parseIngest(body, uploadMaxFiles);
      ingestable(id, actorId, request.workspaceId);
      const result = await locks.write(id, () => ingestLocked(id, request, actorId));
      if (result.outcome === "rebuilding") {
        throw new HttpError("kb_rebuilding");
      }
      return result.value;
    },
  };
}
