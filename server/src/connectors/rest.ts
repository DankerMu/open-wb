/**
 * connectors/rest — 连接器管理端点（s1d-connectors D4 写入流水线、D5；connectors「连接器管理端点」）。四个端点：
 * `GET /api/connectors`、`POST /api/connectors`、`PUT /api/connectors?name=`、`DELETE /api/connectors?name=`。
 *
 * 次序：未认证 401（root guard）→ 非管理员的三个写路由 403 `forbidden` → `PUT` / `DELETE` 的 `name` 缺失 / 空 /
 * 多值 400 → 未知 404——这三步在路由级 `preParsing`，先于 body 解析与 body limit（专家端点 `ownedBeforeParse`
 * 的写法）→ content-parser 错误（`POST` / `PUT` 在归属集，body limit 64 KiB）→ store 的校验 400、重名 409、
 * 第 33 个 400。`DELETE` 不读 body、不在归属集：body 引起的解析错误保持 generic 500，且发生在删除之前。全部
 * 应答 `Cache-Control: no-store`。`GET` 对所有登录账号开放：管理员得管理员视图，其它角色只见启用的行、视图
 * 恰为 `{name, type, description}`。
 *
 * 写入：store 写方法自持事务；审计经它的 `within(view)` 在 COMMIT 之前同事务写入，kind `connector.create` /
 * `connector.update` / `connector.delete`，detail 恰 `{name, type}`，title 只带名称。提交之后 `await publish()`
 * （托管 `mcp.json` 的唯一发布器）再应答；发布失败经 `onPublishFailed` 恰交出一条
 * `{"event":"mcp_publish_failed"}`，原错误交给共享 handler（generic 500），行与审计已提交、不回滚。
 *
 * 凭证：`env` / `headers` 的值不进任何应答（视图只有键名）、审计与记录。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { ConnectorView, createConnectorStore } from "./store.js";

type ConnectorStore = Pick<
  ReturnType<typeof createConnectorStore>,
  "list" | "get" | "create" | "update" | "remove"
>;

interface AuditEvent {
  kind: string;
  actorId: string;
  title: string;
  detail: { name: string; type: ConnectorView["type"] };
}

/** 发布失败的那一行（只有 `event` 一个键）。 */
export interface McpPublishFailedRecord {
  event: "mcp_publish_failed";
}

export interface ConnectorRestDependencies {
  db: DatabaseSync;
  store: ConnectorStore;
  /** 托管 `mcp.json` 发布（单飞，唯一实例）；未装配时为空操作。 */
  publish: () => Promise<void>;
  /** `core/audit` 的 `emit`。 */
  emit: (db: DatabaseSync, event: AuditEvent) => number;
  isAdmin: (principal: { readonly role: string }) => boolean;
  onPublishFailed?: (record: McpPublishFailedRecord) => void;
}

/** D3 的合法 body 通常只有几 KiB；上限附近（32 个 4096 码点的 `env` 值）会超过它，得 content-parser 400。 */
const CONNECTOR_BODY_LIMIT = 64 * 1024;

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/** 查询参数 `name`：Fastify 已解码；缺失、空串与多值（数组）一律 400。 */
function nameOf(request: FastifyRequest): string {
  const { name } = request.query as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) {
    throw new HttpError("bad_request");
  }
  return name;
}

/** root guard 已认证；这里的 null 分支只为类型收窄。 */
function principalOf(request: FastifyRequest): { readonly id: string; readonly role: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

export function registerConnectors(
  app: FastifyInstance,
  dependencies: ConnectorRestDependencies,
): void {
  const { db, store, publish, emit, isAdmin, onPublishFailed } = dependencies;

  const adminOnly = (request: FastifyRequest): void => {
    if (!isAdmin(principalOf(request))) {
      throw new HttpError("forbidden");
    }
  };
  /** `POST`：非管理员 403，先于 body 解析。 */
  const adminBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    adminOnly(request);
    done(null, payload);
  };
  /** `PUT` / `DELETE`：非管理员 403 → `name` 400 → 未知 404，都在 body 解析之前。 */
  const namedBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    adminOnly(request);
    if (store.get(nameOf(request)) === undefined) {
      throw new HttpError("not_found");
    }
    done(null, payload);
  };
  const audited =
    (request: FastifyRequest, kind: string, verb: string) =>
    (view: ConnectorView): void => {
      emit(db, {
        kind,
        actorId: principalOf(request).id,
        title: `${verb}连接器 ${view.name}`,
        detail: { name: view.name, type: view.type },
      });
    };
  /** 写入已提交：等发布落定；发布失败恰交出一条记录并把原错误交给共享 handler。 */
  const published = async <T>(value: T): Promise<T> => {
    try {
      await publish();
    } catch (error) {
      onPublishFailed?.({ event: "mcp_publish_failed" });
      throw error;
    }
    return value;
  };
  const route = { onRequest: noStore };
  const named = { ...route, preParsing: namedBeforeParse };

  app.get("/api/connectors", route, async (request) => {
    const views = store.list();
    return {
      connectors: isAdmin(principalOf(request))
        ? views
        : views
            .filter((view) => view.enabled)
            .map(({ name, type, description }) => ({ name, type, description })),
    };
  });

  app.post(
    "/api/connectors",
    { ...route, preParsing: adminBeforeParse, bodyLimit: CONNECTOR_BODY_LIMIT },
    async (request, reply) => {
      const view = store.create(request.body, audited(request, "connector.create", "登记"));
      return reply.code(201).send(await published(view));
    },
  );

  app.put("/api/connectors", { ...named, bodyLimit: CONNECTOR_BODY_LIMIT }, async (request) => {
    const view = store.update(
      nameOf(request),
      request.body,
      audited(request, "connector.update", "修改"),
    );
    // The row vanished between the pre-parse check and the write (a concurrent delete).
    if (view === undefined) {
      throw new HttpError("not_found");
    }
    return published(view);
  });

  // No bodyLimit and no body read: not a parser owner, a parser failure stays the generic 500.
  app.delete("/api/connectors", named, async (request, reply) => {
    const view = store.remove(nameOf(request), audited(request, "connector.delete", "删除"));
    if (view === undefined) {
      throw new HttpError("not_found");
    }
    await published(undefined);
    return reply.code(204).send();
  });
}
