import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import {
  connectReply,
  gatewayReply,
  NO_CONNECT_REPLY,
  NO_RESPONSE_REPLY,
  statusReply,
  type UpstreamFailureReply,
  upstreamExcerpt,
  upstreamSecretList,
} from "../core/upstream-failure.js";
import { readErrorBody } from "./error-body.js";
import type { ModelRegistry, ModelUpstream } from "./lookup.js";
import { scannedModelId } from "./model-guard.js";

const BODY_LIMIT = 4 * 1024 * 1024;
/** The two deadlines when the caller passes none, which is what production assembly does (#909). */
export const DEFAULT_CONNECT_DEADLINE_MS = 10_000;
export const DEFAULT_FIRST_BYTE_DEADLINE_MS = 120_000;
const TOKEN_PATTERN = /^[0-9A-Fa-f]{64}$/u;
const JSON_MEDIA = /^application\/json(?:\s*;.*)?$/iu;

export interface TokenLookup {
  lookup(token: string): string | null;
}

export interface ModelProxyOptions {
  tokens: TokenLookup;
  /**
   * 按模型查找（design D5）：白名单 = `lookup` 给出 route 的 id，route 的 `upstream` 是转发目标；
   * `secrets()` 是此刻全部已登记上游的密钥集。每个请求在转发前查一次，本模块不缓存；不读环境。
   */
  models: Pick<ModelRegistry, "lookup" | "secrets">;
  /** 自发起连接到传输（DNS/TCP/TLS）建立的期限，到期回 424 `no_connect`；生产装配不传。 */
  connectDeadlineMs?: number | undefined;
  /** 自发出上游请求到收到响应头的期限，到期回 424 `no_response`；生产装配不传。 */
  firstByteDeadlineMs?: number | undefined;
}

interface Deadlines {
  connectMs: number;
  firstByteMs: number;
}

/** One request's forwarding target: the route its `lookup` returned, fixed for the whole exchange (D6). */
interface UpstreamLink extends Deadlines {
  upstream: ModelUpstream;
  /** The excerpt's secret list at failure time: `models.secrets()` then, plus this route's own (D5). */
  secrets: () => readonly string[];
}

/** What the JSON parser hands the route: the original bytes and the upstream their model resolved to. */
class CheckedBody {
  readonly raw: Buffer;
  readonly upstream: ModelUpstream;

  constructor(raw: Buffer, upstream: ModelUpstream) {
    this.raw = raw;
    this.upstream = upstream;
  }
}

/** A failure the proxy answers itself, with a `wb_upstream` envelope instead of the upstream's. */
class UpstreamFailure extends Error {
  readonly reply: UpstreamFailureReply;

  constructor(reply: UpstreamFailureReply) {
    super("upstream failure");
    this.reply = reply;
  }
}

interface Exchange {
  controller: AbortController;
  req: ClientRequest | undefined;
  response: IncomingMessage | undefined;
  connectTimer: ReturnType<typeof setTimeout> | undefined;
  firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
  cancel(): void;
}

interface IncomingUpload {
  payload: Readable | undefined;
  finish: ((error: Error | null, value?: CheckedBody) => void) | undefined;
  released: boolean;
  cancel(): void;
  release(): void;
}

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerModelProxy(app: FastifyInstance, options: ModelProxyOptions): void {
  const { models } = options;
  const deadlines: Deadlines = {
    connectMs: options.connectDeadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS,
    firstByteMs: options.firstByteDeadlineMs ?? DEFAULT_FIRST_BYTE_DEADLINE_MS,
  };
  const secureSockets = new WeakSet<Socket>();
  const exchanges = new Set<Exchange>();
  const uploads = new Set<IncomingUpload>();
  const uploadsByRequest = new WeakMap<FastifyRequest, IncomingUpload>();
  app.addHook("preClose", (complete) => {
    for (const exchange of exchanges) {
      exchange.cancel();
    }
    for (const upload of uploads) {
      upload.cancel();
    }
    complete();
  });
  app.register((instance, _opts, done) => {
    instance.removeContentTypeParser(["application/json", "text/plain"]);
    instance.addContentTypeParser("application/json", (request, payload, complete) => {
      parseJsonBytes(request, payload, complete, uploadsByRequest.get(request), models);
    });
    instance.addHook("onRequest", noStore);
    instance.addHook("onRequest", (request, reply, next) => {
      const error = authenticate(request, options);
      if (error !== undefined) {
        next(error);
        return;
      }
      const upload = createIncomingUpload(request, reply, uploads, uploadsByRequest);
      uploads.add(upload);
      uploadsByRequest.set(request, upload);
      next();
    });
    instance.addHook("onResponse", (request, _reply, next) => {
      uploadsByRequest.get(request)?.release();
      next();
    });
    instance.post("/v1/chat/completions", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const body = request.body;
      if (!(body instanceof CheckedBody)) {
        throw new HttpError("bad_request");
      }
      const { upstream } = body;
      const own = upstreamSecretList({
        apiKey: upstream.apiKey,
        baseUrl: upstream.baseUrl,
        paths: [],
      });
      const link: UpstreamLink = {
        ...deadlines,
        upstream,
        secrets: () => [...models.secrets(), ...own],
      };
      await proxyCompletion(
        request,
        reply,
        link,
        body.raw,
        exchanges,
        secureSockets,
        uploadsByRequest.get(request),
      );
    });
    done();
  });
}

function parseJsonBytes(
  request: FastifyRequest,
  payload: Readable,
  complete: (error: Error | null, value?: CheckedBody) => void,
  upload: IncomingUpload | undefined,
  models: ModelProxyOptions["models"],
): void {
  if (upload === undefined) {
    payload.destroy();
    complete(new HttpError("agent_unavailable"));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (error: Error | null, value?: CheckedBody): void => {
    if (settled) {
      return;
    }
    settled = true;
    upload.finish = undefined;
    upload.payload = undefined;
    complete(error, value);
    if (error !== null) {
      upload.release();
    }
  };
  upload.payload = payload;
  upload.finish = finish;
  payload.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size <= BODY_LIMIT) {
      chunks.push(bytes);
    }
  });
  payload.on("error", (error: Error) => {
    finish(error);
  });
  payload.on("end", () => {
    if (!JSON_MEDIA.test(request.headers["content-type"] ?? "") || size > BODY_LIMIT) {
      finish(new HttpError("bad_request"));
      return;
    }
    const raw = Buffer.concat(chunks);
    // 解析与顶层 `model` 扫描读同一个字符串；语法错误、扫描不通过与未登记走同一条拒绝（不回显）；
    // 放行后转发的仍是原始字节 raw。
    let model: string | undefined;
    try {
      const text = raw.toString("utf8");
      model = scannedModelId(JSON.parse(text), text);
    } catch {
      // JSON 语法错误（或扫描器抛出）：model 保持 undefined，一律拒绝。
    }
    if (model === undefined) {
      finish(new HttpError("bad_request"));
      return;
    }
    const checked = routed(models, model, raw);
    if (checked instanceof Error) {
      finish(checked);
      return;
    }
    finish(null, checked);
  });
  payload.resume();
}

/**
 * 转发前一刻的唯一一次查找（D6）：未登记 400，登记了没有上游 502，否则这次查到的上游就是本请求的，
 * 之后的登记变化不影响它。查找本身抛错是注册表的故障，不当作客户端错误。
 */
function routed(
  models: ModelProxyOptions["models"],
  model: string,
  raw: Buffer,
): Error | CheckedBody {
  let route: ReturnType<ModelProxyOptions["models"]["lookup"]>;
  try {
    route = models.lookup(model);
  } catch {
    return new HttpError("agent_unavailable");
  }
  if (route === undefined) {
    return new HttpError("bad_request");
  }
  return route.upstream === undefined
    ? new HttpError("agent_unavailable")
    : new CheckedBody(raw, route.upstream);
}

function createIncomingUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  uploads: Set<IncomingUpload>,
  uploadsByRequest: WeakMap<FastifyRequest, IncomingUpload>,
): IncomingUpload {
  const upload: IncomingUpload = {
    payload: undefined,
    finish: undefined,
    released: false,
    cancel(): void {
      if (upload.released) {
        return;
      }
      upload.finish?.(new HttpError("agent_unavailable"));
      upload.payload?.destroy();
      if (!request.raw.destroyed) {
        request.raw.destroy();
      }
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.destroy();
      }
      upload.release();
    },
    release(): void {
      if (upload.released) {
        return;
      }
      upload.released = true;
      request.raw.off("aborted", upload.cancel);
      reply.raw.off("close", upload.release);
      uploads.delete(upload);
      uploadsByRequest.delete(request);
    },
  };
  request.raw.once("aborted", upload.cancel);
  reply.raw.once("close", upload.release);
  return upload;
}

function authenticate(request: FastifyRequest, options: ModelProxyOptions): Error | undefined {
  const token = bearerToken(request.headers.authorization);
  return token === null || options.tokens.lookup(token) === null
    ? new HttpError("unauthorized")
    : undefined;
}

function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const token = /^Bearer ([0-9A-Fa-f]+)$/u.exec(header)?.[1];
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}

async function proxyCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  link: UpstreamLink,
  body: Buffer,
  exchanges: Set<Exchange>,
  secureSockets: WeakSet<Socket>,
  upload: IncomingUpload | undefined,
): Promise<void> {
  const exchange = createExchange(reply);
  exchanges.add(exchange);
  upload?.release();
  request.raw.once("aborted", exchange.cancel);
  reply.raw.once("close", exchange.cancel);
  try {
    const response = await requestUpstream(link, request, body, exchange, secureSockets);
    exchange.response = response;
    await sendUpstream(reply, response, exchange, link.secrets);
  } catch (error) {
    if (exchange.cancelled) {
      return;
    }
    if (error instanceof UpstreamFailure) {
      reply.code(error.reply.status).type("application/json").send(error.reply.body);
      return;
    }
    throw error instanceof HttpError ? error : new HttpError("agent_unavailable");
  } finally {
    request.raw.off("aborted", exchange.cancel);
    reply.raw.off("close", exchange.cancel);
    exchanges.delete(exchange);
    disposeExchange(exchange);
  }
}

function createExchange(reply: FastifyReply): Exchange {
  const controller = new AbortController();
  const exchange: Exchange = {
    controller,
    req: undefined,
    response: undefined,
    connectTimer: undefined,
    firstByteTimer: undefined,
    cancelled: false,
    cancel(): void {
      if (exchange.cancelled) {
        return;
      }
      exchange.cancelled = true;
      controller.abort();
      clearTimeout(exchange.connectTimer);
      clearTimeout(exchange.firstByteTimer);
      exchange.req?.destroy();
      exchange.response?.destroy();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.destroy();
      }
    },
  };
  return exchange;
}

function disposeExchange(exchange: Exchange): void {
  clearTimeout(exchange.connectTimer);
  clearTimeout(exchange.firstByteTimer);
  if (exchange.cancelled) {
    exchange.req?.destroy();
    exchange.response?.destroy();
  }
}

async function sendUpstream(
  reply: FastifyReply,
  upstreamResponse: IncomingMessage,
  exchange: Exchange,
  secrets: () => readonly string[],
): Promise<void> {
  const status = upstreamResponse.statusCode ?? 502;
  if (status >= 500) {
    throw new UpstreamFailure(await failureReply(status, upstreamResponse, secrets));
  }
  reply.hijack();
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(status, passthroughHeaders(upstreamResponse));
  }
  try {
    await pipeline(upstreamResponse, reply.raw, { end: true, signal: exchange.controller.signal });
  } catch {
    upstreamResponse.destroy();
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      reply.raw.destroy();
    }
  }
}

/** 504 / 524 are answered without reading a byte; any other ≥500 with its sanitised excerpt. */
async function failureReply(
  status: number,
  upstreamResponse: IncomingMessage,
  secrets: () => readonly string[],
): Promise<UpstreamFailureReply> {
  if (status === 504 || status === 524) {
    upstreamResponse.destroy();
    return gatewayReply(status);
  }
  const { body, cut } = await readErrorBody(upstreamResponse);
  return statusReply(status, upstreamExcerpt(body.toString("utf8"), secrets(), cut));
}

function passthroughHeaders(upstreamResponse: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { "cache-control": "no-store" };
  for (const name of ["content-type", "content-encoding", "location"] as const) {
    const value = upstreamResponse.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

function requestUpstream(
  link: UpstreamLink,
  request: FastifyRequest,
  body: Buffer,
  exchange: Exchange,
  secureSockets: WeakSet<Socket>,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeSocketListener: (() => void) | undefined;
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      removeSocketListener?.();
      removeSocketListener = undefined;
      settled = true;
      clearTimeout(exchange.connectTimer);
      clearTimeout(exchange.firstByteTimer);
      return true;
    };
    const rejectOnce = (error: unknown): void => {
      if (settle()) {
        reject(error);
      }
    };
    let opened: { req: ClientRequest; tls: boolean };
    try {
      opened = openUpstreamRequest(link.upstream, request, body.length, (response) => {
        if (settled || exchange.cancelled) {
          response.destroy();
          rejectOnce(new HttpError("agent_unavailable"));
          return;
        }
        settle();
        resolve(response);
      });
    } catch (error) {
      // 构造上游请求时同步抛错（如密钥里的非法头字符）：与连接失败同一种可重试应答。
      rejectOnce(new UpstreamFailure(connectReply(errorCode(error))));
      return;
    }
    const { req, tls } = opened;
    exchange.req = req;
    // 期限到期先以期限的应答落定、再销毁请求：销毁引出的 error 事件不得把 424 改成 connect.*。
    exchange.connectTimer = setTimeout(() => {
      rejectOnce(new UpstreamFailure(NO_CONNECT_REPLY));
      req.destroy();
    }, link.connectMs);
    exchange.firstByteTimer = setTimeout(() => {
      rejectOnce(new UpstreamFailure(NO_RESPONSE_REPLY));
      req.destroy();
    }, link.firstByteMs);
    req.on("error", (error) => {
      rejectOnce(new UpstreamFailure(connectReply(errorCode(error))));
    });
    req.on("socket", (socket) => {
      removeSocketListener = clearAfterConnection(req, socket, tls, secureSockets, () => {
        if (!settled) {
          clearTimeout(exchange.connectTimer);
        }
      });
    });
    exchange.controller.signal.addEventListener(
      "abort",
      () => {
        req.destroy();
        rejectOnce(new HttpError("agent_unavailable"));
      },
      { once: true },
    );
    if (exchange.cancelled) {
      req.destroy();
      rejectOnce(new HttpError("agent_unavailable"));
      return;
    }
    req.end(body);
  });
}

function openUpstreamRequest(
  upstream: ModelUpstream,
  request: FastifyRequest,
  contentLength: number,
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const endpoint = joinChatCompletions(upstream.baseUrl);
  const tls = endpoint.protocol === "https:";
  const headers: OutgoingHttpHeaders = {
    authorization: `Bearer ${upstream.apiKey}`,
    "content-length": contentLength,
    host: endpoint.host,
  };
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string") {
    headers["content-type"] = contentType;
  }
  const req = (tls ? https : http).request(endpoint, { method: "POST", headers }, onResponse);
  return { req, tls };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function clearAfterConnection(
  req: ClientRequest,
  socket: Socket,
  tls: boolean,
  secureSockets: WeakSet<Socket>,
  clear: () => void,
): (() => void) | undefined {
  if (!tls) {
    if (req.reusedSocket || !socket.connecting) {
      clear();
      return undefined;
    }
    socket.once("connect", clear);
    return () => socket.off("connect", clear);
  }
  if (req.reusedSocket || secureSockets.has(socket)) {
    clear();
    return undefined;
  }
  const onSecureConnect = (): void => {
    secureSockets.add(socket);
    clear();
  };
  socket.once("secureConnect", onSecureConnect);
  return () => socket.off("secureConnect", onSecureConnect);
}

function joinChatCompletions(baseUrl: string): URL {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", root);
}
