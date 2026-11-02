/**
 * 本地上传（s2a-kb-ragflow D11、D13、D20；knowledge-bases「本地上传入库」）：一个请求一份文件，字节从请求直接拼进出站 multipart
 * （`multipart.ts`），不落盘，不留副本。路由在 `rest.ts`，所有权判定先于这里。
 *
 * 取锁之前依次判定：请求流 → 文件名规则 → 长度 → 超限 → 后缀 → 空文件 → `state`。全程不读请求体。文件名规则排在所有写审计的
 * 判定之前：这条路由不经 `sandbox.resolve`，`parseUploadFileName` 是文件名的唯一防线，也是 `kb.ingest_reject` 里 `name` 的长度
 * 上限。`state` 判定到取锁之间没有 `await`（D20）。
 *
 * 持锁依次：重判库与 `state` → 500 上限 → 上传 → 解析触发 → 同事务插行与 `kb.ingest`。上限只在锁内数：并发的上传排队，后到的
 * 数到先到的那一行。排队期间请求体留在 socket 上。已察觉连接断开的什么都不发：断开之后的请求永远不会结束，出站要等空闲期限，
 * 这段时间锁一直被占着。socket 已停读时（请求体大过 Node 的读缓冲）看不到断开，要读到才察觉，这时走中止，不留文档。
 *
 * 写锁的持有时长不能由客户端决定（D11）：重建器排在在途写操作之后，一个滴发的上传能拖住重建，而滴发一直续着出站的空闲期限。
 * 所以读请求体有总期限，从取到写锁起算，排队时间不算，到期按短体处理。请求不销毁，400 才发得出去。
 *
 * 上传的失败：
 * - 请求体没读全（客户端断开、短体或超过期限）：先问 `sourceFailure()`，这时 `uploadDocument` 只知道请求体坏了，回 `kb_unavailable`。
 *   中断的上传不留文档（§7.2），不发删除，不写审计，应答 400（断开时没有人收）。
 * - `unsupported_file`：400 `kb_file_unsupported`，审计 `unsupported_type`。
 * - `kb_rejected`：400。`kb_unavailable`、`not_found`（数据集没了）：503。都没有文档要删，不写审计：`kb.ingest_reject` 的
 *   `reason` 只有 spec 列出的 `too_large`、`unsupported_type`、`empty`、`limit`。
 *
 * 解析触发失败与本地写入失败都先删掉刚上传的文档，走 D13 的写法，失败只写一行 `kb_document_leak`。
 */
import type { IncomingHttpHeaders } from "node:http";
import { PassThrough, Readable } from "node:stream";
import type { HttpErrorCode } from "../core/errors/index.js";
import { HttpError } from "../core/errors/index.js";
import { parseUploadFileName } from "../workspaces/index.js";
import { ownedBase } from "./bases.js";
import {
  type DocumentRemovalTiming,
  type DocumentView,
  discardRagflowDocument,
  JUST_INGESTED,
  type KbDocumentRecord,
  MAX_DOCUMENTS_PER_BASE,
  viewOf,
} from "./documents.js";
import type { createKbLocks } from "./locks.js";
import { multipartUpload } from "./multipart.js";
import type { createRagflowClient } from "./ragflow-client.js";
import type { createKbStore, KnowledgeBase } from "./store.js";
import { acceptsFile } from "./templates.js";

const DECIMAL = /^[0-9]+$/u;
/** 读请求体的总期限（D11）：`max(下限, Content-Length ÷ 速度)`。 */
const BODY_DEADLINE_FLOOR_MS = 60_000;
const BODY_BYTES_PER_SECOND = 64 * 1024;

const UPLOAD_FAILURES = {
  kb_rejected: "kb_rejected",
  kb_unavailable: "kb_unavailable",
  not_found: "kb_unavailable",
} as const;

const PARSE_FAILURES = {
  kb_rejected: "kb_rejected",
  parse_not_started: "kb_rejected",
  kb_unavailable: "kb_unavailable",
  not_found: "kb_unavailable",
} as const;

export interface UploadBodyDeadline {
  floorMs: number;
  bytesPerSecond: number;
}

interface AuditEvent {
  kind: "kb.ingest" | "kb.ingest_reject";
  actorId: string;
  title: string;
  detail: object;
}

interface KbUploadsDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "getBase" | "countDocuments" | "addDocument">;
  client: Pick<
    ReturnType<typeof createRagflowClient>,
    "uploadDocument" | "parseDocument" | "stopDocument" | "deleteDocument"
  >;
  locks: Pick<ReturnType<typeof createKbLocks>, "write">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  /** 受管 stderr writer。 */
  log: (record: KbDocumentRecord) => void;
  uploadMaxBytes: number;
  removalTiming?: DocumentRemovalTiming | undefined;
  bodyDeadline?: UploadBodyDeadline | undefined;
}

/** 路由交下来的请求。 */
interface UploadRequest {
  query: unknown;
  headers: IncomingHttpHeaders;
  /** 请求流；没有媒体类型也没有请求体时没有 parser 运行，不是流。 */
  body: unknown;
}

/** 通过了取锁之前全部判定的一份上传。 */
interface Incoming {
  id: string;
  actorId: string;
  name: string;
  size: number;
  request: Readable;
}

function assertReady({ state }: KnowledgeBase): void {
  if (state !== "ready") {
    throw new HttpError("kb_rebuilding");
  }
}

function bodyStream(body: unknown): Readable {
  if (!(body instanceof Readable)) {
    throw new HttpError("bad_request");
  }
  return body;
}

/** 分块传输没有这个头：两者同时出现的请求，Node 的解析器到不了这里就拒绝了。 */
function declaredLength(headers: IncomingHttpHeaders): number {
  const length = headers["content-length"];
  if (length === undefined || !DECIMAL.test(length)) {
    throw new HttpError("bad_request");
  }
  return Number(length);
}

export function bodyDeadlineMs(
  size: number,
  { floorMs, bytesPerSecond }: UploadBodyDeadline = {
    floorMs: BODY_DEADLINE_FLOOR_MS,
    bytesPerSecond: BODY_BYTES_PER_SECOND,
  },
): number {
  return Math.max(floorMs, Math.ceil((size * 1000) / bytesPerSecond));
}

/**
 * 请求隔一层再交给 `multipartUpload`：它在出站结束时销毁源，而销毁没读完的请求会带走连接，早应答（RAGFlow 不可达、提前拒绝）
 * 就发不出去。`pipe` 不传播销毁，这一层销毁时只是解除管道。反方向要自己传：断开的请求只 `close`，不 `end`。
 *
 * 期限同样只销毁这一层：`multipartUpload` 记下源的失败，结束边界不发。读完、断开、早应答都以这一层 `close` 收尾，定时器在那里清。
 */
function detachedSource(request: Readable, deadlineMs: number): Readable {
  const source = new PassThrough();
  const deadline = setTimeout(() => {
    source.destroy(new Error("request body deadline expired"));
  }, deadlineMs);
  deadline.unref();
  source.once("close", () => {
    clearTimeout(deadline);
  });
  request.once("close", () => {
    if (!request.readableEnded) {
      source.destroy(new Error("request closed before its end"));
    }
  });
  request.pipe(source);
  return source;
}

export function createKbUploads(dependencies: KbUploadsDependencies) {
  const { store, client, locks, audit, uploadMaxBytes, bodyDeadline } = dependencies;

  /** 写一条 `kb.ingest_reject`，返回要抛的错误。 */
  function rejected(
    { id, actorId, name }: Pick<Incoming, "id" | "actorId" | "name">,
    reason: "too_large" | "unsupported_type" | "empty" | "limit",
    code: HttpErrorCode,
  ): HttpError {
    audit({
      kind: "kb.ingest_reject",
      actorId,
      title: "知识库入库被拒",
      detail: { id, source: "upload", name, reason },
    });
    return new HttpError(code);
  }

  function assertAcceptable(incoming: Incoming, template: string): void {
    if (incoming.size > uploadMaxBytes) {
      throw rejected(incoming, "too_large", "upload_too_large");
    }
    if (!acceptsFile(template, incoming.name)) {
      throw rejected(incoming, "unsupported_type", "kb_file_unsupported");
    }
    if (incoming.size === 0) {
      throw rejected(incoming, "empty", "kb_file_unsupported");
    }
  }

  function record(incoming: Incoming, ragflowDocumentId: string): DocumentView {
    const { id, actorId, name, size } = incoming;
    const document = store.addDocument(
      { kbId: id, ragflowDocumentId, name, size, source: "upload" },
      ({ id: documentId }) => {
        audit({
          kind: "kb.ingest",
          actorId,
          title: "知识库入库文档",
          detail: { id, source: "upload", name, size, documentId },
        });
      },
    );
    return viewOf(document, JUST_INGESTED, null);
  }

  /** 文档已在 RAGFlow，这里的任何失败都要把它删掉。 */
  async function parseAndRecord(
    incoming: Incoming,
    datasetId: string,
    documentId: string,
  ): Promise<DocumentView> {
    const parsed = await client.parseDocument(datasetId, documentId);
    if (parsed.kind !== "ok") {
      await discardRagflowDocument(dependencies, { datasetId, documentId });
      throw new HttpError(PARSE_FAILURES[parsed.kind]);
    }
    try {
      return record(incoming, documentId);
    } catch (error) {
      await discardRagflowDocument(dependencies, { datasetId, documentId });
      throw error;
    }
  }

  async function transfer(incoming: Incoming, datasetId: string): Promise<DocumentView> {
    const { name, size, request } = incoming;
    const source = detachedSource(request, bodyDeadlineMs(size, bodyDeadline));
    const upload = multipartUpload({ name, size, source });
    const uploaded = await client.uploadDocument(datasetId, upload);
    if (uploaded.kind === "ok") {
      return parseAndRecord(incoming, datasetId, uploaded.value.id);
    }
    if (upload.sourceFailure() !== undefined) {
      throw new HttpError("bad_request");
    }
    if (uploaded.kind === "unsupported_file") {
      throw rejected(incoming, "unsupported_type", "kb_file_unsupported");
    }
    throw new HttpError(UPLOAD_FAILURES[uploaded.kind]);
  }

  async function uploadLocked(incoming: Incoming): Promise<DocumentView> {
    const { id, actorId, request } = incoming;
    const base = ownedBase(store, id, actorId);
    assertReady(base);
    if (store.countDocuments(id) >= MAX_DOCUMENTS_PER_BASE) {
      throw rejected(incoming, "limit", "kb_limit");
    }
    if (request.destroyed) {
      throw new HttpError("bad_request");
    }
    return transfer(incoming, base.datasetId);
  }

  return {
    /** `POST /api/kb/bases/:id/uploads`：见文件头。 */
    async upload(id: string, request: UploadRequest, actorId: string): Promise<DocumentView> {
      const body = bodyStream(request.body);
      const name = parseUploadFileName(request.query);
      const size = declaredLength(request.headers);
      const incoming = { id, actorId, name, size, request: body };
      const base = ownedBase(store, id, actorId);
      assertAcceptable(incoming, base.template);
      assertReady(base);
      const result = await locks.write(id, () => uploadLocked(incoming));
      if (result.outcome === "rebuilding") {
        throw new HttpError("kb_rebuilding");
      }
      return result.value;
    },
  };
}
