/**
 * Shared world and wire client of the upload-route tests (issue #1015, s1g tasks 11.2 / 11.3).
 *
 * The world is the production `createApp` listening on a loopback port over a real in-memory
 * SQLite and a per-test temporary sandbox root. Login, workspaces and sessions go through
 * `inject`; every upload goes over a real socket, because an injected request has no stream to
 * stop reading and no connection to drop.
 *
 * The client is `node:net`: the head and the body leave in one `write` (written apart, the server
 * may close with unread bytes pending and the client sees a reset instead of the response), and
 * the client never ends its side — whether the server closes is one of the things under test.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { ensureOmpStateLayout } from "../src/sessions/omp/state-layout.js";
import { withApp } from "./auth-lifecycle-helpers.js";
import { tempDir } from "./core-db-helpers.js";
import { type AuditEventWire, auditEvents } from "./session-delete-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

export const OCTET_STREAM = "application/octet-stream";
export const UPLOAD_TOO_LARGE_ENVELOPE = {
  error: { code: "upload_too_large", message: "文件超过大小上限" },
};
export const SANDBOX_DENIED_ENVELOPE = {
  error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
};
export const CONFLICT_ENVELOPE = { error: { code: "conflict", message: "同名资源已存在" } };
/** How long the client waits for the server to close the connection before giving up. */
const CLOSE_BOUND_MS = 3_000;
/** How long a poll waits for a server-side effect (a temporary file, a closed connection). */
const POLL_BOUND_MS = 5_000;
const POLL_STEP_MS = 10;

export interface UploadWorld {
  app: FastifyInstance;
  db: DatabaseSync;
  /** Real path of the sandbox root: `<sandboxRoot>/<account id>/<dir>` is a workspace root. */
  sandboxRoot: string;
  origin: string;
  /** zhangsan (`u1`). */
  owner: string;
  /** zhaoliu (`u2`). */
  other: string;
}

export interface Workspace {
  id: string;
  root: string;
}

export interface WireResponse {
  /** 0 when the connection closed without a status line. */
  status: number;
  headers: Record<string, string>;
  body: string;
  /** False when the client gave up after its bound with the server still holding the connection. */
  closedByServer: boolean;
}

export interface UploadRequest {
  workspaceId: string;
  /** The raw query string, already percent-encoded (`name=a.txt`); omitted means no query. */
  query?: string;
  /** Omitted means an anonymous request. */
  cookie?: string;
  headers?: Readonly<Record<string, string>>;
  /** Written after the head exactly as given; omitted means the head alone. */
  body?: Buffer;
  /** True leaves out the request's own `Connection: close`: closing is then the server's choice. */
  keepAlive?: boolean;
}

/**
 * Opens the world; `uploadMaxBytes` omitted leaves the assembly without one (createApp's default).
 */
export async function withUploadWorld<T>(
  action: (world: UploadWorld) => Promise<T>,
  options: { uploadMaxBytes?: number } = {},
): Promise<T> {
  const base = realpathSync(tempDir());
  const sandboxRoot = join(base, "sandbox");
  const stateDir = join(base, "state");
  mkdirSync(sandboxRoot);
  // As the production entry does before serving: deleting a session needs the state layout.
  ensureOmpStateLayout(stateDir);
  return withApp(
    {
      assembly: {
        // No prompt is ever dispatched, so the binary is never spawned.
        runtime: { bin: join(base, "omp"), sandboxRoot, stateDir, modelId: "deepseek-v4.1-flash" },
        ...(options.uploadMaxBytes === undefined ? {} : { uploadMaxBytes: options.uploadMaxBytes }),
      },
    },
    async ({ app, db }) => {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test app did not bind a TCP address");
      }
      return action({
        app,
        db,
        sandboxRoot,
        origin: `http://127.0.0.1:${String(address.port)}`,
        owner: await cookieFor(app, "zhangsan"),
        other: await cookieFor(app, "zhaoliu"),
      });
    },
  );
}

/** An ordinary workspace of `accountId` (whose cookie is `cookie`), created through the REST API. */
export async function createWorkspace(
  world: UploadWorld,
  name: string,
  cookie: string = world.owner,
  accountId = "u1",
): Promise<Workspace> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name }),
  });
  expect(response.statusCode).toBe(201);
  const { id, dir } = response.json() as { id: string; dir: string };
  return { id, root: join(world.sandboxRoot, accountId, dir) };
}

function headOf(world: UploadWorld, request: UploadRequest): string {
  const lines = [
    `POST /api/workspaces/${request.workspaceId}/uploads${request.query === undefined ? "" : `?${request.query}`} HTTP/1.1`,
    `Host: ${new URL(world.origin).host}`,
    ...(request.keepAlive === true ? [] : ["Connection: close"]),
    ...(request.cookie === undefined ? [] : [`Cookie: ${request.cookie}`]),
    ...Object.entries(request.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function connect(world: UploadWorld): Promise<Socket> {
  const url = new URL(world.origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function parseWire(bytes: Buffer, closedByServer: boolean): WireResponse {
  const text = bytes.toString("utf8");
  const headEnd = text.indexOf("\r\n\r\n");
  if (headEnd === -1) {
    return { status: 0, headers: {}, body: "", closedByServer };
  }
  const [statusLine = "", ...headerLines] = text.slice(0, headEnd).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: text.slice(headEnd + 4),
    closedByServer,
  };
}

/**
 * Everything the server sends on `socket` until it closes the connection. The client does not
 * close first: after `boundMs` without a close it gives up and says so.
 */
export function readResponse(socket: Socket, boundMs = CLOSE_BOUND_MS): Promise<WireResponse> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.removeAllListeners("close");
      socket.destroy();
      resolve(parseWire(Buffer.concat(chunks), false));
    }, boundMs);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A reset still ends in `close`; what arrived before it is the answer.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(parseWire(Buffer.concat(chunks), true));
    });
  });
}

/** One request, head and body in a single write, and the server's whole answer. */
export async function send(world: UploadWorld, request: UploadRequest): Promise<WireResponse> {
  const socket = await connect(world);
  const answer = readResponse(socket);
  socket.write(startOf(world, request));
  return answer;
}

/** The bytes `send` writes: for a case that has to write more afterwards on its own socket. */
export function startOf(world: UploadWorld, request: UploadRequest): Buffer {
  return Buffer.concat([Buffer.from(headOf(world, request)), request.body ?? Buffer.alloc(0)]);
}

/** A well-formed upload of `content` as `name` (percent-encoded here). */
export function upload(
  world: UploadWorld,
  workspaceId: string,
  name: string,
  content: Buffer | string,
  cookie: string = world.owner,
): Promise<WireResponse> {
  const body = Buffer.from(content);
  return send(world, {
    workspaceId,
    query: `name=${encodeURIComponent(name)}`,
    cookie,
    headers: { "Content-Type": OCTET_STREAM, "Content-Length": String(body.length) },
    body,
  });
}

/** One chunk of transfer-encoding `chunked`, without the terminating chunk. */
export function chunkOf(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${content.length.toString(16)}\r\n`),
    content,
    Buffer.from("\r\n"),
  ]);
}

/** Status, the exact JSON body and no-store. */
export function expectWire(response: WireResponse, status: number, body: unknown): void {
  expect({ status: response.status, body: JSON.parse(response.body) as unknown }).toEqual({
    status,
    body,
  });
  expect(response.headers["cache-control"]).toBe("no-store");
}

/** Names in the workspace's `uploads` directory, sorted; null when there is no such entry. */
export function uploadsOf(workspace: Workspace): string[] | null {
  const dir = join(workspace.root, "uploads");
  return existsSync(dir) ? readdirSync(dir).sort() : null;
}

/** The account's audit events as `GET /api/audit` gives them, oldest first. */
export async function auditOf(
  world: UploadWorld,
  cookie: string = world.owner,
): Promise<AuditEventWire[]> {
  return (await auditEvents(world.app, cookie)).reverse();
}

/** Rows in `audit_events`, every account's: "no audit" is this number not moving. */
export function auditCount(world: UploadWorld): number {
  return Number(
    (world.db.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n,
  );
}

/** Polls every 10 ms until `ready` holds; fails after 5 s naming what did not happen. */
export async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_BOUND_MS;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(POLL_BOUND_MS)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS));
  }
}

/** Open connections on the listening server. */
export function connections(world: UploadWorld): Promise<number> {
  return new Promise((resolve, reject) => {
    world.app.server.getConnections((error, count) => {
      if (error === null) {
        resolve(count);
      } else {
        reject(error);
      }
    });
  });
}
