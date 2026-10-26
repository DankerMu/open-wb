/**
 * s1b-workspace-mounts group 1 (migration and store part): migration 049 and the mount store (design D1;
 * workspace-mounts「迁移 049 挂载 schema」with its three scenarios「形状约束」「被引用的行不能先删」
 * 「表里没有凭证」, the 32-source cap of「挂载源端点」). `:memory:` databases through the real migrations
 * (`openDb`); expected values are literals from design D1 and the spec. Credential values are sentinels:
 * the store takes `validate.ts`'s `MountBody` and must persist none of them.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { createMountStore } from "../src/workspaces/mounts/store.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";
import {
  COMPLETE_CATALOG,
  ledgerFilenames,
  MIGRATION_048,
  MIGRATION_049,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withOpenDb,
} from "./core-db-helpers.js";
import { seedPopulated034, seedThrough, W_U1, W_U2 } from "./core-db-session-fixture.js";

const T0 = 1_760_000_000_000;
const SENTINEL = "Snt1nelM4q";
const W1 = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const W2 = "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";
const SFTP: MountBody = {
  name: "remote",
  backend: "sftp",
  host: "files.intra",
  port: 2222,
  remotePath: "/srv/data",
  readOnly: false,
  username: `user-${SENTINEL}`,
  password: `pw-${SENTINEL}`,
};
const SMB: MountBody = {
  name: "share",
  backend: "smb",
  host: "10.0.0.5",
  remotePath: "/team/docs",
  readOnly: true,
  username: `user-${SENTINEL}`,
  password: `pw-${SENTINEL}`,
  domain: `dom${SENTINEL}`,
};
const SMB_AS_REMOTE: MountBody = { ...SMB, name: "remote" };
const local = (sourceId: string, name = "数据仓库导出"): MountBody => ({
  name,
  backend: "local",
  sourceId,
  readOnly: true,
});
const hex = (n: number) => n.toString(16).padStart(32, "0");

const opened: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) db.close();
  removeTempDirs();
});

/** A migrated database with W1 (owner u1) and W2 (owner u2); `ids` feeds the store's id generator. */
function fresh(ids: string[] = []) {
  const db = openDb(":memory:");
  opened.push(db);
  const insert = db.prepare(
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, 1)",
  );
  insert.run(W1, "u1", "w1", "w1");
  insert.run(W2, "u2", "w2", "w2");
  const queue = [...ids];
  let n = 0;
  const generateId = () => queue.shift() ?? hex(0xf000 + n++);
  return { db, store: createMountStore(db, { generateId }) };
}

const rawMounts = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM workspace_mounts ORDER BY id").all();
const rawSources = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM mount_sources ORDER BY id").all();
const tableInfo = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);

/** The code a call throws (`none` if it returns); a throw is the code's fixed-message HttpError. */
function codeOf(action: () => unknown): HttpErrorCode | "none" {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const { code, message } = error as HttpError;
    expect(message).toBe(HTTP_ERROR_MESSAGES[code]);
    return code;
  }
  return "none";
}

const SOURCE_SQL =
  "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, ?, ?, ?, 1)";
const MOUNT_SQL =
  "INSERT INTO workspace_mounts(id, workspace_id, owner_id, name, backend, host, port, remote_path, source_id, read_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)";
type MountRow = {
  id?: string;
  workspace?: string;
  owner?: string;
  name?: string;
  backend?: string;
  host?: string | null;
  port?: number | null;
  remotePath?: string | null;
  source?: string | null;
  readOnly?: number;
};
const SOURCE_A = hex(0xa);
/** Inserts one raw `workspace_mounts` row: a legal sftp row unless overridden. */
function insertMount(db: DatabaseSync, row: MountRow): void {
  const r = {
    id: hex(1),
    workspace: W1,
    owner: "u1",
    name: "remote",
    backend: "sftp",
    host: "files.intra",
    port: 22,
    remotePath: "/srv",
    source: null,
    readOnly: 0,
    ...row,
  };
  db.prepare(MOUNT_SQL).run(
    r.id,
    r.workspace,
    r.owner,
    r.name,
    r.backend,
    r.host,
    r.port,
    r.remotePath,
    r.source,
    r.readOnly,
  );
}
/** The `local` shape without id or name: each use gives its own, so only the field under test differs. */
const LOCAL_SHAPE: MountRow = {
  backend: "local",
  host: null,
  port: null,
  remotePath: null,
  source: SOURCE_A,
};
const LOCAL_ROW: MountRow = { ...LOCAL_SHAPE, id: hex(2), name: "local" };

describe("migration 049 schema", () => {
  it("is tracked once, right after 048, with its receipt at position 23", () => {
    const pos = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_049);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_049)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[pos - 1]).toBe(MIGRATION_048);
    expect(COMPLETE_CATALOG.receipts[pos]).toEqual([23, MIGRATION_049]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([
      ["schema_migrations", TRACKED_MIGRATION_FILENAMES.length, "integer"],
    ]);
  });

  it("表里没有凭证: the two tables have exactly the spec's columns, no credential or status column", () => {
    const { db } = fresh();
    expect(tableInfo(db, "mount_sources")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["name", "TEXT", 1, null, 0],
      ["path", "TEXT", 1, null, 0],
      ["read_only", "INTEGER", 1, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
    ]);
    expect(tableInfo(db, "workspace_mounts")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["workspace_id", "TEXT", 1, null, 0],
      ["owner_id", "TEXT", 1, null, 0],
      ["name", "TEXT", 1, null, 0],
      ["backend", "TEXT", 1, null, 0],
      ["host", "TEXT", 0, null, 0],
      ["port", "INTEGER", 0, null, 0],
      ["remote_path", "TEXT", 0, null, 0],
      ["source_id", "TEXT", 0, null, 0],
      ["read_only", "INTEGER", 1, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
    ]);
    for (const table of ["mount_sources", "workspace_mounts"]) {
      for (const [name] of tableInfo(db, table)) {
        expect(String(name)).not.toMatch(/user|pass|key|domain|status|state/);
      }
    }
  });

  it("references workspaces and mount sources with RESTRICT and the owner with no action", () => {
    const { db } = fresh();
    const keys = (table: string) =>
      db
        .prepare(`PRAGMA foreign_key_list('${table}')`)
        .all()
        .map((k) => [k.from, k.table, k.to, k.on_delete])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(keys("workspace_mounts")).toEqual([
      ["owner_id", "accounts", "id", "NO ACTION"],
      ["source_id", "mount_sources", "id", "RESTRICT"],
      ["workspace_id", "workspaces", "id", "RESTRICT"],
    ]);
    expect(keys("mount_sources")).toEqual([]);
  });

  it("形状约束: every illegal mount row is refused; a legal sftp row and a local row on a source insert", () => {
    const { db } = fresh();
    db.prepare(SOURCE_SQL).run(SOURCE_A, "NFS 共享", "/srv/nfs", 0);
    insertMount(db, {});
    insertMount(db, LOCAL_ROW);
    insertMount(db, { id: hex(3), name: "数据仓库导出", backend: "smb", port: 65535 });
    insertMount(db, { id: hex(4), name: "A_b-9", port: null, readOnly: 1 });
    const before = rawMounts(db);
    const refused: MountRow[] = [
      { ...LOCAL_SHAPE, name: "x0", source: null }, // local without source_id
      { name: "x1", host: null }, // sftp without host
      { name: "x2", remotePath: null }, // sftp without remote_path
      { name: "x3", source: SOURCE_A }, // sftp with source_id
      { ...LOCAL_SHAPE, name: "x4", host: "h" }, // local with host
      { ...LOCAL_SHAPE, name: "x5", port: 22 }, // local with port
      { ...LOCAL_SHAPE, name: "x6", remotePath: "/srv" }, // local with remote_path
      { name: "x7", backend: "nfs" },
      { name: "uploads" },
      { name: "screenshots" },
      { name: "a/b" },
      { name: "." },
      { name: ".." },
      { name: ".git" },
      { name: "" },
      { name: "a".repeat(65) },
      { name: "x8", port: 0 },
      { name: "x9", port: 65536 },
      { name: "y1", readOnly: 2 },
      { id: "ABCDEF0123456789ABCDEF0123456789", name: "y2" },
      { id: "abc", name: "y3" },
    ];
    for (const [i, row] of refused.entries()) {
      expect(() => insertMount(db, { id: hex(0x100 + i), ...row })).toThrow(
        /CHECK constraint failed/,
      );
    }
    // Same workspace, same name.
    expect(() => insertMount(db, { id: hex(0x1ff) })).toThrow(
      "UNIQUE constraint failed: workspace_mounts.workspace_id, workspace_mounts.name",
    );
    expect(rawMounts(db)).toEqual(before);
    insertMount(db, { id: hex(5), workspace: W2, owner: "u2" }); // same name, another workspace
    expect(rawMounts(db)).toHaveLength(before.length + 1);
  });

  it("refuses mount-source rows that break the name, path or read_only rule, or repeat a name or path", () => {
    const { db } = fresh();
    db.prepare(SOURCE_SQL).run(SOURCE_A, "NFS 共享", "/srv/nfs", 1);
    db.prepare(SOURCE_SQL).run(hex(0xb), "测".repeat(64), "/", 0);
    const before = rawSources(db);
    const refused: Array<[string, string, number]> = [
      ["", "/a", 0],
      ["测".repeat(65), "/b", 0],
      ["a\u0001b", "/c", 0],
      ["a\u001fb", "/d", 0],
      ["a\u007fb", "/e", 0],
      ["a\u0000b", "/f", 0],
      ["rel", "srv/rel", 0],
      ["empty", "", 0],
      ["ro", "/g", 2],
    ];
    for (const [i, [name, path, readOnly]] of refused.entries()) {
      expect(() => db.prepare(SOURCE_SQL).run(hex(0x200 + i), name, path, readOnly)).toThrow(
        /CHECK constraint failed/,
      );
    }
    expect(() => db.prepare(SOURCE_SQL).run("XYZ", "upper", "/i", 0)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => db.prepare(SOURCE_SQL).run(hex(0x2fe), "NFS 共享", "/h", 0)).toThrow(
      "UNIQUE constraint failed: mount_sources.name",
    );
    expect(() => db.prepare(SOURCE_SQL).run(hex(0x2ff), "other", "/srv/nfs", 0)).toThrow(
      "UNIQUE constraint failed: mount_sources.path",
    );
    expect(rawSources(db)).toEqual(before);
  });

  it("被引用的行不能先删: deleting the workspace row and the referenced source row both fail on the foreign key", () => {
    const { db } = fresh();
    db.prepare(SOURCE_SQL).run(SOURCE_A, "NFS 共享", "/srv/nfs", 0);
    insertMount(db, LOCAL_ROW);
    expect(() => db.prepare("DELETE FROM workspaces WHERE id = ?").run(W1)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(() => db.prepare("DELETE FROM mount_sources WHERE id = ?").run(SOURCE_A)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(W1)).toEqual({ id: W1 });
    expect(db.prepare("SELECT id FROM mount_sources").all()).toEqual([{ id: SOURCE_A }]);
    expect(rawMounts(db)).toHaveLength(1);
  });

  it("a populated database ending at 048 upgrades with both tables empty", () => {
    const file = join(tempDir(), "populated-048.db");
    const through048 = TRACKED_MIGRATION_FILENAMES.slice(
      0,
      TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_049),
    );
    seedThrough(file, through048, seedPopulated034);
    withOpenDb(file, (db) => {
      expect(db.prepare("SELECT id FROM workspaces ORDER BY id").all()).toContainEqual({
        id: W_U1,
      });
      expect(db.prepare("SELECT id FROM workspaces ORDER BY id").all()).toContainEqual({
        id: W_U2,
      });
      expect(rawMounts(db)).toEqual([]);
      expect(rawSources(db)).toEqual([]);
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
    });
  });
});

describe("mount store: mounts", () => {
  it("create stores only the connection fields: no credential value reaches the row", () => {
    const { db, store } = fresh();
    const id = store.newId();
    expect(id).toBe(hex(0xf000));
    expect(store.create({ id, workspaceId: W1, ownerId: "u1", body: SFTP })).toEqual({
      id,
      workspaceId: W1,
      ownerId: "u1",
      name: "remote",
      backend: "sftp",
      host: "files.intra",
      port: 2222,
      remotePath: "/srv/data",
      sourceId: null,
      readOnly: false,
      createdAt: T0,
    });
    const smb = store.create({ id: hex(7), workspaceId: W1, ownerId: "u1", body: SMB });
    expect(smb).toMatchObject({ backend: "smb", port: null, readOnly: true, sourceId: null });
    expect(rawMounts(db)).toEqual([
      {
        id: hex(7),
        workspace_id: W1,
        owner_id: "u1",
        name: "share",
        backend: "smb",
        host: "10.0.0.5",
        port: null,
        remote_path: "/team/docs",
        source_id: null,
        read_only: 1,
        created_at: T0,
      },
      {
        id: hex(0xf000),
        workspace_id: W1,
        owner_id: "u1",
        name: "remote",
        backend: "sftp",
        host: "files.intra",
        port: 2222,
        remote_path: "/srv/data",
        source_id: null,
        read_only: 0,
        created_at: T0,
      },
    ]);
    expect(JSON.stringify(rawMounts(db))).not.toContain(SENTINEL);
    expect(JSON.stringify(store.listAll())).not.toContain(SENTINEL);
  });

  it("create of a local mount references its source; an unknown source is not_found and inserts nothing", () => {
    const { db, store } = fresh();
    const source = store.createSource({ name: "NFS 共享", path: "/srv/nfs", readOnly: true });
    expect(
      store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: local(source.id) }),
    ).toEqual({
      id: hex(1),
      workspaceId: W1,
      ownerId: "u1",
      name: "数据仓库导出",
      backend: "local",
      host: null,
      port: null,
      remotePath: null,
      sourceId: source.id,
      readOnly: true,
      createdAt: T0,
    });
    expect(
      codeOf(() =>
        store.create({ id: hex(2), workspaceId: W2, ownerId: "u2", body: local(hex(0xdead)) }),
      ),
    ).toBe("not_found");
    expect(rawMounts(db)).toHaveLength(1);
    expect(db.isTransaction).toBe(false);
  });

  it("create of a name taken in the same workspace is conflict; another workspace may reuse it", () => {
    const { db, store } = fresh();
    store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: SFTP });
    expect(
      codeOf(() =>
        store.create({ id: hex(2), workspaceId: W1, ownerId: "u1", body: SMB_AS_REMOTE }),
      ),
    ).toBe("conflict");
    expect(rawMounts(db)).toHaveLength(1);
    store.create({ id: hex(3), workspaceId: W2, ownerId: "u2", body: SFTP });
    expect(rawMounts(db)).toHaveLength(2);
  });

  it("runs within() in the same transaction: a throw rolls the insert back", () => {
    const { db, store } = fresh();
    const seen: unknown[] = [];
    expect(() =>
      store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: SFTP }, (record) => {
        seen.push(record.id, rawMounts(db).length);
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(seen).toEqual([hex(1), 1]);
    expect(rawMounts(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it("list is one workspace's mounts by created_at, then id; countByWorkspace and listAll agree", () => {
    const { store } = fresh();
    const add = (id: number, workspaceId: string, name: string, at: number) => {
      vi.setSystemTime(at);
      store.create({ id: hex(id), workspaceId, ownerId: "u1", body: { ...SFTP, name } });
    };
    add(9, W1, "c", T0 + 20);
    add(5, W1, "b", T0 + 10);
    add(3, W1, "a", T0 + 10);
    add(1, W2, "z", T0 + 15);
    add(4, W1, "d", T0 + 5);
    expect(store.list(W1).map((m) => m.id)).toEqual([hex(4), hex(3), hex(5), hex(9)]);
    expect(store.list(W2).map((m) => m.id)).toEqual([hex(1)]);
    expect(store.listAll().map((m) => [m.id, m.workspaceId])).toEqual([
      [hex(4), W1],
      [hex(3), W1],
      [hex(5), W1],
      [hex(1), W2],
      [hex(9), W1],
    ]);
    expect(store.countByWorkspace(W1)).toBe(4);
    expect(store.countByWorkspace(W2)).toBe(1);
    expect(store.countByWorkspace(hex(0xeeee))).toBe(0);
    expect(store.list(hex(0xeeee))).toEqual([]);
  });

  it("get and remove: remove returns the row and deletes it; an unknown id is undefined", () => {
    const { db, store } = fresh();
    const created = store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: SFTP });
    store.create({ id: hex(2), workspaceId: W1, ownerId: "u1", body: SMB });
    expect(store.get(hex(1))).toEqual(created);
    expect(store.get(hex(0xeeee))).toBeUndefined();
    expect(store.remove(hex(1))).toEqual(created);
    expect(store.get(hex(1))).toBeUndefined();
    expect(store.remove(hex(1))).toBeUndefined();
    expect(rawMounts(db).map((row) => row.id)).toEqual([hex(2)]);
    expect(store.countByWorkspace(W1)).toBe(1);
  });

  it("remove runs within() before COMMIT: a throw keeps the row", () => {
    const { db, store } = fresh();
    store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: SFTP });
    expect(() =>
      store.remove(hex(1), () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawMounts(db)).toHaveLength(1);
    expect(db.isTransaction).toBe(false);
  });

  it("listBySource is every workspace's mounts on that source, by created_at, then id", () => {
    const { store } = fresh();
    const s1 = store.createSource({ name: "s1", path: "/srv/one", readOnly: false });
    const s2 = store.createSource({ name: "s2", path: "/srv/two", readOnly: false });
    vi.setSystemTime(T0 + 30);
    store.create({ id: hex(8), workspaceId: W2, ownerId: "u2", body: local(s1.id, "m") });
    vi.setSystemTime(T0 + 10);
    store.create({ id: hex(6), workspaceId: W1, ownerId: "u1", body: local(s1.id, "m") });
    store.create({ id: hex(7), workspaceId: W1, ownerId: "u1", body: local(s2.id, "n") });
    store.create({ id: hex(5), workspaceId: W1, ownerId: "u1", body: SFTP });
    expect(store.listBySource(s1.id).map((m) => [m.id, m.workspaceId])).toEqual([
      [hex(6), W1],
      [hex(8), W2],
    ]);
    expect(store.listBySource(s2.id).map((m) => m.id)).toEqual([hex(7)]);
    expect(store.listBySource(hex(0xeeee))).toEqual([]);
  });
});

describe("mount store: mount sources", () => {
  it("createSource stores the admin view with a generated 32-hex id; getSource reads it back", () => {
    const db = openDb(":memory:");
    opened.push(db);
    const store = createMountStore(db);
    const source = store.createSource({ name: "NFS 共享", path: "/srv/nfs", readOnly: true });
    expect(source.id).toMatch(/^[0-9a-f]{32}$/);
    expect(source).toEqual({
      id: source.id,
      name: "NFS 共享",
      path: "/srv/nfs",
      readOnly: true,
      createdAt: T0,
    });
    expect(rawSources(db)).toEqual([
      { id: source.id, name: "NFS 共享", path: "/srv/nfs", read_only: 1, created_at: T0 },
    ]);
    expect(store.getSource(source.id)).toEqual(source);
    expect(store.getSource(hex(0xeeee))).toBeUndefined();
  });

  it("listSources orders by name in UTF-8 byte order", () => {
    const { store } = fresh();
    for (const [i, name] of ["数据", "b", "B", "a", "Ab"].entries()) {
      store.createSource({ name, path: `/srv/${i}`, readOnly: false });
    }
    expect(store.listSources().map((s) => s.name)).toEqual(["Ab", "B", "a", "b", "数据"]);
  });

  it("a taken name or path is conflict; with 32 sources the 33rd is bad_request", () => {
    const { db, store } = fresh();
    store.createSource({ name: "first", path: "/srv/first", readOnly: false });
    expect(
      codeOf(() => store.createSource({ name: "first", path: "/srv/x", readOnly: false })),
    ).toBe("conflict");
    expect(
      codeOf(() => store.createSource({ name: "x", path: "/srv/first", readOnly: false })),
    ).toBe("conflict");
    for (let i = 2; i <= 32; i += 1) {
      store.createSource({ name: `s${i}`, path: `/srv/s${i}`, readOnly: false });
    }
    expect(rawSources(db)).toHaveLength(32);
    expect(
      codeOf(() => store.createSource({ name: "s33", path: "/srv/s33", readOnly: false })),
    ).toBe("bad_request");
    expect(
      codeOf(() => store.createSource({ name: "first", path: "/srv/y", readOnly: false })),
    ).toBe("conflict");
    expect(rawSources(db)).toHaveLength(32);
    expect(db.isTransaction).toBe(false);
  });

  it("createSource runs within() before COMMIT: a throw inserts nothing", () => {
    const { db, store } = fresh();
    expect(() =>
      store.createSource({ name: "a", path: "/srv/a", readOnly: false }, (source) => {
        expect(rawSources(db)).toHaveLength(1);
        expect(source.name).toBe("a");
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawSources(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it("removeSource deletes an unreferenced source; a referenced one stays until its mounts are gone", () => {
    const { db, store } = fresh();
    const used = store.createSource({ name: "used", path: "/srv/used", readOnly: false });
    const idle = store.createSource({ name: "idle", path: "/srv/idle", readOnly: false });
    store.create({ id: hex(1), workspaceId: W1, ownerId: "u1", body: local(used.id) });
    expect(store.removeSource(idle.id)).toEqual(idle);
    expect(store.removeSource(idle.id)).toBeUndefined();
    expect(() => store.removeSource(used.id)).toThrow(/FOREIGN KEY constraint failed/);
    expect(store.getSource(used.id)).toEqual(used);
    expect(db.isTransaction).toBe(false);
    expect(() =>
      store.removeSource(used.id, () => {
        throw new Error("unreachable");
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    store.remove(hex(1));
    expect(() =>
      store.removeSource(used.id, () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(store.getSource(used.id)).toEqual(used);
    expect(store.removeSource(used.id)).toEqual(used);
    expect(store.listSources()).toEqual([]);
  });
});
