/**
 * kb/rest：知识库的路由（s2a-kb-ragflow D5；ragflow-backend「知识库状态端点」「知识库可用性」）。本组只有
 * `GET /api/kb/status`，以及 `/api/kb/*` 的关闭判定。
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
 */
import type { FastifyInstance, onRequestHookHandler, preParsingHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { createRagflowClient } from "./ragflow-client.js";
import type { createKbStore } from "./store.js";

/** 钉住的 RAGFlow 版本（D5）：升级是一次代码变更，要重跑实测与 `make smoke-kb`。 */
const PINNED_VERSION = "v1.0.0-rc2";
const KB_ROUTE_PREFIX = "/api/kb/";
const STATUS_ROUTE = "/api/kb/status";

interface KbRestDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "settings">;
  client: Pick<ReturnType<typeof createRagflowClient>, "version">;
  uploadMaxBytes: number;
  uploadMaxFiles: number;
  onVersionMismatch: () => void;
}

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
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
}
