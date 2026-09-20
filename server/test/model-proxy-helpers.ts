/**
 * Shared model-proxy contract harness. Imports the production registration
 * seam so Stage A1 fails at collection when the module is absent.
 */
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import fastify from "fastify";
import { expect } from "vitest";
import { handleHttpError } from "../src/http/errors.js";
import {
  type ModelProxyOptions,
  registerModelProxy,
  type TokenLookup,
} from "../src/model-proxy/index.js";
import { withListeningApp } from "./raw-http-helpers.js";

export type { ModelProxyOptions, TokenLookup };

export const LIVE_TOKEN = "ab".repeat(32);
export const UNKNOWN_TOKEN = "cd".repeat(32);
export const REVOKED_TOKEN = "ef".repeat(32);
export const API_KEY = "wb-issue98-upstream-api-key";
const CLIENT_COOKIE = "must-not-forward=yes";
const CLIENT_EXTRA_HEADER = "x-workbuddy-client";
export const FOUR_MIB = 4 * 1024 * 1024;
export const CONNECTION_DEADLINE_MS = 10_000;
export const PROXY_PATH = "/v1/chat/completions";

export const UNAUTHORIZED_ENVELOPE = {
  error: { code: "unauthorized", message: "请先登录" },
} as const;
export const AGENT_UNAVAILABLE_ENVELOPE = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
} as const;
export const BAD_REQUEST_ENVELOPE = {
  error: { code: "bad_request", message: "请求格式不正确" },
} as const;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface UpstreamContext {
  request: IncomingMessage;
  response: ServerResponse;
  recorded: RecordedRequest;
  reclaimed: Promise<void>;
}

export interface RecordingUpstream {
  port: number;
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface HeldSseUpstream extends RecordingUpstream {
  release: Gate<void>;
  didFinish(): boolean;
}

interface PendingHeadersResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

interface PendingHeadersUpstream extends RecordingUpstream {
  arrived: Gate<void>;
  release: Gate<void>;
  reclaimed: Gate<void>;
}

export interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface CompletionsInit {
  token?: string | null;
  body?: string | Buffer;
  contentType?: string;
  extra?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RawProxyResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface IncompleteCompletionUpload {
  written: Promise<void>;
  closed: Promise<void>;
  destroy(): void;
}

export function createGate<T = void>(): Gate<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitElapsed(startedAt: number, ms: number): Promise<void> {
  const remaining = ms - (Date.now() - startedAt);
  if (remaining <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, remaining);
  });
}

export async function expectPendingDuring(
  startedAt: number,
  holdMs: number,
  pending: Promise<unknown>,
  earlyLabel: string,
): Promise<void> {
  const winner = await Promise.race([
    pending.then(
      () => "settled" as const,
      (error: unknown) => {
        throw error;
      },
    ),
    waitElapsed(startedAt, holdMs).then(() => "held" as const),
  ]);
  expect(winner, earlyLabel).toBe("held");
}

export async function waitForUpstream(
  arrived: Promise<unknown>,
  pending: Promise<Response>,
  label: string,
): Promise<void> {
  const result = await Promise.race([
    arrived.then(() => ({ kind: "upstream" as const })),
    pending.then((response) => ({ kind: "response" as const, response })),
  ]);
  if (result.kind === "response") {
    throw new Error(
      `${label}: unexpected status ${String(result.response.status)} before upstream contact`,
    );
  }
}

export function liveTokenTable(
  extra: Iterable<readonly [string, string]> = [],
): Map<string, string> {
  return new Map<string, string>([[LIVE_TOKEN, "runtime-live"], ...extra]);
}

export function tokensFrom(table: Map<string, string>): TokenLookup {
  return {
    lookup(token: string): string | null {
      return table.get(token) ?? null;
    },
  };
}

export function jsonBodyOfSize(size: number): string {
  const prefix = '{"text":"你好","pad":"';
  const suffix = '"}';
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  if (size < overhead) {
    throw new Error("requested JSON size is too small");
  }
  const body = `${prefix}${"x".repeat(size - overhead)}${suffix}`;
  if (Buffer.byteLength(body) !== size) {
    throw new Error("JSON size fixture is not exact");
  }
  return body;
}

function proxyHeaders(init: CompletionsInit = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/json",
    cookie: CLIENT_COOKIE,
    [CLIENT_EXTRA_HEADER]: "probe",
    ...init.extra,
  };
  if (init.token !== null) {
    headers.authorization = `Bearer ${init.token ?? LIVE_TOKEN}`;
  }
  return headers;
}

export function postCompletions(origin: string, init: CompletionsInit = {}): Promise<Response> {
  const body =
    init.body === undefined
      ? "{}"
      : typeof init.body === "string"
        ? init.body
        : new Uint8Array(init.body);
  const request: RequestInit = {
    method: "POST",
    headers: proxyHeaders(init),
    body,
    redirect: "manual",
  };
  if (init.signal !== undefined) {
    request.signal = init.signal;
  }
  return fetch(`${origin}${PROXY_PATH}`, request);
}

export function openIncompleteCompletionUpload(origin: string): IncompleteCompletionUpload {
  const written = createGate();
  const closed = createGate();
  const endpoint = new URL(`${origin}${PROXY_PATH}`);
  const settleClosed = (): void => {
    closed.resolve();
  };
  const client = httpRequest(
    {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${LIVE_TOKEN}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    },
    (response) => {
      response.resume();
      response.once("end", settleClosed);
      response.once("error", settleClosed);
    },
  );
  client.once("error", settleClosed);
  client.once("close", settleClosed);
  client.write('{"messages":[', (error) => {
    if (error == null) {
      written.resolve();
      return;
    }
    written.reject(error);
  });
  return { written: written.promise, closed: closed.promise, destroy: () => client.destroy() };
}

export function rawPostCompletions(
  origin: string,
  init: CompletionsInit = {},
): Promise<RawProxyResponse> {
  const url = new URL(`${origin}${PROXY_PATH}`);
  const body = Buffer.from(init.body ?? "{}");
  const headers = proxyHeaders(init);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(body.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

export async function expectFetchEnvelope(
  response: Response,
  status: number,
  envelope: unknown,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body: unknown = await response.json();
  expect(body).toEqual(envelope);
  const text = JSON.stringify(body);
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(LIVE_TOKEN);
}

export function expectInjectEnvelope(
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json: () => unknown;
    payload: string;
  },
  status: number,
  envelope: unknown,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual(envelope);
  expect(response.payload).not.toContain(API_KEY);
  expect(response.payload).not.toContain(LIVE_TOKEN);
}

export function expectZeroUpstream(upstream: RecordingUpstream): void {
  expect(upstream.requests).toEqual([]);
}

export function expectReplacedCredentials(recorded: RecordedRequest, body: Buffer): void {
  expect(recorded.method).toBe("POST");
  expect(recorded.body.equals(body)).toBe(true);
  expect(recorded.headers.authorization).toBe(`Bearer ${API_KEY}`);
  expect(recorded.headers.cookie).toBeUndefined();
  expect(recorded.headers[CLIENT_EXTRA_HEADER]).toBeUndefined();
}

export async function readUntilPrefix(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Buffer,
): Promise<Buffer> {
  const collected: Buffer[] = [];
  let size = 0;
  while (size < prefix.length) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      throw new Error("stream ended before expected prefix");
    }
    collected.push(Buffer.from(value));
    size += value.byteLength;
  }
  const got = Buffer.concat(collected);
  expect(got.subarray(0, prefix.length).equals(prefix)).toBe(true);
  return got;
}

export async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Buffer> {
  const collected: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(collected);
    }
    if (value !== undefined) {
      collected.push(Buffer.from(value));
    }
  }
}

export async function readUntilError(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ bytes: Buffer; error: unknown }> {
  const collected: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("stream closed without a read error");
      }
      if (value !== undefined) {
        collected.push(Buffer.from(value));
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "stream closed without a read error") {
      throw error;
    }
    return { bytes: Buffer.concat(collected), error };
  }
}

export function useResources(): {
  track<T extends { close: () => Promise<void> }>(resource: T): T;
  closeAll(): Promise<void>;
} {
  const resources: Array<{ close: () => Promise<void> }> = [];
  return {
    track<T extends { close: () => Promise<void> }>(resource: T): T {
      resources.push(resource);
      return resource;
    },
    async closeAll(): Promise<void> {
      const pending = resources.splice(0).reverse();
      for (const resource of pending) {
        try {
          await resource.close();
        } catch {
          /* cleanup must continue for sibling resources */
        }
      }
    },
  };
}

async function listenServer(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return address.port;
}

async function closeHttp(server: NetServer, sockets: Socket[] = []): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export async function startRecordingUpstream(
  onRequest: (ctx: UpstreamContext) => Promise<void> | void,
): Promise<RecordingUpstream> {
  const requests: RecordedRequest[] = [];
  const server = createHttpServer((request, response) => {
    const reclaim = createGate();
    const finishReclaim = (): void => {
      reclaim.resolve();
    };
    response.once("close", finishReclaim);
    request.once("aborted", finishReclaim);
    void (async () => {
      const body = await readRequestBody(request);
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      await onRequest({ request, response, recorded, reclaimed: reclaim.promise });
    })().catch((error: unknown) => {
      request.destroy();
      response.destroy();
      throw error;
    });
  });
  const port = await listenServer(server);
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeHttp(server),
  };
}

export async function startHeldSse(first: Buffer, rest: Buffer): Promise<HeldSseUpstream> {
  const release = createGate();
  let finished = false;
  const upstream = await startRecordingUpstream(async ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(first);
    await release.promise;
    response.end(rest);
    finished = true;
  });
  return { ...upstream, release, didFinish: () => finished };
}

export function expectHeldSseCompletion(
  first: Buffer,
  rest: Buffer,
  prefix: Buffer,
  expectedRest: Buffer,
  didFinish: () => boolean,
): void {
  expect(Buffer.concat([first.subarray(prefix.length), rest]).equals(expectedRest)).toBe(true);
  expect(didFinish()).toBe(true);
}

export async function startPendingHeaders(
  responseSpec: PendingHeadersResponse,
): Promise<PendingHeadersUpstream> {
  const arrived = createGate();
  const release = createGate();
  const reclaimed = createGate();
  const upstream = await startRecordingUpstream(async ({ response, reclaimed: closed }) => {
    void closed.then(() => reclaimed.resolve());
    arrived.resolve();
    await release.promise;
    if (!response.writableEnded) {
      if (responseSpec.headers === undefined) {
        response.writeHead(responseSpec.status);
      } else {
        response.writeHead(responseSpec.status, responseSpec.headers);
      }
      response.end(responseSpec.body);
    }
  });
  return { ...upstream, arrived, release, reclaimed };
}

export async function startStalledHandshake(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.resume();
  });
  const port = await listenServer(server);
  return { port, close: () => closeHttp(server, sockets) };
}

export async function installModelProxy(
  app: FastifyInstance,
  options: ModelProxyOptions,
): Promise<void> {
  await Promise.resolve(registerModelProxy(app, options));
}

export async function createProxyApp(options: ModelProxyOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  await installModelProxy(app, options);
  return app;
}

export async function withProxyApp<T>(
  options: ModelProxyOptions,
  action: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const app = await createProxyApp(options);
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

export async function withListeningProxy<T>(
  options: ModelProxyOptions,
  action: (origin: string, app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const app = await createProxyApp(options);
  return withListeningApp(app, (origin) => action(origin, app));
}
