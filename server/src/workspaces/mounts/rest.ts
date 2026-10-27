/**
 * workspaces/mounts/rest — the mount-source endpoints (s1b-workspace-mounts design D2 source part, D14;
 * workspace-mounts「挂载源端点」; http-service-skeleton「统一错误信封」identity `POST /api/mount-sources`).
 * Registered by `registerWorkspaces`: `GET` / `POST /api/mount-sources`, `DELETE /api/mount-sources/:id`.
 *
 * Order: unauthenticated 401 (root guard) → a non-admin `POST` / `DELETE` 403 `forbidden`, in route-level
 * `preParsing` ahead of the body and the id (the connectors / models pattern) → content-parser errors
 * (`POST` is a parser owner, body limit 16 KiB) → `validate.ts` 400 → the path rule 400 (`source-path.ts`,
 * also what a path the OS refuses — U+0000 — comes to) → the store's 409 `conflict` / 33rd-source 400.
 * `DELETE` reads no body and is not a parser owner: a body's parser error stays the generic 500, before
 * anything is deleted. Every answer is `Cache-Control: no-store`. `GET` is open to every account: the
 * admin view is the row `{id, name, path, readOnly, createdAt}`, everyone else gets `{id, name, readOnly}`.
 * All three work with the feature off: a source is data, and the cascade follows the manager's
 * feature-off unmount rule.
 *
 * `DELETE` (D14): unknown id 404; else (1) the source is marked deleting in `deletingSources` — the
 * mount routes (`rest-mounts.ts`) refuse a new `local` mount on a marked source, before the attach and
 * again in its insert transaction; (2) `detachSource` unmounts and deletes
 * every mount referencing it, each on its workspace's chain with its own `mount.detach`
 * (`source_deleted`, this admin); (3) one transaction deletes the source row and writes
 * `mount.source.delete` → 204. Each `DELETE` releases its hold on the mark in `finally` and the mark
 * drops with the last overlapping one: a failed cascade or transaction ends in the generic 500 with the
 * source row kept and, once no other `DELETE` of it is under way, the source usable again.
 *
 * Audit: `mount.source.create` / `mount.source.delete` in the store's `within` (same transaction),
 * actor the admin, no `workspaceId`, detail exactly `{sourceId, name, path, readOnly}`.
 */
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
} from "fastify";
import type { emit } from "../../core/audit/index.js";
import { HttpError } from "../../core/errors/index.js";
import type { MountManager } from "./manager.js";
import { acceptableSourcePath } from "./source-path.js";
import type { createMountStore, MountSourceRecord } from "./store.js";
import { validateMountSourceBody } from "./validate.js";

/** The mount-source routes' and the mount routes' (`rest-mounts.ts`) dependencies. */
export interface MountRestDependencies {
  store: ReturnType<typeof createMountStore>;
  manager: Pick<MountManager, "enabled" | "attach" | "detach" | "detachSource" | "statusOf">;
  audit: { emit(event: Parameters<typeof emit>[1]): unknown };
  isAdmin: (principal: { readonly role: string }) => boolean;
  /** The protected roots no source may overlap (design D2); the same array the manager is built with. */
  protectedRoots: readonly string[];
  /** `MOUNT_MAX_PER_WORKSPACE`: the mount routes' 409 `mount_limit` (the manager never reads it). */
  mountMaxPerWorkspace: number;
}

/** A source body is a name and a path: a few hundred bytes at most. */
const MOUNT_SOURCE_BODY_LIMIT = 16 * 1024;

/** Per source, how many `DELETE`s are under way: overlapping ones each hold the mark. */
const deleting = new Map<string, number>();
/**
 * Sources whose `DELETE` is under way (design D14 step 1): in memory only, each `DELETE` releases its
 * hold in `finally`, the mark drops with the last one.
 */
export const deletingSources: Pick<ReadonlySet<string>, "has"> = {
  has: (id) => deleting.has(id),
};

function release(id: string): void {
  const holds = (deleting.get(id) ?? 1) - 1;
  if (holds === 0) {
    deleting.delete(id);
  } else {
    deleting.set(id, holds);
  }
}

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/** The root guard has authenticated; the null branch only narrows the type. */
function principalOf(request: FastifyRequest): { readonly id: string; readonly role: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

export function registerMountSources(app: FastifyInstance, dependencies: MountRestDependencies) {
  const { store, manager, audit, isAdmin, protectedRoots } = dependencies;

  /** A non-admin write is 403 before the body is parsed and the id looked up. */
  const adminBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    if (!isAdmin(principalOf(request))) {
      throw new HttpError("forbidden");
    }
    done(null, payload);
  };
  const audited =
    (request: FastifyRequest, kind: string, verb: string) =>
    (record: MountSourceRecord): void => {
      audit.emit({
        kind,
        actorId: principalOf(request).id,
        title: `${verb}挂载源 ${record.name}`,
        detail: {
          sourceId: record.id,
          name: record.name,
          path: record.path,
          readOnly: record.readOnly,
        },
      });
    };
  const route = { onRequest: noStore };
  const admin = { ...route, preParsing: adminBeforeParse };

  app.get("/api/mount-sources", route, async (request) => {
    const records = store.listSources();
    return {
      sources: isAdmin(principalOf(request))
        ? records
        : records.map(({ id, name, readOnly }) => ({ id, name, readOnly })),
    };
  });

  app.post(
    "/api/mount-sources",
    { ...admin, bodyLimit: MOUNT_SOURCE_BODY_LIMIT },
    async (request, reply) => {
      const result = validateMountSourceBody(request.body);
      if (!result.ok) {
        throw new HttpError("bad_request");
      }
      const path = await acceptableSourcePath(result.value.path, protectedRoots);
      if (path === undefined) {
        throw new HttpError("bad_request");
      }
      const record = store.createSource(
        { ...result.value, path },
        audited(request, "mount.source.create", "登记"),
      );
      return reply.code(201).send(record);
    },
  );

  // No bodyLimit and no body read: not a parser owner, a parser failure stays the generic 500.
  app.delete<{ Params: { id: string } }>(
    "/api/mount-sources/:id",
    admin,
    async (request, reply) => {
      const { id } = request.params;
      if (store.getSource(id) === undefined) {
        throw new HttpError("not_found");
      }
      deleting.set(id, (deleting.get(id) ?? 0) + 1);
      try {
        await manager.detachSource(id, principalOf(request).id);
        const removed = store.removeSource(id, audited(request, "mount.source.delete", "删除"));
        // Gone between the lookup and the delete (a concurrent DELETE).
        if (removed === undefined) {
          throw new HttpError("not_found");
        }
      } finally {
        release(id);
      }
      return reply.code(204).send();
    },
  );
}
