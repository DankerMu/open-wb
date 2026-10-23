/**
 * experts/rest — 专家管理端点（s1d-experts-skills D5；experts「专家管理端点」「专家校验与可见性」）。四个端点：
 * `GET /api/experts`、`POST /api/experts`、`PUT /api/experts?id=`、`DELETE /api/experts?id=`。
 *
 * 次序：未认证 401（root guard）→ `PUT` / `DELETE` 的 `id` 缺失 / 空 / 多值 400 → `id` 为四位内置专家之一
 * 403 `forbidden`（`builtin:` 前缀但不在清单里的 id 走 404）→ 对调用者不可见（他人的或不存在）404——这三步在
 * 路由级 `preParsing`，先于 body 解析与 body limit（同 `sessions/rest-metadata.ts` 的 `authorizeOwnedBeforeParse`）
 * → content-parser 错误（`POST` / `PUT` 在归属集，body limit 64 KiB）→ 键集与字段 400。`DELETE` 不读 body、
 * 不在归属集：body 引起的解析错误保持 generic 500，且发生在删除之前。全部应答 `Cache-Control: no-store`。
 *
 * 写入：store 写方法自持事务（不可嵌套，这里不包外层事务）；审计经它的 `within(expert)` 在 COMMIT 之前同事务写入，
 * kind `expert.create` / `expert.update` / `expert.delete`，detail 恰 `{expertId, name}`，title 只带名称——提示词
 * 不进审计行的任何一列。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import { BUILTIN_EXPERTS } from "./builtin.js";
import type { createExpertStore, Expert } from "./store.js";

type ExpertStore = Pick<
  ReturnType<typeof createExpertStore>,
  "list" | "get" | "create" | "update" | "remove"
>;

interface AuditEvent {
  kind: string;
  actorId: string;
  title: string;
  detail: { expertId: string; name: string };
}

export interface ExpertRestDependencies {
  db: DatabaseSync;
  store: ExpertStore;
  /** `core/audit` 的 `emit`。 */
  emit: (db: DatabaseSync, event: AuditEvent) => number;
}

/** 提示词至多 8000 码点：CJK 文本约 24 KiB，16 KiB 不够。 */
const EXPERT_BODY_LIMIT = 64 * 1024;
const BODY_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "category",
  "tags",
  "prompt",
  "skills",
]);

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/** 视图恒为规格八键。 */
function toView(expert: Expert) {
  const { id, name, description, category, tags, prompt, skills, builtin } = expert;
  return { id, name, description, category, tags, prompt, skills, builtin };
}

/** 查询参数 `id`：Fastify 已解码；缺失、空串与多值（数组）一律 400。 */
function idOf(request: FastifyRequest): string {
  const { id } = request.query as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpError("bad_request");
  }
  return id;
}

/** root guard 已认证；这里的 null 分支只为类型收窄。 */
function principalOf(request: FastifyRequest): { readonly id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/** 键集严格：普通 JSON 对象且键 ⊆ 六个 body 键；字段规则归 store。 */
function checkedBody(body: unknown): Record<string, unknown> {
  if (
    typeof body !== "object" ||
    body === null ||
    Object.getPrototypeOf(body) !== Object.prototype ||
    Object.keys(body).some((key) => !BODY_KEYS.has(key))
  ) {
    throw new HttpError("bad_request");
  }
  return body as Record<string, unknown>;
}

export function registerExperts(app: FastifyInstance, dependencies: ExpertRestDependencies): void {
  const { db, store, emit } = dependencies;

  /** `id` 400 → 内置 403 → 不可见 404，都在 body 解析之前。 */
  const ownedBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    const id = idOf(request);
    if (BUILTIN_EXPERTS.some((expert) => expert.id === id)) {
      throw new HttpError("forbidden");
    }
    if (store.get(principalOf(request).id, id) === undefined) {
      throw new HttpError("not_found");
    }
    done(null, payload);
  };
  const audited =
    (request: FastifyRequest, kind: string, verb: string) =>
    (expert: Expert): void => {
      emit(db, {
        kind,
        actorId: principalOf(request).id,
        title: `${verb}专家 ${expert.name}`,
        detail: { expertId: expert.id, name: expert.name },
      });
    };
  const route = { onRequest: noStore };
  const owned = { ...route, preParsing: ownedBeforeParse };

  app.get("/api/experts", route, async (request) => ({
    experts: store.list(principalOf(request).id).map(toView),
  }));

  app.post("/api/experts", { ...route, bodyLimit: EXPERT_BODY_LIMIT }, async (request, reply) => {
    const expert = store.create(
      principalOf(request).id,
      checkedBody(request.body),
      audited(request, "expert.create", "新建"),
    );
    return reply.code(201).send(toView(expert));
  });

  app.put("/api/experts", { ...owned, bodyLimit: EXPERT_BODY_LIMIT }, async (request) => {
    const expert = store.update(
      principalOf(request).id,
      idOf(request),
      checkedBody(request.body),
      audited(request, "expert.update", "修改"),
    );
    // The row vanished between the pre-parse check and the write (a concurrent delete).
    if (expert === undefined) {
      throw new HttpError("not_found");
    }
    return toView(expert);
  });

  // No bodyLimit and no body read: not a parser owner, a parser failure stays the generic 500.
  app.delete("/api/experts", owned, async (request, reply) => {
    const expert = store.remove(
      principalOf(request).id,
      idOf(request),
      audited(request, "expert.delete", "删除"),
    );
    if (expert === undefined) {
      throw new HttpError("not_found");
    }
    return reply.code(204).send();
  });
}
