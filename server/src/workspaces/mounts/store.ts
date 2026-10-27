/**
 * workspaces/mounts/store — the mount and mount-source rows of migration 049 (s1b-workspace-mounts design
 * D1; workspace-mounts「迁移 049 挂载 schema」, the store part of「挂载源端点」). Pure DB, `node:sqlite` sync.
 *
 * Inputs are `validate.ts`'s outputs — the only value rules: `create` takes a `MountBody` and keeps only
 * its connection fields (`name, backend, host, port, remotePath, sourceId, readOnly`); username,
 * password, private key and domain are never written (they live in the mount's `rclone.conf`).
 * `createSource` takes a `MountSourceBody` whose `path` the endpoint has already replaced by its realpath.
 * The 049 CHECKs are the backstop, not the rules.
 *
 * A mount's id is the caller's (`newId()`): its private directory `<state>/mounts/<id>` exists before
 * the row does (design D5, D13). Results: a mount name taken in the workspace, or a source name or path
 * taken, is `conflict` (checked before the 32-source cap, `bad_request`); a `local` mount whose source is
 * gone is `not_found`. `remove` / `removeSource` return `undefined` for an unknown id; removing a source
 * still referenced fails on the RESTRICT foreign key (the caller detaches its mounts first). Each write
 * opens its own transaction (the caller must not be in one); the optional `within(record)` runs after
 * the write, before COMMIT (the audit hook) — a throw rolls all of it back.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { HttpError } from "../../core/errors/index.js";
import type { MountBody, MountSourceBody } from "./validate.js";

/** Mount sources a server may register (workspace-mounts「挂载源端点」: the 33rd is 400). */
const MAX_MOUNT_SOURCES = 32;

/** One `workspace_mounts` row: `local` has null `host` / `port` / `remotePath`, the others null `sourceId`. */
export interface MountRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  backend: MountBody["backend"];
  host: string | null;
  port: number | null;
  remotePath: string | null;
  sourceId: string | null;
  readOnly: boolean;
  createdAt: number;
}

/** One `mount_sources` row (the admin view). */
export interface MountSourceRecord {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
  createdAt: number;
}

export interface CreateMountInput {
  id: string;
  workspaceId: string;
  ownerId: string;
  body: MountBody;
}

interface MountStoreOptions {
  /** Ids of new rows; tests inject them. Default: 16 random bytes as lowercase hex. */
  generateId?: () => string;
}

type Raw = Record<string, SQLOutputValue>;

const MOUNT_ORDER = "ORDER BY created_at, id";
const SELECT_MOUNT = "SELECT * FROM workspace_mounts WHERE id = ?";
const SELECT_BY_WORKSPACE = `SELECT * FROM workspace_mounts WHERE workspace_id = ? ${MOUNT_ORDER}`;
const SELECT_BY_SOURCE = `SELECT * FROM workspace_mounts WHERE source_id = ? ${MOUNT_ORDER}`;
const SELECT_ALL_MOUNTS = `SELECT * FROM workspace_mounts ${MOUNT_ORDER}`;
const SELECT_NAME_TAKEN = "SELECT 1 FROM workspace_mounts WHERE workspace_id = ? AND name = ?";
const COUNT_BY_WORKSPACE = "SELECT COUNT(*) AS count FROM workspace_mounts WHERE workspace_id = ?";
const COUNT_BY_OWNER = "SELECT COUNT(*) AS count FROM workspace_mounts WHERE owner_id = ?";
const INSERT_MOUNT =
  "INSERT INTO workspace_mounts(id, workspace_id, owner_id, name, backend, host, port, remote_path, source_id, read_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const DELETE_MOUNT = "DELETE FROM workspace_mounts WHERE id = ?";
const SELECT_SOURCE = "SELECT * FROM mount_sources WHERE id = ?";
const SELECT_ALL_SOURCES = "SELECT * FROM mount_sources ORDER BY name";
const SELECT_SOURCE_TAKEN = "SELECT 1 FROM mount_sources WHERE name = ? OR path = ?";
const COUNT_SOURCES = "SELECT COUNT(*) AS count FROM mount_sources";
const INSERT_SOURCE =
  "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, ?, ?, ?, ?)";
const DELETE_SOURCE = "DELETE FROM mount_sources WHERE id = ?";
const SELECT_TEMPORARY = "SELECT temporary FROM workspaces WHERE id = ?";

export function createMountStore(db: DatabaseSync, options: MountStoreOptions = {}) {
  const generateId = options.generateId ?? (() => randomBytes(16).toString("hex"));
  const mount = (id: string): MountRecord | undefined => {
    const row = db.prepare(SELECT_MOUNT).get(id);
    return row === undefined ? undefined : toMount(row);
  };
  const source = (id: string): MountSourceRecord | undefined => {
    const row = db.prepare(SELECT_SOURCE).get(id);
    return row === undefined ? undefined : toSource(row);
  };
  const count = (sql: string, ...params: string[]): number =>
    Number((db.prepare(sql).get(...params) as { count: number }).count);

  return {
    /** A fresh mount id, for the private directory the caller creates before `create`. */
    newId: (): string => generateId(),

    get: mount,

    /** The workspace's mounts by `created_at`, then `id`. */
    list: (workspaceId: string): MountRecord[] =>
      db.prepare(SELECT_BY_WORKSPACE).all(workspaceId).map(toMount),

    /** Every mount by `created_at`, then `id`: the manager's registry at construction. */
    listAll: (): MountRecord[] => db.prepare(SELECT_ALL_MOUNTS).all().map(toMount),

    /** Every workspace's mounts on the source, by `created_at`, then `id`. */
    listBySource: (sourceId: string): MountRecord[] =>
      db.prepare(SELECT_BY_SOURCE).all(sourceId).map(toMount),

    countByWorkspace: (workspaceId: string): number => count(COUNT_BY_WORKSPACE, workspaceId),

    /** The account's mounts across all its workspaces (a row's `owner_id` is the account that attached it). */
    countByOwner: (ownerId: string): number => count(COUNT_BY_OWNER, ownerId),

    /** The workspace row carries `temporary = 1` (design D15: no mount); false for an unknown id. */
    isTemporaryWorkspace: (workspaceId: string): boolean =>
      (db.prepare(SELECT_TEMPORARY).get(workspaceId) as { temporary: number } | undefined)
        ?.temporary === 1,

    /** Inserts the row; the source of a `local` mount must still exist (`not_found`). */
    create(input: CreateMountInput, within?: (record: MountRecord) => void): MountRecord {
      const { id, workspaceId, ownerId, body } = input;
      const remote = body.backend === "local" ? null : body;
      const sourceId = body.backend === "local" ? body.sourceId : null;
      return inTransaction(db, () => {
        if (sourceId !== null && source(sourceId) === undefined) {
          throw new HttpError("not_found");
        }
        if (db.prepare(SELECT_NAME_TAKEN).get(workspaceId, body.name) !== undefined) {
          throw new HttpError("conflict");
        }
        db.prepare(INSERT_MOUNT).run(
          id,
          workspaceId,
          ownerId,
          body.name,
          body.backend,
          remote?.host ?? null,
          remote?.port ?? null,
          remote?.remotePath ?? null,
          sourceId,
          body.readOnly ? 1 : 0,
          Date.now(),
        );
        const record = mount(id) as MountRecord;
        within?.(record);
        return record;
      });
    },

    remove(id: string, within?: (record: MountRecord) => void): MountRecord | undefined {
      return inTransaction(db, () => {
        const record = mount(id);
        if (record === undefined) {
          return undefined;
        }
        db.prepare(DELETE_MOUNT).run(id);
        within?.(record);
        return record;
      });
    },

    getSource: source,

    /** Every source by `name` (UTF-8 byte order: SQLite's BINARY collation). */
    listSources: (): MountSourceRecord[] => db.prepare(SELECT_ALL_SOURCES).all().map(toSource),

    /** A taken name or path is `conflict`; the 33rd source is `bad_request`. */
    createSource(
      body: MountSourceBody,
      within?: (record: MountSourceRecord) => void,
    ): MountSourceRecord {
      return inTransaction(db, () => {
        if (db.prepare(SELECT_SOURCE_TAKEN).get(body.name, body.path) !== undefined) {
          throw new HttpError("conflict");
        }
        if (count(COUNT_SOURCES) >= MAX_MOUNT_SOURCES) {
          throw new HttpError("bad_request");
        }
        const id = generateId();
        db.prepare(INSERT_SOURCE).run(id, body.name, body.path, body.readOnly ? 1 : 0, Date.now());
        const record = source(id) as MountSourceRecord;
        within?.(record);
        return record;
      });
    },

    /** Deletes an unreferenced source; one still referenced throws the foreign-key error. */
    removeSource(
      id: string,
      within?: (record: MountSourceRecord) => void,
    ): MountSourceRecord | undefined {
      return inTransaction(db, () => {
        const record = source(id);
        if (record === undefined) {
          return undefined;
        }
        db.prepare(DELETE_SOURCE).run(id);
        within?.(record);
        return record;
      });
    },
  };
}

function toMount(row: Raw): MountRecord {
  const text = (value: SQLOutputValue | undefined) => (value == null ? null : String(value));
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    backend: row.backend as MountRecord["backend"],
    host: text(row.host),
    port: row.port == null ? null : Number(row.port),
    remotePath: text(row.remote_path),
    sourceId: text(row.source_id),
    readOnly: row.read_only === 1,
    createdAt: Number(row.created_at),
  };
}

function toSource(row: Raw): MountSourceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    readOnly: row.read_only === 1,
    createdAt: Number(row.created_at),
  };
}

/** This module's own transaction, the same as `connectors/store.ts` and `models/store.ts`. */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "mount store rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
