import { lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAccounts } from "./accounts/index.js";
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
import { emit } from "./core/audit/index.js";
import { HttpError } from "./core/errors/index.js";
import { ensureSharedDir } from "./core/sandbox/dirs.js";
import { createSandbox } from "./core/sandbox/index.js";
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
import { registerWorkspaces } from "./workspaces/index.js";
import { createWorkspaceStore } from "./workspaces/store.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseSync;
    authNow: () => number;
    authProviderName: string;
    sessions: { store: SessionStore; supervisor: SessionSupervisor };
  }
}

interface AssemblyDependencies {
  tokens?: TokenRegistry;
  upstream?: { baseUrl: string; apiKey: string } | undefined;
  runtime?: SessionSupervisorRuntime;
  /**
   * Must return synchronously. createApp forwards this callback and its return
   * unchanged; a returned thenable is an owned programming error beside the source fault.
   */
  onError?: (error: Error) => void;
  /**
   * Optional synchronous observer forwarded unchanged, including its return value.
   * A returned thenable is an owned programming error. Omitted means no observer.
   */
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
  /**
   * listener 关停预算（毫秒），在 preClose 阶段之后 Fastify 调用 server.close() 时才开始
   * 计时；省略或显式 `undefined` → 恰 LISTENER_CLOSE_BUDGET_MS。必须是正整数且不超过 Node 定时器上限。
   */
  listenerCloseBudgetMs?: number | undefined;
  /**
   * 仅在预算到期、仍有连接未关而被强制回收时同步调用一次。createApp 自身不写任何记录；
   * 同步抛错被吞掉，不影响关停。
   */
  onListenerForceClose?: (() => void) | undefined;
}

/**
 * listener 关停预算默认值：native 最坏 8s（TERM 5s + KILL 3s）+ listener 2s = 10s，恰等于
 * docker 默认 stop grace 10s——native 最坏情况下余量为零（已知取舍，不是隐含保证）。
 */
export const LISTENER_CLOSE_BUDGET_MS = 2_000;
/** Node setTimeout 可表示的最大延迟；超出会被静默改成 1ms。 */
const TIMER_MAX_MS = 2_147_483_647;

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
  const listenerCloseBudget = validateListenerCloseBudget(
    options.listenerCloseBudgetMs ?? LISTENER_CLOSE_BUDGET_MS,
  );
  const app = fastify({
    logger: false,
    rewriteUrl: (request) => rewriteUntrustedUrl(request.url ?? ""),
  });
  // 必须紧跟 fastify()：其 preClose 是第一个根 hook，任何模块 preClose 失败/超时都跳不过它。
  registerListenerShutdown(app, listenerCloseBudget, options.onListenerForceClose);
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
  const store = createWorkspaceStore(db, {
    sandboxRoot: runtime.sandboxRoot,
    ensureSharedDir,
    emit,
  });
  const audit = { emit: (event: Parameters<typeof emit>[1]) => emit(db, event) };
  const sandbox = createSandbox({ rootOf: store.rootOf, audit });
  registerWorkspaces(app, { store, sandbox, audit });
  registerAccounts(app, { db });

  app.all("/api", (request, reply) => sendNotFound(reply, request));
  app.get("/api/healthz", () => ({ status: "ok" }));
  app.get("/api/info", () => ({ ...SERVICE_INFO, auth: { provider: app.authProviderName } }));
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

function validateListenerCloseBudget(budgetMs: number): number {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > TIMER_MAX_MS) {
    throw new Error(`listener close budget must be an integer in 1..${TIMER_MAX_MS} ms`);
  }
  return budgetMs;
}

/**
 * 有界、无损的 listener 关停：Node server.close() 只在调用瞬间回收一次空闲连接，
 * 之后才完成的 keep-alive 响应会把关停拖到 keepAliveTimeout。closing 期间每个完成的响应
 * 都在下一个宏任务再回收一次空闲连接（Node 跳过仍有未完成请求的连接，不切断在飞请求）；
 * 预算到期仍未关闭才 closeAllConnections() 并通知一次。从未 listen 的 app 全部为 no-op。
 *
 * Fastify 在某个根 preClose complete(err) 或超时后会跳过其后全部根 preClose，但无论结果
 * 如何都会在 preClose 链之后经属性查找调用一次 `instance.server.close()`。因此 closing 标记
 * 由第一个根 preClose 设置，预算由包裹 `app.server.close` 的委托在 native 关停之后才布防，
 * 两者都不依赖 preClose 链成功。
 */
function registerListenerShutdown(
  app: FastifyInstance,
  budgetMs: number,
  onForceClose: (() => void) | undefined,
): void {
  const server = app.server;
  let closing = false;
  let closed = false;
  let budget: NodeJS.Timeout | undefined;
  const settle = (): void => {
    closed = true;
    clearTimeout(budget);
  };
  const escalate = (): void => {
    if (closed) {
      return;
    }
    server.closeAllConnections();
    try {
      onForceClose?.();
    } catch {
      // 通知方故障不得打断关停；记录与否由通知方自己负责。
    }
  };

  app.addHook("preClose", (complete) => {
    if (server.listening) {
      closing = true;
    }
    complete();
  });
  const nativeClose = server.close;
  server.close = function closeWithinBudget(this: typeof server, ...args) {
    // 未 listen 时 Fastify 也会调用 close()（防泄漏），此时不布防。
    if (server.listening && budget === undefined) {
      closing = true;
      server.once("close", settle);
      budget = setTimeout(escalate, budgetMs);
      budget.unref();
    }
    return nativeClose.apply(this, args);
  } satisfies typeof server.close;
  app.addHook("onResponse", (_request, _reply, done) => {
    if (closing) {
      setImmediate(() => {
        if (!closed) {
          server.closeIdleConnections();
        }
      });
    }
    done();
  });
  app.addHook("onClose", (_instance, done) => {
    settle();
    done();
  });
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
