/**
 * `kb-upload*.test.ts` 的请求（s2a-kb-ragflow tasks 12.2，#1849）。世界是 `kb-ingest-helpers.ts` 的世界：`createApp`、真实 SQLite、
 * 假 RAGFlow。上传经 `app.inject()`，请求体用 Buffer。注入的请求没有 socket，所以连接层的行为（客户端断开、分块传输、早应答
 * 能不能发到客户端）走回环端口上的裸 socket，写法同 `workspace-upload-helpers.ts`：请求头与已发的字节一次写出。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import { expect, vi } from "vitest";
import type { IngestWorld } from "./kb-ingest-helpers.js";
import { OWNER } from "./mounts-manager-helpers.js";
import { OCTET_STREAM, readResponse, type WireResponse } from "./workspace-upload-helpers.js";

export const KB_FILE_UNSUPPORTED = {
  error: {
    code: "kb_file_unsupported",
    message: "这个文件不能入库：模板不支持这种类型，或文件是空的",
  },
};
export const KB_LIMIT = { error: { code: "kb_limit", message: "知识库或文档数已达上限" } };
export const KB_REJECTED = { error: { code: "kb_rejected", message: "知识库服务拒绝了这个请求" } };
/** 连接层用例等服务端关连接的上限：到了也只是判失败，不改变计数。 */
const CLOSE_BOUND_MS = 10_000;

interface UploadOptions {
  baseId?: string;
  who?: "member" | "admin" | "anonymous";
  contentLength?: number | string;
  contentType?: string;
}

const uploadUrl = (world: IngestWorld, query: string, baseId = world.baseId): string =>
  `/api/kb/bases/${baseId}/uploads${query === "" ? "" : `?${query}`}`;

export const nameQuery = (name: string): string => `name=${encodeURIComponent(name)}`;

function cookieHeaders(world: IngestWorld, who: UploadOptions["who"] = "member") {
  return who === "anonymous" ? {} : { cookie: world.fw.rest.cookies[who] };
}

/** 查询串原样给：文件名规则的用例要写畸形的。 */
export function uploadRaw(
  world: IngestWorld,
  query: string,
  payload: unknown,
  options: UploadOptions = {},
): Promise<LightMyRequestResponse> {
  const { contentLength, contentType = OCTET_STREAM } = options;
  return world.fw.rest.app.inject({
    method: "POST",
    url: uploadUrl(world, query, options.baseId),
    headers: {
      ...cookieHeaders(world, options.who),
      "content-type": contentType,
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    },
    ...(payload === undefined ? {} : { payload: payload as string }),
  });
}

export const upload = (
  world: IngestWorld,
  name: string,
  bytes: Buffer | string = "content",
  options?: UploadOptions,
): Promise<LightMyRequestResponse> => uploadRaw(world, nameQuery(name), bytes, options);

/** 已有 `n` 份文档：直接插行，假 RAGFlow 上没有它们，这里只数行。 */
export function seedDocuments(world: IngestWorld, n: number): void {
  for (let index = 0; index < n; index += 1) {
    world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId: `seeded-${String(index)}`,
      name: `seeded-${String(index)}.md`,
      size: 1,
      source: "upload",
    });
  }
}

export function expectNoIngestAudit(world: IngestWorld): void {
  expect(world.audits("kb.ingest")).toEqual([]);
  expect(world.audits("kb.ingest_reject")).toEqual([]);
}

/** 上传路由的 `kb.ingest_reject`：标题固定，`workspace_id` 列为 null，actor 是请求的 principal。 */
export function expectRejects(
  world: IngestWorld,
  expected: Array<{ name: string; reason: string }>,
): void {
  expect(world.audits("kb.ingest_reject")).toEqual(
    expected.map(({ name, reason }) => ({
      actorId: OWNER,
      title: "知识库入库被拒",
      detail: { id: world.baseId, source: "upload", name, reason },
      workspaceId: null,
    })),
  );
}

/** 上传完的那份在假 RAGFlow 上的 id。 */
export const uploadedId = (world: IngestWorld): string =>
  world.fake.documents(world.datasetId)[0]?.id ?? "";

/** 解析触发请求里的文档 id。 */
export function parsedId(world: IngestWorld): string {
  const parse = world.fake.requests().find(({ path }) => path.endsWith("/documents/parse"));
  const json = parse?.json as { document_ids: string[] } | undefined;
  return json?.document_ids[0] ?? "";
}

/** 删除的请求体就是这一份文档；RAGFlow 上不留，本地没有行，没有审计。 */
export function expectCompensated(world: IngestWorld, documentId: string): void {
  const deletes = world.fake
    .requests()
    .filter(({ method, path }) => method === "DELETE" && path.endsWith("/documents"));
  expect(deletes.map(({ json }) => json)).toEqual([{ ids: [documentId] }]);
  expect(world.fake.documents(world.datasetId)).toEqual([]);
  expect(world.rows()).toEqual([]);
  expectNoIngestAudit(world);
}

/** 被读一次就记一次的请求体。 */
export function countingBody(): { payload: Readable; pulled: () => number } {
  let pulled = 0;
  const payload = new Readable({
    read() {
      pulled += 1;
      this.push("content");
      this.push(null);
    },
  });
  return { payload, pulled: () => pulled };
}

const listing = (root: string): string[] =>
  readdirSync(root, { recursive: true }).map(String).sort();

/**
 * `action` 拿到的函数断言 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`os.tmpdir()` 的清单没有变。别的用例文件同时往系统临时目录里写：
 * `os.tmpdir()` 每次读 TMPDIR，指到这个用例自己的目录，清单才只反映这个请求。
 */
export async function withDiskWatch(
  world: IngestWorld,
  action: (expectDiskUnchanged: () => void) => Promise<void>,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "kb-upload-"));
  vi.stubEnv("TMPDIR", scratch);
  try {
    expect(tmpdir()).toBe(scratch);
    const { sandbox, state } = world.fw.world;
    const roots = [sandbox, state, scratch];
    const before = roots.map(listing);
    await action(() => {
      expect(roots.map(listing)).toEqual(before);
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** 占住该库的写锁，直到调用返回的函数；后面的上传在这期间排队。 */
export function holdWriteLock(world: IngestWorld): () => Promise<void> {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = world.locks.write(world.baseId, () => held);
  return async () => {
    release();
    await holder;
  };
}

export async function listen(world: IngestWorld): Promise<number> {
  const { app } = world.fw.rest;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test app did not bind a TCP address");
  }
  return address.port;
}

export function connectionCount(world: IngestWorld): Promise<number> {
  return new Promise((resolve, reject) => {
    world.fw.rest.app.server.getConnections((error, count) => {
      if (error === null) {
        resolve(count);
      } else {
        reject(error);
      }
    });
  });
}

/** 一条连接，写出请求头与 `body`，不结束请求：之后断开还是等应答由用例决定。 */
export async function startUpload(
  world: IngestWorld,
  port: number,
  request: { query: string; headers: Record<string, string>; body?: Buffer; baseId?: string },
): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines = [
    `POST ${uploadUrl(world, request.query, request.baseId)} HTTP/1.1`,
    "Host: localhost",
    `Cookie: ${world.fw.rest.cookies.member}`,
    `Content-Type: ${OCTET_STREAM}`,
    ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
  ];
  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
  socket.write(Buffer.concat([head, request.body ?? Buffer.alloc(0)]));
  return socket;
}

export const answerOf = (socket: Socket): Promise<WireResponse> =>
  readResponse(socket, CLOSE_BOUND_MS);
