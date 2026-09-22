import { lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_OMP_BIN_RELATIVE,
  DEFAULT_OMP_IDLE_MS,
  DEFAULT_OMP_STATE_RELATIVE,
  DEFAULT_SANDBOX_RELATIVE,
} from "./agent-config.js";
import {
  type AuthRuntime,
  DEFAULT_AUTH_RUNTIME,
  type PasswordSource,
  registerAuth,
  SESSION_TTL,
  validateSessionTtl,
} from "./auth/index.js";
import { HttpError } from "./core/errors/index.js";
import {
  handleHttpError,
  registerAuthGuard,
  rewriteUntrustedUrl,
  sendHttpError,
} from "./http/index.js";
import { classifyRequestPath } from "./http/path-classifier.js";
import { registerModelProxy } from "./model-proxy/index.js";
import { SERVICE_INFO } from "./service-info.js";
import type { ChatEvent } from "./sessions/events.js";
import { registerSessions } from "./sessions/index.js";
import type { SessionStore } from "./sessions/store.js";
import type { SessionSupervisor, SessionSupervisorRuntime } from "./sessions/supervisor.js";
import { TokenRegistry } from "./sessions/tokens.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseSync;
    authNow: () => number;
    sessions: { store: SessionStore; supervisor: SessionSupervisor };
  }
}

interface AssemblyDependencies {
  tokens?: TokenRegistry;
  upstream?: { baseUrl: string; apiKey: string } | undefined;
  runtime?: SessionSupervisorRuntime;
  onError?: (error: Error) => void;
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
}

export interface CreateAppOptions {
  db: DatabaseSync;
  staticRoot?: string;
  secureCookies?: boolean;
  /** 绝对会话过期配置（epoch 毫秒）；省略或显式 `undefined` → 恰 604800000。 */
  sessionTtlMs?: number | undefined;
  authRuntime?: AuthRuntime;
  passwordSource?: PasswordSource;
  assembly?: AssemblyDependencies;
}

/**
 * 装配可注入的 HTTP app。调用方拥有 db 的完整生命周期；本函数不监听也不关闭它。
 * TTL 配置在任何 app/DB 装配之前同步校验：非法值直接抛出，不钳制也不回退默认。
 */
export function createApp(options: CreateAppOptions): FastifyInstance {
  const {
    db,
    staticRoot,
    secureCookies = false,
    sessionTtlMs = SESSION_TTL,
    authRuntime = DEFAULT_AUTH_RUNTIME,
    passwordSource,
  } = options;
  const sessionTtl = validateSessionTtl(sessionTtlMs);
  const app = fastify({
    logger: false,
    rewriteUrl: (request) => rewriteUntrustedUrl(request.url ?? ""),
  });
  const staticFiles = inspectStaticRoot(staticRoot);

  app.decorate("db", db);
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));

  registerAuth(app, {
    db,
    secureCookies,
    sessionTtlMs: sessionTtl,
    runtime: authRuntime,
    mapAuthError: (code) => new HttpError(code),
    ...(passwordSource === undefined ? {} : { passwordSource }),
  });

  registerAuthGuard(app);

  const assembly = options.assembly;
  const tokens = assembly?.tokens ?? new TokenRegistry();
  const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const runtime = assembly?.runtime ?? {
    bin: join(repoRoot, DEFAULT_OMP_BIN_RELATIVE),
    sandboxRoot: join(repoRoot, DEFAULT_SANDBOX_RELATIVE),
    stateDir: join(repoRoot, DEFAULT_OMP_STATE_RELATIVE),
    modelId: DEFAULT_MODEL_ID,
    idleMs: DEFAULT_OMP_IDLE_MS,
  };
  registerModelProxy(app, {
    tokens,
    ...(assembly?.upstream === undefined ? {} : { upstream: assembly.upstream }),
  });
  const registered = registerSessions(app, {
    db,
    tokens,
    runtime,
    onError: assembly?.onError ?? ((error) => observeSessionFault(app, error)),
    ...(assembly?.onEvent === undefined ? {} : { onEvent: assembly.onEvent }),
  });
  app.decorate("sessions", registered);

  app.all("/api", (request, reply) => sendNotFound(reply, request));
  app.get("/api/healthz", () => ({ status: "ok" }));
  app.get("/api/info", () => SERVICE_INFO);
  app.all("/api/*", (request, reply) => sendNotFound(reply, request));

  if (staticFiles !== undefined) {
    app.register(fastifyStatic, {
      root: staticFiles.root,
      serve: false,
      dotfiles: "deny",
    });

    app.get("/*", (request, reply) => {
      const classification = classifyRequestPath(request);
      if (request.method !== "GET" || classification.isApiNamespace || classification.isUnsafe) {
        return sendNotFound(reply, request);
      }

      const pathname = staticPathname(classification.pathname);
      if (pathname === undefined || isStaticSymlink(pathname, staticFiles.root)) {
        return sendNotFound(reply, request);
      }
      if (pathname === "") {
        return sendSpaFallback(reply, staticFiles);
      }

      const exists = isRegularFile(join(staticFiles.root, pathname));
      return exists
        ? reply.sendFile(`/${pathname}`, staticFiles.root)
        : sendSpaFallback(reply, staticFiles);
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const classification = classifyRequestPath(request);
    if (classification.isApiNamespace || classification.isUnsafe || request.method !== "GET") {
      return sendNotFound(reply, request);
    }

    const pathname = staticPathname(classification.pathname);
    if (
      staticFiles?.indexFilename !== undefined &&
      pathname !== undefined &&
      !isStaticSymlink(pathname, staticFiles.root)
    ) {
      return sendSpaFallback(reply, staticFiles);
    }

    return sendNotFound(reply, request);
  });

  return app;
}

interface StaticFiles {
  root: string;
  indexFilename?: string;
}

function staticPathname(pathname: string | undefined): string | undefined {
  return pathname?.slice(1);
}

function sendSpaFallback(reply: FastifyReply, staticFiles: StaticFiles): FastifyReply {
  if (staticFiles.indexFilename === undefined) {
    return sendHttpError(reply, "not_found");
  }

  return reply
    .type("text/html; charset=utf-8")
    .sendFile(`/${staticFiles.indexFilename}`, staticFiles.root);
}

function inspectStaticRoot(staticRoot: string | undefined): StaticFiles | undefined {
  if (staticRoot === undefined) {
    return undefined;
  }

  const root = resolve(staticRoot);
  if (!isRegularDirectory(root)) {
    return undefined;
  }

  const indexPath = join(root, "index.html");
  return isRegularFile(indexPath) ? { root, indexFilename: "index.html" } : { root };
}

function isRegularDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isStaticSymlink(pathname: string | undefined, root: string): boolean {
  return pathname === undefined || hasStaticSymlink(pathname, root);
}

function hasStaticSymlink(pathname: string, root: string): boolean {
  let currentPath = root;

  try {
    for (const segment of pathname.split("/")) {
      if (segment === "") {
        continue;
      }

      currentPath = join(currentPath, segment);
      const entry = lstatSync(currentPath, { throwIfNoEntry: false });
      if (entry === undefined) {
        return false;
      }
      if (entry.isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

function sendNotFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  if (request.method === "HEAD") {
    return reply.code(404).send();
  }

  return sendHttpError(reply, "not_found");
}

function observeSessionFault(app: FastifyInstance, error: Error): void {
  void error;
  app.log.error({ event: "session_fault" });
}
