import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
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
  DEFAULT_SNAPSHOT_SETTINGS,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_FILES,
  type SnapshotSettings,
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
import { sanitizeUpstreamText, upstreamSecretList } from "./core/upstream-failure.js";
import {
  handleHttpError,
  registerAuthGuard,
  rewriteUntrustedUrl,
  sendHttpError,
} from "./http/index.js";
import {
  LISTENER_CLOSE_BUDGET_MS,
  registerListenerShutdown,
  validateListenerCloseBudget,
} from "./http/listener-shutdown.js";
import { classifyRequestPath } from "./http/path-classifier.js";
import { type ApprovalMode, type ModelCatalog, resolveModelCatalog } from "./model-catalog.js";
import { registerModelProxy } from "./model-proxy/index.js";
import { DEFAULT_TRASH_RETENTION_DAYS } from "./preview-config.js";
import { SERVICE_INFO } from "./service-info.js";
import type { ChatEvent } from "./sessions/events.js";
import { registerSessions } from "./sessions/index.js";
import type { SessionListNotifier } from "./sessions/list-events.js";
import { ompAgentDir } from "./sessions/omp/process.js";
import { ensureRepoRootMarker } from "./sessions/omp/repo-root-marker.js";
import type { SpawnLog } from "./sessions/omp/spawn-gate.js";
import { ompSnapshotsDir } from "./sessions/omp/state-layout.js";
import type { SessionStore } from "./sessions/store.js";
import type { TodoWarn } from "./sessions/store-todo.js";
import type { SessionSupervisor, SessionSupervisorRuntime } from "./sessions/supervisor.js";
import { TokenRegistry } from "./sessions/tokens.js";
import type { TurnSnapshotService } from "./sessions/turn-snapshot.js";
import { registerWorkspaces } from "./workspaces/index.js";
import type { PreviewLimits } from "./workspaces/preview.js";
import type { WorkspacePreviewDependencies } from "./workspaces/rest-preview-token.js";
import { removeSnapshot, removeWorkspaceSnapshots, take } from "./workspaces/snapshots.js";
import { restore } from "./workspaces/snapshots-restore.js";
import { createWorkspaceStore, type WorkspaceStore } from "./workspaces/store.js";
import { createTrash } from "./workspaces/trash.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseSync;
    authNow: () => number;
    authProviderName: string;
    sessions: {
      store: SessionStore;
      supervisor: SessionSupervisor;
      listEvents: SessionListNotifier;
    };
    /** The one workspace store and sandbox facade of this app; the preview listener shares them. */
    workspaces: {
      store: WorkspaceStore;
      sandbox: ReturnType<typeof createSandbox>;
    };
  }
}

/**
 * The sessions module's runtime settings object: the supervisor's settings plus the four snapshot
 * settings (an omitted one takes its default).
 */
export type SessionRuntime = SessionSupervisorRuntime & Partial<SnapshotSettings>;

export interface AssemblyDependencies {
  tokens?: TokenRegistry;
  upstream?: { baseUrl: string; apiKey: string } | undefined;
  runtime?: SessionRuntime;
  /**
   * Replaces the workspace-snapshots service createApp would build from `runtime` (tests that hold
   * a snapshot open or make it fail). Omitted in production.
   */
  snapshots?: TurnSnapshotService;
  /**
   * Replaces the recycle directory service createApp would build on `runtime.sandboxRoot` (tests
   * that make the rename fail). Omitted in production.
   */
  trash?: ReturnType<typeof createTrash>;
  /** 模型白名单；省略时只有 `runtime.modelId` 一个模型。 */
  modelCatalog?: ModelCatalog;
  /** 审批档位的最高档；省略时不封顶（`yolo`）。 */
  approvalMaxMode?: ApprovalMode;
  /** 单个上传文件的字节上限；省略时取缺省 524288000。 */
  uploadMaxBytes?: number;
  /** 一条消息可带的附件个数上限；省略时取缺省 10。 */
  uploadMaxFiles?: number;
  /** 预览的文本、图片、Notebook 三个字节上限与压缩包列表的条目数上限；省略时取规格缺省值（由 workspaces 模块给出）。 */
  previewLimits?: PreviewLimits;
  /**
   * 预览依赖（令牌登记表、预览端口、对外来源、文档上限、转换是否可用）；省略时不注册
   * `POST /api/workspaces/:id/preview-token`。
   */
  preview?: WorkspacePreviewDependencies;
  /**
   * Must return synchronously. createApp forwards this callback and its return
   * unchanged; a returned thenable is an owned programming error beside the source fault.
   * Omitted means no observer: the faults stay retained and surface at shutdown.
   */
  onError?: (error: Error) => void;
  /**
   * Optional synchronous observer forwarded unchanged, including its return value.
   * A returned thenable is an owned programming error. Omitted means no observer.
   */
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
  /** Optional synchronous handshake-timeout record sink, forwarded unchanged; not an onError fault. */
  log?: SpawnLog;
  /** Optional synchronous warn sink for a dropped task-list candidate; not an onError fault. */
  warn?: TodoWarn;
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

/** 定义在 `http/listener-shutdown.ts`（预览监听器共用）；从这里再导出，既有导入方不变。 */
export { LISTENER_CLOSE_BUDGET_MS };

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
  const runtime: SessionRuntime = assembly?.runtime ?? {
    bin: join(repoRoot, DEFAULT_OMP_BIN_RELATIVE),
    sandboxRoot: join(repoRoot, DEFAULT_SANDBOX_RELATIVE),
    stateDir: join(repoRoot, DEFAULT_OMP_STATE_RELATIVE),
    modelId: DEFAULT_MODEL_ID,
    idleMs: DEFAULT_OMP_IDLE_MS,
  };
  // 代理白名单与会话视图的有效值用同一份目录。
  const modelCatalog = assembly?.modelCatalog ?? resolveModelCatalog({ MODEL_ID: runtime.modelId });
  registerModelProxy(app, {
    tokens,
    allowedModels: new Set(modelCatalog.models.map((model) => model.id)),
    ...(assembly?.upstream === undefined ? {} : { upstream: assembly.upstream }),
  });
  const store = createWorkspaceStore(db, {
    sandboxRoot: runtime.sandboxRoot,
    ensureSharedDir,
    ensureRepoRootMarker,
    emit,
  });
  const upload = uploadLimits(assembly);
  // One facade for the workspaces routes and the prompt route's attachment check.
  const audit = { emit: (event: Parameters<typeof emit>[1]) => emit(db, event) };
  const sandbox = createSandbox({ rootOf: store.rootOf, audit });
  const registered = registerSessions(app, {
    db,
    tokens,
    runtime,
    workspaceRootOf: (ownerId, workspaceId) => store.rootOf({ id: ownerId }, workspaceId),
    createTemporaryWorkspace: (ownerId) => {
      // The entry's `sandbox_root` stage (server.ts) has made the root: this finds it and changes
      // nothing (read from the code). Only assemblies that bypass the entry make it here, at 2770;
      // the store makes the account root.
      ensureSharedDir(runtime.sandboxRoot);
      return store.createTemporary({ id: ownerId });
    },
    agentDir: ompAgentDir(runtime.stateDir),
    composer: { approvalMaxMode: assembly?.approvalMaxMode ?? "yolo", modelCatalog },
    upload,
    sandbox,
    snapshots: assembly?.snapshots ?? snapshotService(runtime),
    onError: assembly?.onError ?? (() => {}),
    ...(assembly?.onEvent === undefined ? {} : { onEvent: assembly.onEvent }),
    ...(assembly?.log === undefined ? {} : { log: assembly.log }),
    ...(assembly?.warn === undefined ? {} : { warn: assembly.warn }),
    redactUpstream: upstreamRedactor(assembly?.upstream, runtime),
  });
  app.decorate("sessions", registered);
  app.decorate("workspaces", { store, sandbox });
  registerWorkspaces(
    app,
    {
      store,
      sandbox,
      audit,
      listEvents: registered.listEvents,
      uploadMaxBytes: upload.maxBytes,
      // Building it touches no file system; nothing schedules its sweep here.
      trash:
        assembly?.trash ??
        createTrash({
          sandboxRoot: runtime.sandboxRoot,
          retentionDays: DEFAULT_TRASH_RETENTION_DAYS,
        }),
      ...(assembly?.previewLimits === undefined ? {} : { limits: assembly.previewLimits }),
    },
    assembly?.preview,
  );
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

/**
 * sessions 的净化闭包（#909，upstream-failure「上游原文净化」）：每次净化时构造密钥集——上游的 apiKey
 * 与 base URL 各部分（未配置上游时没有），OMP 状态目录与沙箱根各四种写法：配置原值、`normalize` 后的
 * 原值（去掉 `//`、`/./` 而不解析符号链接）、再去掉末尾 `/` 的写法（根目录除外）与此刻的 realpath
 * （`realpathSync.native`，macOS 上连大小写也取盘上的，APFS 上实测；目录不在、取不到时没有这一项），
 * 相同的只列一次。realpath 在净化时才取：生产入口在建托管布局与 `sandbox_root` 阶段（都在 listen
 * 之后）之前调用 createApp。只有失败的回合调用它；这两次同步 realpath 在挂起的挂载点上会阻塞事件循环，
 * 与每次 spawn 重建状态目录布局时的同步 fs 调用（`sessions/omp/process.ts:87`）是同一个暴露面（读代码推出）。
 */
function upstreamRedactor(
  upstream: AssemblyDependencies["upstream"],
  runtime: SessionRuntime,
): (text: string) => string {
  return (text) => {
    const paths: string[] = [];
    for (const path of [runtime.stateDir, runtime.sandboxRoot]) {
      const normalised = normalize(path);
      paths.push(path, normalised, withoutTrailingSlash(normalised));
      try {
        paths.push(realpathSync.native(path));
      } catch {
        // Not there: the other three forms are still listed.
      }
    }
    const secrets = upstreamSecretList({
      apiKey: upstream?.apiKey,
      baseUrl: upstream?.baseUrl,
      paths,
    });
    return sanitizeUpstreamText(text, secrets);
  };
}

/** 去掉末尾的分隔符（`normalize` 后至多一个）；根目录 `/` 原样。 */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** 两个上传上限的生效值：装配没给的取缺省。 */
function uploadLimits(assembly: AssemblyDependencies | undefined): {
  maxBytes: number;
  maxFiles: number;
} {
  return {
    maxBytes: assembly?.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    maxFiles: assembly?.uploadMaxFiles ?? DEFAULT_UPLOAD_MAX_FILES,
  };
}

/**
 * The app's one workspace-snapshots service: `take`, the two removals and `restore` bound to the
 * managed snapshots directory of the state dir and to the four snapshot settings. Building it
 * touches no file; the directory belongs to the omp state layout.
 */
function snapshotService(runtime: SessionRuntime): TurnSnapshotService {
  const snapshotsRoot = ompSnapshotsDir(runtime.stateDir);
  const limits = {
    excludeNames: runtime.snapshotExcludeNames ?? DEFAULT_SNAPSHOT_SETTINGS.snapshotExcludeNames,
    maxFileBytes: runtime.snapshotMaxFileBytes ?? DEFAULT_SNAPSHOT_SETTINGS.snapshotMaxFileBytes,
    maxTotalBytes: runtime.snapshotMaxTotalBytes ?? DEFAULT_SNAPSHOT_SETTINGS.snapshotMaxTotalBytes,
    maxEntries: runtime.snapshotMaxEntries ?? DEFAULT_SNAPSHOT_SETTINGS.snapshotMaxEntries,
  };
  return {
    take: (workspaceRoot, workspaceId, userMessageId, previousMessageId) =>
      take({
        workspaceRoot,
        snapshotsRoot,
        workspaceId,
        userMessageId,
        ...(previousMessageId === undefined ? {} : { previousMessageId }),
        ...limits,
      }),
    remove: (workspaceId, messageId) => removeSnapshot({ snapshotsRoot, workspaceId, messageId }),
    removeWorkspace: (workspaceId) => removeWorkspaceSnapshots({ snapshotsRoot, workspaceId }),
    restore: (workspaceRoot, workspaceId, messageId) =>
      restore({ workspaceRoot, snapshotDir: join(snapshotsRoot, workspaceId, String(messageId)) }),
  };
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
