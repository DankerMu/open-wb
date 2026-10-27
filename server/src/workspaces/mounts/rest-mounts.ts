/**
 * workspaces/mounts/rest-mounts — the mount endpoints (s1b-workspace-mounts design D13, D14 attach side,
 * D15 temporary reject, D17; the account limits of #1789; workspace-mounts「挂载端点」;
 * http-service-skeleton「统一错误信封」identity `POST /api/workspaces/:id/mounts`). Registered by
 * `registerWorkspaces`: `GET` / `POST /api/workspaces/:id/mounts`, `DELETE
 * /api/workspaces/:id/mounts/:mountId`. All three `no-store`.
 *
 * `POST` order: unauthenticated 401 (root guard) → the workspace not the caller's (or its root path
 * occupied, `ownedRootOf`) 404 → `RCLONE_BIN` not configured 503 `mount_disabled` — these three in
 * `preParsing`, ahead of the body → content-parser 400 (parser owner, body limit 64 KiB) → `validate.ts`
 * 400 → temporary workspace 400 → the account's attaches in flight at `MOUNT_MAX_ATTACHING_PER_ACCOUNT` 409
 * `mount_limit` → its rows plus its attaches in flight at `MOUNT_MAX_PER_ACCOUNT` 409 `mount_limit` (these
 * two and the in-flight increment in one synchronous segment, no `await` between; the hold is released in
 * `finally` once `manager.attach` settles, however it settles — a client abort does not cancel it) → on the
 * workspace's chain (`before`, so limit and name never race another attach or detach):
 * `MOUNT_MAX_PER_WORKSPACE` reached 409 `mount_limit` → a `local` source unknown or
 * marked deleting 404, a read-only source with `readOnly: false` 400 → the name taken by a mount of the
 * workspace or by an entry of its root 409 `conflict` → the manager: host rule 403 `mount_host_rejected`,
 * resolution / credential file / mount point / spawn / readiness 502 `mount_failed` → the row's insert
 * transaction (`within`): a `local` source marked deleting since 404 (the store has checked it still
 * exists), then `mount.attach`; any throw there unmounts and leaves no row (a non-`HttpError` is the
 * generic 500). Only refusals from the host rule on (403 / 502) write `mount.reject`.
 *
 * `DELETE` reads no body (not a parser owner: a parser error stays the generic 500, before anything is
 * unmounted); a mount not in that workspace is 404 like an unknown one. With the feature off it still
 * works — 503 `mount_disabled` only when a lazy unmount is needed and no `fusermount3` is on PATH (the
 * manager's rule). `GET` lists any owned workspace, temporary ones (always empty) and feature off included.
 *
 * Nothing here ever carries a credential: views and audit detail are built key by key from the row or the
 * body's connection fields; refusals are the constant envelopes.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest, preParsingHookHandler } from "fastify";
import { HttpError } from "../../core/errors/index.js";
import { currentPrincipal, noStoreWorkspaceResponse, ownedRootOf } from "../rest.js";
import type { WorkspaceStore } from "../store.js";
import { deletingSources, type MountRestDependencies } from "./rest.js";
import type { MountRecord } from "./store.js";
import { type MountBody, validateMountBody } from "./validate.js";

/** A private key is at most 16 KiB of text; the rest of a body is a few hundred bytes. */
const MOUNT_BODY_LIMIT = 64 * 1024;

type Params = { id: string };

/** Whether `path` names an entry of any kind (a dangling symlink included). */
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** The connection fields of a body as `mount.reject` lists them; the rest is null. */
function connectionOf(body: MountBody) {
  if (body.backend === "local") {
    return { host: null, port: null, remotePath: null, sourceId: body.sourceId };
  }
  return { host: body.host, port: body.port ?? null, remotePath: body.remotePath, sourceId: null };
}

export function registerMounts(
  app: FastifyInstance,
  dependencies: MountRestDependencies,
  workspaces: Pick<WorkspaceStore, "rootOf">,
): void {
  const { store, manager, audit, mountMaxPerWorkspace } = dependencies;
  const { mountMaxPerAccount, mountMaxAttachingPerAccount } = dependencies;
  /** Per account, its attaches in flight (this app's, as long-lived as its manager); no key at zero. */
  const attaching = new Map<string, number>();

  /**
   * `attach` under the account's hold. Both account limits and the increment run before the first
   * `await` — the same synchronous segment as the call of `attach` — and the decrement in `finally`,
   * however `attach` settles; the key goes at zero.
   */
  const underAccountHold = async <T>(ownerId: string, attach: () => Promise<T>): Promise<T> => {
    const inFlight = attaching.get(ownerId) ?? 0;
    if (
      inFlight >= mountMaxAttachingPerAccount ||
      store.countByOwner(ownerId) + inFlight >= mountMaxPerAccount
    ) {
      throw new HttpError("mount_limit");
    }
    attaching.set(ownerId, inFlight + 1);
    try {
      return await attach();
    } finally {
      const left = (attaching.get(ownerId) ?? 1) - 1;
      if (left === 0) {
        attaching.delete(ownerId);
      } else {
        attaching.set(ownerId, left);
      }
    }
  };

  /** The caller's workspace root (missing or not), else 404. */
  const ownedRoot = (request: FastifyRequest): string => {
    const { id } = request.params as Params;
    const root = ownedRootOf(workspaces, currentPrincipal(request), id);
    if (root === null) {
      throw new HttpError("not_found");
    }
    return root;
  };
  const ownedBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    ownedRoot(request);
    done(null, payload);
  };
  const enabledBeforeParse: preParsingHookHandler = (request, _reply, payload, done) => {
    ownedRoot(request);
    if (!manager.enabled) {
      throw new HttpError("mount_disabled");
    }
    done(null, payload);
  };

  const viewOf = (record: MountRecord) => ({
    id: record.id,
    name: record.name,
    backend: record.backend,
    host: record.host,
    port: record.port,
    remotePath: record.remotePath,
    sourceId: record.sourceId,
    sourceName: record.sourceId === null ? null : (store.getSource(record.sourceId)?.name ?? null),
    readOnly: record.readOnly,
    status: manager.statusOf(record.id),
    createdAt: record.createdAt,
  });

  /** The checks on the workspace's chain, before the host rule: limit, source, name. */
  const admissible = async (workspaceId: string, root: string, body: MountBody) => {
    if (store.countByWorkspace(workspaceId) >= mountMaxPerWorkspace) {
      throw new HttpError("mount_limit");
    }
    if (body.backend === "local") {
      const source = store.getSource(body.sourceId);
      if (source === undefined || deletingSources.has(body.sourceId)) {
        throw new HttpError("not_found");
      }
      if (source.readOnly && !body.readOnly) {
        throw new HttpError("bad_request");
      }
    }
    if (
      store.list(workspaceId).some((mount) => mount.name === body.name) ||
      (await entryExists(join(root, body.name)))
    ) {
      throw new HttpError("conflict");
    }
  };

  const route = { onRequest: noStoreWorkspaceResponse };

  app.get<{ Params: Params }>("/api/workspaces/:id/mounts", route, async (request) => {
    ownedRoot(request);
    return { enabled: manager.enabled, mounts: store.list(request.params.id).map(viewOf) };
  });

  app.post<{ Params: Params }>(
    "/api/workspaces/:id/mounts",
    { ...route, preParsing: enabledBeforeParse, bodyLimit: MOUNT_BODY_LIMIT },
    async (request, reply) => {
      const actorId = currentPrincipal(request).id;
      const workspaceId = request.params.id;
      const result = validateMountBody(request.body);
      if (!result.ok) {
        throw new HttpError("bad_request");
      }
      const body = result.value;
      // D15: one-way promotion, so a workspace found formal here stays formal.
      if (store.isTemporaryWorkspace(workspaceId)) {
        throw new HttpError("bad_request");
      }
      const root = ownedRoot(request);
      let record: MountRecord;
      try {
        record = await underAccountHold(actorId, () =>
          manager.attach(
            { workspaceId, ownerId: actorId, body },
            {
              before: () => admissible(workspaceId, root, body),
              within: (row) => {
                // D14: the source DELETE's mark, taken after `before` passed; the store checked existence.
                if (row.sourceId !== null && deletingSources.has(row.sourceId)) {
                  throw new HttpError("not_found");
                }
                audit.emit({
                  kind: "mount.attach",
                  actorId,
                  workspaceId,
                  title: `挂载目录 ${row.name}`,
                  detail: {
                    mountId: row.id,
                    name: row.name,
                    backend: row.backend,
                    host: row.host,
                    port: row.port,
                    remotePath: row.remotePath,
                    sourceId: row.sourceId,
                    readOnly: row.readOnly,
                  },
                });
              },
            },
          ),
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.code === "mount_host_rejected" || error.code === "mount_failed")
        ) {
          audit.emit({
            kind: "mount.reject",
            actorId,
            workspaceId,
            title: `挂载被拒绝：${body.name}`,
            detail: {
              name: body.name,
              backend: body.backend,
              ...connectionOf(body),
              reason: error.code === "mount_host_rejected" ? "host_rejected" : "mount_failed",
            },
          });
        }
        throw error;
      }
      return reply.code(201).send(viewOf(record));
    },
  );

  // No bodyLimit and no body read: not a parser owner, a parser failure stays the generic 500.
  app.delete<{ Params: Params & { mountId: string } }>(
    "/api/workspaces/:id/mounts/:mountId",
    { ...route, preParsing: ownedBeforeParse },
    async (request, reply) => {
      const { id, mountId } = request.params;
      if (store.get(mountId)?.workspaceId !== id) {
        throw new HttpError("not_found");
      }
      const removed = await manager.detach(mountId, {
        actorId: currentPrincipal(request).id,
        reason: "user",
      });
      // Gone between the lookup and the detach (a concurrent DELETE).
      if (removed === undefined) {
        throw new HttpError("not_found");
      }
      return reply.code(204).send();
    },
  );
}
