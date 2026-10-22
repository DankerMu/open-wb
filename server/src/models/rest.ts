/**
 * models/rest — 模型注册表的管理端点（s1d-model-registry D7、D8、D10、D11、D12；model-registry「模型管理端点」
 * 「变更即发布」「探活」）。六个端点：`GET /api/models`、`POST /api/models`、`PUT /api/models?id=`、
 * `DELETE /api/models?id=`、`POST /api/models/default?id=`、`POST /api/models/probe?id=`。
 *
 * 次序：未认证 401（root guard）→ 非管理员 403（路由级 `preParsing`，先于 body 解析与 id 查找）→ body 解析
 *（两个带 body 的路由与 bodyless 的 `default` / `probe` 都在 content-parser 归属集）→ `id` 缺失 / 空 / 多值 400 →
 * store 的校验与查找（400 / 404 / 409）。全部应答 `Cache-Control: no-store`。
 *
 * 探活：行不存在即 404、不发请求；上游取自注册表快照的 `lookup`（没有即 `未配置上游`、不发请求）；同一 id 的探活
 * 按 Promise 链串行；结果经 `recordProbe` 写三列，审计 `model.probe`（detail 恰 `{modelId, status}`）在它的
 * `within` 里同事务写入；在途期间行被删 → `recordProbe` 404，结果丢弃、无审计。不刷新快照、不发布。
 *
 * 写入流水线：store 写方法自持事务，审计经它的 `within` 在 COMMIT 之前同事务写入 → `registry.refresh()` →
 * `await publish()` → 应答。发布失败：经 `onPublishFailed` 恰交出一条 `{"event":"model_publish_failed"}`，
 * 原错误交给共享 handler（generic 500，不是典型信封）；行与审计已提交、不回滚。`default` 对已是缺省的行
 * 不审计、不发布。视图不含密钥；`upstream.baseUrl` 是 `store.viewBaseUrl` 去掉 userinfo 的形式（env 种子行原样入表，
 * 可能带 `user:pass@`）；`PUT` 送回这个形式且不带 `apiKey` 时 store 沿用已存地址，`upstreamChanged` 随之为 false。
 * 审计 detail 只含 `modelId`、`name` 与 `upstreamChanged`——没有 base URL 与密钥。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import { type ProbeResult, probeUpstream } from "./probe.js";
import type { ModelPublishFailedRecord } from "./publish.js";
import { type createModelStore, type ModelRow, viewBaseUrl } from "./store.js";

type ModelStore = Pick<
  ReturnType<typeof createModelStore>,
  "list" | "get" | "create" | "update" | "remove" | "setDefault" | "recordProbe"
>;

interface AuditEvent {
  kind: string;
  actorId: string;
  title: string;
  detail:
    | { modelId: string; name: string; upstreamChanged?: boolean }
    | { modelId: string; status: ProbeResult["status"] };
}

/** 注册表快照的三个读写（结构与 model-proxy 的 `ModelRegistry` 一致；本模块不导入 model-proxy）。 */
interface Registry {
  refresh(): void;
  lookup(id: string): { upstream?: { baseUrl: string; apiKey: string } } | undefined;
  secrets(): readonly string[];
}

export interface ModelRestDependencies {
  db: DatabaseSync;
  store: ModelStore;
  /** 每次写入提交之后从表重读快照（静态接缝下为空操作）；探活读 `lookup` 与 `secrets`。 */
  registry: Registry;
  /** 托管文件发布（单飞）；未装配时为空操作。 */
  publish: () => Promise<void>;
  /** `core/audit` 的 `emit`。 */
  emit: (db: DatabaseSync, event: AuditEvent) => number;
  isAdmin: (principal: { readonly role: string }) => boolean;
  onPublishFailed?: (record: ModelPublishFailedRecord) => void;
  /** 探活的两个期限；省略时取 `probe.ts` 的缺省（生产装配不传）。 */
  probeDeadlines?: { connectDeadlineMs?: number; totalDeadlineMs?: number };
}

const NO_UPSTREAM: ProbeResult = { status: "failed", message: "未配置上游" };

/** 最长的合法 body 也只有几百字节（`id` ≤128 字节、`name` ≤64 码点、六档 `efforts`、地址与密钥）。 */
const MODEL_BODY_LIMIT = 16 * 1024;
/** Fastify 不接受 0：取最小合法值，显式的 no-body 校验负责「任意 body 即 400」。 */
const BODYLESS_BODY_LIMIT = 1;

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/** 视图键集恒为规格十键：`createdAt` 不外露，上游只给去掉 userinfo 的地址与 `hasApiKey`。 */
function toView(row: ModelRow) {
  const { id, name, reasoning, vision, maxTokens, efforts, upstream, isDefault, probe } = row;
  return {
    id,
    name,
    reasoning,
    vision,
    maxTokens,
    efforts,
    upstream:
      upstream === null
        ? null
        : { baseUrl: viewBaseUrl(upstream.baseUrl), hasApiKey: true as const },
    isDefault,
    probe,
    updatedAt: row.updatedAt,
  };
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
function principalOf(request: FastifyRequest): { readonly id: string; readonly role: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/** `PUT` body 是否给出了 `upstream.apiKey`（只在 store 校验通过之后的 `within` 里调用：body 已是对象）。 */
function givesApiKey(body: unknown): boolean {
  const upstream = (body as { upstream?: unknown }).upstream;
  return typeof upstream === "object" && upstream !== null && "apiKey" in upstream;
}

/** D12：`upstream` null 与非 null 互换，或 base URL 不同，或给出了 `apiKey`。 */
function upstreamChanged(before: ModelRow | null, after: ModelRow, body: unknown): boolean {
  return before?.upstream?.baseUrl !== after.upstream?.baseUrl || givesApiKey(body);
}

export function registerModels(app: FastifyInstance, dependencies: ModelRestDependencies): void {
  const { db, store, registry, publish, emit, isAdmin, onPublishFailed, probeDeadlines } =
    dependencies;
  const serial = perIdChain();

  /** 路由级：root guard 已认证，这里只判角色——先于 body 解析与 id 查找。 */
  const adminOnly: preParsingHookHandler = (request, _reply, payload, done) => {
    if (!isAdmin(principalOf(request))) {
      throw new HttpError("forbidden");
    }
    done(null, payload);
  };
  const audit = (
    request: FastifyRequest,
    kind: string,
    title: string,
    detail: AuditEvent["detail"],
  ) => emit(db, { kind, actorId: principalOf(request).id, title, detail });
  /** 写入已提交：刷新快照，再等发布落定；发布失败恰交出一条记录并把原错误交给共享 handler。 */
  const published = async <T>(value: T): Promise<T> => {
    registry.refresh();
    try {
      await publish();
    } catch (error) {
      onPublishFailed?.({ event: "model_publish_failed" });
      throw error;
    }
    return value;
  };
  const route = { onRequest: noStore, preParsing: adminOnly };
  const withBody = { ...route, bodyLimit: MODEL_BODY_LIMIT };
  const bodyless = { ...route, bodyLimit: BODYLESS_BODY_LIMIT };
  const noBody = (request: FastifyRequest): void => {
    if (request.body !== undefined) {
      throw new HttpError("bad_request");
    }
  };

  app.get("/api/models", route, async () => ({ models: store.list().map(toView) }));

  app.post("/api/models", withBody, async (request, reply) => {
    const row = store.create(request.body, (created) => {
      audit(request, "model.create", `登记模型 ${created.name}`, {
        modelId: created.id,
        name: created.name,
        upstreamChanged: created.upstream !== null,
      });
    });
    return reply.code(201).send(toView(await published(row)));
  });

  app.put("/api/models", withBody, async (request) => {
    const id = idOf(request);
    // 与写入同一段同步代码（其间没有 await）；未知 id 由 store 在校验 body 之后答 404。
    const before = store.get(id);
    const row = store.update(id, request.body, (updated) => {
      audit(request, "model.update", `修改模型 ${updated.name}`, {
        modelId: updated.id,
        name: updated.name,
        upstreamChanged: upstreamChanged(before ?? null, updated, request.body),
      });
    });
    return toView(await published(row));
  });

  app.delete("/api/models", route, async (request, reply) => {
    store.remove(idOf(request), (removed) => {
      audit(request, "model.delete", `删除模型 ${removed.name}`, {
        modelId: removed.id,
        name: removed.name,
      });
    });
    await published(undefined);
    return reply.code(204).send();
  });

  app.post("/api/models/default", bodyless, async (request) => {
    noBody(request);
    const { row, changed } = store.setDefault(idOf(request), (target) => {
      audit(request, "model.default", `设为缺省模型 ${target.name}`, {
        modelId: target.id,
        name: target.name,
      });
    });
    return toView(changed ? await published(row) : row);
  });

  app.post("/api/models/probe", bodyless, async (request) => {
    noBody(request);
    const id = idOf(request);
    if (store.get(id) === undefined) {
      throw new HttpError("not_found");
    }
    const upstream = registry.lookup(id)?.upstream;
    const row = await serial(id, async () => {
      const result =
        upstream === undefined
          ? NO_UPSTREAM
          : await probeUpstream(upstream, { ...probeDeadlines, secrets: registry.secrets() });
      // 在途期间行被删：`changes === 0` 先于 `within` 抛 404，审计不写。
      return store.recordProbe(id, { ...result, at: Date.now() }, (probed) => {
        audit(request, "model.probe", `探活模型 ${probed.name}`, {
          modelId: probed.id,
          status: result.status,
        });
      });
    });
    return toView(row);
  });
}

/** 按 id 串行：每个 id 一条 Promise 链，前一个无论成败都轮到下一个；链尾结算时若仍是自己就删掉条目。 */
function perIdChain() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) {
        tails.delete(id);
      }
    });
    return run;
  };
}
