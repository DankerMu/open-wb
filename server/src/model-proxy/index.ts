import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";

const BODY_LIMIT = 4 * 1024 * 1024;
const CONNECT_DEADLINE_MS = 10_000;
const TOKEN_PATTERN = /^[0-9A-Fa-f]{64}$/u;
const JSON_MEDIA = /^application\/json(?:\s*;.*)?$/iu;

export interface TokenLookup {
  lookup(token: string): string | null;
}

interface ModelProxyUpstream {
  baseUrl: string;
  apiKey: string;
}

export interface ModelProxyOptions {
  tokens: TokenLookup;
  upstream?: ModelProxyUpstream | undefined;
}

interface Exchange {
  controller: AbortController;
  req: ClientRequest | undefined;
  response: IncomingMessage | undefined;
  connectTimer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
  cancel(): void;
}

interface IncomingUpload {
  payload: Readable | undefined;
  finish: ((error: Error | null, value?: Buffer) => void) | undefined;
  released: boolean;
  cancel(): void;
  release(): void;
}

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerModelProxy(app: FastifyInstance, options: ModelProxyOptions): void {
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
      parseJsonBytes(request, payload, complete, uploadsByRequest.get(request));
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
      const upstream = options.upstream;
      if (upstream === undefined) {
        throw new HttpError("agent_unavailable");
      }
      await proxyCompletion(
        request,
        reply,
        upstream,
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
  complete: (error: Error | null, value?: Buffer) => void,
  upload: IncomingUpload | undefined,
): void {
  if (upload === undefined) {
    payload.destroy();
    complete(new HttpError("agent_unavailable"));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (error: Error | null, value?: Buffer): void => {
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
    try {
      JSON.parse(raw.toString("utf8"));
    } catch {
      finish(new HttpError("bad_request"));
      return;
    }
    finish(null, raw);
  });
  payload.resume();
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
  if (token === null || options.tokens.lookup(token) === null) {
    return new HttpError("unauthorized");
  }
  if (options.upstream === undefined) {
    return new HttpError("agent_unavailable");
  }
  return undefined;
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
  upstream: ModelProxyUpstream,
  exchanges: Set<Exchange>,
  secureSockets: WeakSet<Socket>,
  upload: IncomingUpload | undefined,
): Promise<void> {
  if (!Buffer.isBuffer(request.body)) {
    throw new HttpError("bad_request");
  }
  const exchange = createExchange(reply);
  exchanges.add(exchange);
  upload?.release();
  request.raw.once("aborted", exchange.cancel);
  reply.raw.once("close", exchange.cancel);
  try {
    const response = await requestUpstream(
      upstream,
      request,
      request.body,
      exchange,
      secureSockets,
    );
    exchange.response = response;
    await sendUpstream(reply, response, exchange);
  } catch (error) {
    if (!exchange.cancelled) {
      throw error instanceof HttpError ? error : new HttpError("agent_unavailable");
    }
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
    cancelled: false,
    cancel(): void {
      if (exchange.cancelled) {
        return;
      }
      exchange.cancelled = true;
      controller.abort();
      clearTimeout(exchange.connectTimer);
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
  if (exchange.cancelled) {
    exchange.req?.destroy();
    exchange.response?.destroy();
  }
}

async function sendUpstream(
  reply: FastifyReply,
  upstreamResponse: IncomingMessage,
  exchange: Exchange,
): Promise<void> {
  const status = upstreamResponse.statusCode ?? 502;
  if (status >= 500) {
    upstreamResponse.resume();
    upstreamResponse.destroy();
    throw new HttpError("agent_unavailable");
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
  upstream: ModelProxyUpstream,
  request: FastifyRequest,
  body: Buffer,
  exchange: Exchange,
  secureSockets: WeakSet<Socket>,
): Promise<IncomingMessage> {
  const endpoint = joinChatCompletions(upstream.baseUrl);
  const client = endpoint.protocol === "https:" ? https : http;
  const headers: OutgoingHttpHeaders = {
    authorization: `Bearer ${upstream.apiKey}`,
    "content-length": body.length,
    host: endpoint.host,
  };
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string") {
    headers["content-type"] = contentType;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeSocketListener: (() => void) | undefined;
    const cleanupSocketListener = (): void => {
      removeSocketListener?.();
      removeSocketListener = undefined;
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      cleanupSocketListener();
      settled = true;
      clearTimeout(exchange.connectTimer);
      reject(error);
    };
    const req = client.request(endpoint, { method: "POST", headers }, (response) => {
      if (settled || exchange.cancelled) {
        response.destroy();
        rejectOnce(new HttpError("agent_unavailable"));
        return;
      }
      cleanupSocketListener();
      settled = true;
      clearTimeout(exchange.connectTimer);
      resolve(response);
    });
    exchange.req = req;
    exchange.connectTimer = setTimeout(() => {
      req.destroy();
      rejectOnce(new HttpError("agent_unavailable"));
    }, CONNECT_DEADLINE_MS);
    req.on("error", rejectOnce);
    req.on("socket", (socket) => {
      removeSocketListener = clearAfterConnection(
        req,
        socket,
        endpoint.protocol === "https:",
        secureSockets,
        () => {
          if (!settled) {
            clearTimeout(exchange.connectTimer);
          }
        },
      );
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
