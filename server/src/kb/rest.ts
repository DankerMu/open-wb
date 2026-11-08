/**
 * kb/rest：知识库的路由（s2a-kb-ragflow D5、D7、D8、D9；ragflow-backend「知识库状态端点」「知识库可用性」「知识库模型设置」
 * 「嵌入模型更换与全量重建」，knowledge-bases「知识库端点」）。`GET /api/kb/status`、四条设置路由、建库列表删库三条路由，以及
 * `/api/kb/*` 的关闭判定。
 *
 * 关闭判定是 root `preParsing` 钩子，只在知识库关闭时安装。root 钩子按添加次序运行，且都先于路由级钩子，所以
 * 判定次序是：cookie guard 的 401（`http/guard.ts`，在 `registerAuth` 之后添加）→ 503 `kb_disabled` → 路由级的管理员
 * 403 → body 解析。身份取 Fastify 实际匹配到的路由模板，不看原始 URL，同 `http/guard.ts`：`GET /api/kb/status`
 * 不受判定（`HEAD` 同模板）；没有注册的 `/api/kb/…` 匹配的是 `/api/*`，仍是 catch-all 的 404。后续各组的路由注册在
 * 这个前缀下即受判定，不用逐条声明。
 *
 * 状态端点对任何已登录用户开放：未登录 401 由 cookie guard 给出，路由级的 `onRequest` 先于它落下 no-store。开启时
 * 每次请求一次版本接口；可达而版本串不符才写 `kb_version_mismatch`，不可达不写。两个就绪位读本地设置，所以先读：
 * 版本请求至多等 5 s，其间 app 可能开始关闭。
 *
 * 设置路由管理员专用：次序同 `models/rest.ts`，未登录 401（root guard）→ 关闭时 503 → 非管理员 403（路由级 `preParsing`）→
 * body 解析（`PUT` 与 bodyless 的两条 `POST` 都在 content-parser 归属集）→ 设置模块的校验。业务都在 `kb/settings.ts`。探活与
 * 重试重建（`POST /api/kb/settings/rebuild`）都是 bodyless：任意 body（含 `{}`）400。探活读查询参数 `target`（D7）：缺省或
 * `embedding` 探嵌入，`rerank` 探重排，按原值精确匹配，其它取值、空值与重复 400；先判 body 再判 `target`，非法的不进探活链。
 * 其它查询键忽略。重试不读 query。
 * 路由在知识库关闭时同样注册：不注册就是 catch-all 的 404，不是 503；处理函数在关闭时走不到。
 *
 * 知识库路由对任何已登录用户开放，只操作自己的库：`POST` 在 content-parser 归属集，业务都在 `kb/bases.ts`。`DELETE` 不读
 * body、不在归属集（同 `connectors/rest.ts`）。带 `:id` 的路由都在路由级 `preParsing` 判定所有权，所以别人的或不存在的 id
 * 带坏 body 也是 404。
 *
 * `POST …/documents` 的业务在 `kb/documents.ts`；请求合法且本地写入没有失败即 201，被拒的条目在应答的 `rejected` 里。
 * `GET …/documents` 不读 body、不在归属集，业务同在 `kb/documents.ts`。`DELETE …/documents?doc=<文档 id>`（移出）同删库的写法：
 * 不读 body、不在归属集，成功 204，业务同在 `kb/documents.ts`。`POST …/documents/reingest?doc=<文档 id>`（重新入库）同探活的写法：
 * bodyless，在归属集，任意 body（含 `{}`）都是 400，所有权判定先于它；成功 200 `DocumentView`。
 *
 * `POST …/uploads` 同 `POST /api/workspaces/:id/uploads` 的写法：独立 scope，只认 `application/octet-stream`，请求流原样交出，
 * 没有框架的 body 上限，别的媒体类型是 parser 错误（归属集，400）。所有权判定先于这一切，一个字节都不读。失败的上传一律关
 * 连接：Node 否则会在 keep-alive 上读完并丢弃剩下的请求体。业务都在 `kb/uploads.ts`。
 *
 * `POST …/retrieval`（检索测试，s2b-kb-retrieval D4）：在归属集，body limit 16 KiB，所有权判定先于 body 解析；body 校验、
 * `state`、参数写回与检索都在 `kb/retrieval.ts`，成功 200 `{hits, retrieval}`。
 */
import type {
  FastifyInstance,
  FastifyRequest,
  onErrorHookHandler,
  onRequestHookHandler,
  preParsingHookHandler,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import { isAdmin } from "../core/roles.js";
import type { createKbBases } from "./bases.js";
import type { createKbDocuments } from "./documents.js";
import type { createRagflowClient } from "./ragflow-client.js";
import type { createKbRetrieval } from "./retrieval.js";
import type { createKbSettings } from "./settings.js";
import type { createKbStore } from "./store.js";
import type { createKbUploads } from "./uploads.js";

/** 钉住的 RAGFlow 版本（D5）：升级是一次代码变更，要重跑实测与 `make smoke-kb`。 */
const PINNED_VERSION = "v1.0.0-rc2";
const KB_ROUTE_PREFIX = "/api/kb/";
const STATUS_ROUTE = "/api/kb/status";
const SETTINGS_ROUTE = "/api/kb/settings";
const SETTINGS_PROBE_ROUTE = "/api/kb/settings/probe";
const SETTINGS_REBUILD_ROUTE = "/api/kb/settings/rebuild";
const BASES_ROUTE = "/api/kb/bases";
const BASE_ROUTE = "/api/kb/bases/:id";
const DOCUMENTS_ROUTE = "/api/kb/bases/:id/documents";
const REINGEST_ROUTE = "/api/kb/bases/:id/documents/reingest";
const UPLOADS_ROUTE = "/api/kb/bases/:id/uploads";
const RETRIEVAL_ROUTE = "/api/kb/bases/:id/retrieval";
const UPLOAD_MEDIA_TYPE = "application/octet-stream";
/** 最长的合法 body 也只有几百字节，同 `models/rest.ts`。 */
const SETTINGS_BODY_LIMIT = 16 * 1024;
const BASE_BODY_LIMIT = 16 * 1024;
/** 问句至多 1000 码点：每码点经 JSON 转义也不过十几字节。 */
const RETRIEVAL_BODY_LIMIT = 16 * 1024;
/** 条数（`KB_UPLOAD_MAX_FILES`）与单条的 4096 字节由 `documents.ts` 判定，这里只拦明显的超长：缺省 10 条时合法 body 经 JSON 转义也不到 256 KiB。 */
const DOCUMENTS_BODY_LIMIT = 1024 * 1024;
/** Fastify 不接受 0：取最小合法值，显式的 no-body 校验负责「任意 body 即 400」。 */
const BODYLESS_BODY_LIMIT = 1;

interface KbRestDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "settings">;
  client: Pick<ReturnType<typeof createRagflowClient>, "version">;
  settings: ReturnType<typeof createKbSettings>;
  bases: ReturnType<typeof createKbBases>;
  documents: ReturnType<typeof createKbDocuments>;
  uploads: ReturnType<typeof createKbUploads>;
  retrieval: ReturnType<typeof createKbRetrieval>;
  uploadMaxBytes: number;
  uploadMaxFiles: number;
  onVersionMismatch: () => void;
}

type BaseParams = { Params: { id: string } };

type BasePreParsing = preParsingHookHandler<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  BaseParams
>;

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

const closeConnectionOnError: onErrorHookHandler = (_request, reply, _error, done) => {
  reply.header("Connection", "close");
  done();
};

/** root guard 已认证；这里的 null 分支只为类型收窄。 */
function principalOf(request: FastifyRequest): { readonly id: string; readonly role: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/** 查询参数 `target`：Fastify 已解码；`?target` 与 `?target=` 都是空串，重复是数组，同 `models/rest.ts` 的 `idOf`。 */
function probeTargetOf(request: FastifyRequest): "embedding" | "rerank" {
  const { target } = request.query as Record<string, unknown>;
  if (target === undefined) {
    return "embedding";
  }
  if (target !== "embedding" && target !== "rerank") {
    throw new HttpError("bad_request");
  }
  return target;
}

const adminOnly: preParsingHookHandler = (request, _reply, payload, done) => {
  if (!isAdmin(principalOf(request))) {
    throw new HttpError("forbidden");
  }
  done(null, payload);
};

const rejectWhileDisabled: preParsingHookHandler = (request, reply, payload, done) => {
  const route = request.routeOptions.url;
  if (route?.startsWith(KB_ROUTE_PREFIX) === true && route !== STATUS_ROUTE) {
    reply.header("Cache-Control", "no-store");
    throw new HttpError("kb_disabled");
  }
  done(null, payload);
};

async function statusOf(dependencies: KbRestDependencies) {
  const { store, client, uploadMaxBytes, uploadMaxFiles } = dependencies;
  const { embedding, chatModelId } = store.settings();
  const version = await client.version();
  const reachable = version.kind === "ok";
  const available = reachable && version.value === PINNED_VERSION;
  if (reachable && !available) {
    dependencies.onVersionMismatch();
  }
  return {
    enabled: true,
    available,
    embeddingReady: embedding !== null,
    compileReady: chatModelId !== null,
    uploadMaxBytes,
    uploadMaxFiles,
  };
}

/** `dependencies` 为 `undefined`：知识库关闭。 */
export function registerKbRoutes(
  app: FastifyInstance,
  dependencies: KbRestDependencies | undefined,
): void {
  if (dependencies === undefined) {
    app.addHook("preParsing", rejectWhileDisabled);
  }
  app.get(STATUS_ROUTE, { onRequest: noStore }, () =>
    dependencies === undefined ? { enabled: false } : statusOf(dependencies),
  );

  /** 关闭时 root 钩子已答 503，走到这里就是开启的。 */
  const enabled = (): KbRestDependencies => {
    if (dependencies === undefined) {
      throw new HttpError("kb_disabled");
    }
    return dependencies;
  };
  const settings = (): KbRestDependencies["settings"] => enabled().settings;
  const bases = (): KbRestDependencies["bases"] => enabled().bases;
  const admin = { onRequest: noStore, preParsing: adminOnly };
  /** 先于 body 解析（knowledge-bases「知识库端点」）。 */
  const ownedBase: BasePreParsing = (request, _reply, payload, done) => {
    bases().assertOwned(request.params.id, principalOf(request).id);
    done(null, payload);
  };

  app.get(SETTINGS_ROUTE, admin, () => settings().view());

  app.put(SETTINGS_ROUTE, { ...admin, bodyLimit: SETTINGS_BODY_LIMIT }, (request) =>
    settings().save(request.body, principalOf(request).id),
  );

  for (const [url, run] of [
    [
      SETTINGS_PROBE_ROUTE,
      (request: FastifyRequest) =>
        settings().probe(principalOf(request).id, probeTargetOf(request)),
    ],
    [
      SETTINGS_REBUILD_ROUTE,
      (request: FastifyRequest) => settings().retry(principalOf(request).id),
    ],
  ] as const) {
    app.post(url, { ...admin, bodyLimit: BODYLESS_BODY_LIMIT }, (request) => {
      if (request.body !== undefined) {
        throw new HttpError("bad_request");
      }
      return run(request);
    });
  }

  app.get(BASES_ROUTE, { onRequest: noStore }, async (request) => ({
    bases: await bases().list(principalOf(request).id),
  }));

  app.post(
    BASES_ROUTE,
    { onRequest: noStore, bodyLimit: BASE_BODY_LIMIT },
    async (request, reply) => {
      const view = await bases().create(request.body, principalOf(request).id);
      return reply.code(201).send(view);
    },
  );

  app.delete<BaseParams>(
    BASE_ROUTE,
    { onRequest: noStore, preParsing: ownedBase },
    async (request, reply) => {
      await bases().remove(request.params.id, principalOf(request).id);
      return reply.code(204).send();
    },
  );

  app.get<BaseParams>(
    DOCUMENTS_ROUTE,
    { onRequest: noStore, preParsing: ownedBase },
    async (request) => ({
      documents: await enabled().documents.list(request.params.id, principalOf(request).id),
    }),
  );

  app.post<BaseParams>(
    DOCUMENTS_ROUTE,
    { onRequest: noStore, preParsing: ownedBase, bodyLimit: DOCUMENTS_BODY_LIMIT },
    async (request, reply) => {
      const { id } = request.params;
      const result = await enabled().documents.ingest(id, request.body, principalOf(request).id);
      return reply.code(201).send(result);
    },
  );

  app.delete<BaseParams>(
    DOCUMENTS_ROUTE,
    { onRequest: noStore, preParsing: ownedBase },
    async (request, reply) => {
      const { id } = request.params;
      await enabled().documents.remove(id, request.query, principalOf(request).id);
      return reply.code(204).send();
    },
  );

  app.post<BaseParams>(
    REINGEST_ROUTE,
    { onRequest: noStore, preParsing: ownedBase, bodyLimit: BODYLESS_BODY_LIMIT },
    (request) => {
      if (request.body !== undefined) {
        throw new HttpError("bad_request");
      }
      const { id } = request.params;
      return enabled().documents.reingest(id, request.query, principalOf(request).id);
    },
  );

  app.post<BaseParams>(
    RETRIEVAL_ROUTE,
    { onRequest: noStore, preParsing: ownedBase, bodyLimit: RETRIEVAL_BODY_LIMIT },
    (request) => enabled().retrieval.test(request.params.id, request.body, principalOf(request).id),
  );

  app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(UPLOAD_MEDIA_TYPE, (_request, payload, complete) => {
      complete(null, payload);
    });
    scope.post<BaseParams>(
      UPLOADS_ROUTE,
      { onError: closeConnectionOnError, onRequest: noStore, preParsing: ownedBase },
      async (request, reply) => {
        const { id } = request.params;
        const view = await enabled().uploads.upload(id, request, principalOf(request).id);
        return reply.code(201).send(view);
      },
    );
    done();
  });
}
