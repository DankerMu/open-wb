/**
 * kb/rest：知识库的路由（s2a-kb-ragflow D5、D7；ragflow-backend「知识库状态端点」「知识库可用性」「知识库模型设置」）。
 * `GET /api/kb/status`、三条设置路由，以及 `/api/kb/*` 的关闭判定。
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
 * body 解析（`PUT` 与 bodyless 的 `POST` 都在 content-parser 归属集）→ 设置模块的校验。业务都在 `kb/settings.ts`。
 * 路由在知识库关闭时同样注册：不注册就是 catch-all 的 404，不是 503；处理函数在关闭时走不到。
 */
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import { isAdmin } from "../core/roles.js";
import type { createRagflowClient } from "./ragflow-client.js";
import type { createKbSettings } from "./settings.js";
import type { createKbStore } from "./store.js";

/** 钉住的 RAGFlow 版本（D5）：升级是一次代码变更，要重跑实测与 `make smoke-kb`。 */
const PINNED_VERSION = "v1.0.0-rc2";
const KB_ROUTE_PREFIX = "/api/kb/";
const STATUS_ROUTE = "/api/kb/status";
const SETTINGS_ROUTE = "/api/kb/settings";
const SETTINGS_PROBE_ROUTE = "/api/kb/settings/probe";
/** 最长的合法 body 也只有几百字节，同 `models/rest.ts`。 */
const SETTINGS_BODY_LIMIT = 16 * 1024;
/** Fastify 不接受 0：取最小合法值，显式的 no-body 校验负责「任意 body 即 400」。 */
const BODYLESS_BODY_LIMIT = 1;

interface KbRestDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "settings">;
  client: Pick<ReturnType<typeof createRagflowClient>, "version">;
  settings: ReturnType<typeof createKbSettings>;
  uploadMaxBytes: number;
  uploadMaxFiles: number;
  onVersionMismatch: () => void;
}

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
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
  const settings = (): KbRestDependencies["settings"] => {
    if (dependencies === undefined) {
      throw new HttpError("kb_disabled");
    }
    return dependencies.settings;
  };
  const admin = { onRequest: noStore, preParsing: adminOnly };

  app.get(SETTINGS_ROUTE, admin, () => settings().view());

  app.put(SETTINGS_ROUTE, { ...admin, bodyLimit: SETTINGS_BODY_LIMIT }, (request) =>
    settings().save(request.body, principalOf(request).id),
  );

  app.post(SETTINGS_PROBE_ROUTE, { ...admin, bodyLimit: BODYLESS_BODY_LIMIT }, (request) => {
    if (request.body !== undefined) {
      throw new HttpError("bad_request");
    }
    return settings().probe(principalOf(request).id);
  });
}
