/**
 * Public-boundary regressions for SQLite TEXT truncation at U+0000.
 * Uses real openDb, SessionStore, and audit.emit/query only.
 */
import { Buffer } from "node:buffer";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit, query } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import {
  ledgerFilenames,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
} from "./core-db-helpers.js";
import { withSessionStore } from "./session-store-helpers.js";

const NUL = String.fromCharCode(0);
const TITLE_WITH_NUL = `a${NUL}b`;
const CONTENT_WITH_NUL = `hello${NUL}suffix`;
const ASSISTANT_WITH_NUL = `delta${NUL}tail`;
const STEP_NAME_WITH_NUL = `step${NUL}name`;
const STEP_DETAIL_WITH_NUL = `detail${NUL}body`;
const STEP_OUTPUT_WITH_NUL = `done${NUL}\uFEFFok 😀\nline`;
const RESUME_WITH_NUL = `resume/${NUL}file.jsonl`;
const BOM_TEXT = `\uFEFFKeep BOM 中文 😀`;
const ORDINARY_TEXT = `café 中文 😀`;
const EMPTY = "";

const MEMBER_U1 = { id: "u1", role: "成员" } as const;
const MEMBER_U2 = { id: "u2", role: "成员" } as const;
const ADMIN_U3 = { id: "u3", role: "管理员" } as const;

type SqliteTextEncoding = "UTF-8" | "UTF-16le" | "UTF-16be";

const ENCODINGS = [
  "UTF-8",
  "UTF-16le",
  "UTF-16be",
] as const satisfies readonly SqliteTextEncoding[];

/** Independently encoded bytes of `a` + U+0000 + `b`, not derived from a native TEXT read. */
const TITLE_NUL_HEX: Record<SqliteTextEncoding, string> = {
  "UTF-8": "610062",
  "UTF-16le": "610000006200",
  "UTF-16be": "006100000062",
};

afterEach(removeTempDirs);

function pragmaEncoding(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA encoding").get() as { encoding: string } | undefined;
  if (row === undefined) {
    throw new Error("PRAGMA encoding returned no row");
  }
  return row.encoding;
}

function physicalText(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): { hex: string; storage: string } {
  const row = db.prepare(sql).get(...params) as { blob: unknown; storage: string } | undefined;
  if (row === undefined) {
    throw new Error("expected a persisted text row");
  }
  if (!(row.blob instanceof Uint8Array)) {
    throw new Error("expected CAST(... AS BLOB) bytes");
  }
  return { hex: Buffer.from(row.blob).toString("hex"), storage: row.storage };
}

function openEncodedDb(path: string, encoding: SqliteTextEncoding): DatabaseSync {
  const bootstrap = new DatabaseSync(path);
  try {
    bootstrap.exec(`PRAGMA encoding = '${encoding}'`);
    bootstrap.exec("CREATE TABLE encoding_lock(x INTEGER); DROP TABLE encoding_lock;");
  } finally {
    bootstrap.close();
  }
  const db = openDb(path);
  const actual = pragmaEncoding(db);
  if (actual !== encoding) {
    db.close();
    throw new Error(`expected ${encoding} database, got ${actual}`);
  }
  return db;
}

function withStore<T>(db: DatabaseSync, run: (store: SessionStore) => T): T {
  const store = createSessionStore(db, {
    onFlushError(failure) {
      throw failure.error instanceof Error ? failure.error : new Error("flush failed");
    },
  });
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function withOpenCleanup<T>(db: DatabaseSync, run: (db: DatabaseSync) => T): T {
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function seedNulTitleSession(store: SessionStore, ownerId: string): string {
  const session = store.create(ownerId);
  const accepted = store.acceptPrompt(session.id, ownerId, TITLE_WITH_NUL);
  expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
  return session.id;
}

function seedCompletedThenNulTitle(store: SessionStore, ordinaryTitle: string): string {
  const ordinary = store.create("u1");
  const ordinaryAccepted = store.acceptPrompt(ordinary.id, "u1", ordinaryTitle);
  expect(store.finishTurn(ordinaryAccepted.assistantMessageId, "done")).toBe(true);
  return seedNulTitleSession(store, "u1");
}

describe("SessionStore lossless free-text reads", () => {
  it("returns complete NUL-containing user content after INSERT", () => {
    withSessionStore(({ db, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", CONTENT_WITH_NUL);
      expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      expect(
        physicalText(
          db,
          "SELECT CAST(content AS BLOB) AS blob, typeof(content) AS storage FROM chat_messages WHERE id = ?",
          accepted.userMessageId,
        ),
      ).toEqual({
        hex: Buffer.from(CONTENT_WITH_NUL, "utf8").toString("hex"),
        storage: "text",
      });
      expect(store.getMessages(session.id, "u1")?.messages[0]?.content).toBe(CONTENT_WITH_NUL);
    });
  });

  it("returns complete NUL-containing assistant content after append and finish", () => {
    withSessionStore(({ db, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "plain prompt");
      expect(store.appendDelta(accepted.assistantMessageId, ASSISTANT_WITH_NUL)).toBe(true);
      expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      expect(
        physicalText(
          db,
          "SELECT CAST(content AS BLOB) AS blob, typeof(content) AS storage FROM chat_messages WHERE id = ?",
          accepted.assistantMessageId,
        ),
      ).toEqual({
        hex: Buffer.from(ASSISTANT_WITH_NUL, "utf8").toString("hex"),
        storage: "text",
      });
      expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(ASSISTANT_WITH_NUL);
    });
  });

  it("returns complete NUL-containing list and history titles", () => {
    withSessionStore(({ store }) => {
      const sessionId = seedNulTitleSession(store, "u1");
      const listed = store.list("u1");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(sessionId);
      expect(store.list("u2")).toEqual([]);
      expect(listed[0]?.title).toBe(TITLE_WITH_NUL);
      expect(store.getMessages(sessionId, "u1")?.session.title).toBe(TITLE_WITH_NUL);
    });
  });

  it("returns complete NUL-containing step name, start detail, and finish output", () => {
    withSessionStore(({ store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "plain prompt");
      const stepId = store.startStep(accepted.assistantMessageId, {
        ordinal: 0,
        name: STEP_NAME_WITH_NUL,
        detail: STEP_DETAIL_WITH_NUL,
      });
      expect(store.finishStep(stepId, "done", STEP_OUTPUT_WITH_NUL)).toBe(true);
      expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      expect(store.getMessages(session.id, "u1")?.messages[1]?.steps[0]).toEqual(
        expect.objectContaining({
          id: stepId,
          name: STEP_NAME_WITH_NUL,
          detail: STEP_DETAIL_WITH_NUL,
          output: STEP_OUTPUT_WITH_NUL,
        }),
      );
    });
  });

  it("returns complete NUL-containing trusted resume metadata", () => {
    withSessionStore(({ store }) => {
      const session = store.create("u1");
      store.setSessionFile(session.id, RESUME_WITH_NUL);
      const runtime = store.runtimeState(session.id);
      expect(runtime?.ownerId).toBe("u1");
      expect(runtime?.ompSessionFile).toBe(RESUME_WITH_NUL);
    });
  });

  it("keeps title physical bytes and TEXT storage through second admission and unprogressed rollback", () => {
    withSessionStore(({ db, store }) => {
      const sessionId = seedNulTitleSession(store, "u1");
      const expected = { hex: TITLE_NUL_HEX["UTF-8"], storage: "text" };

      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          sessionId,
        ),
      ).toEqual(expected);
      const second = store.acceptPrompt(sessionId, "u1", "later prompt");
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          sessionId,
        ),
      ).toEqual(expected);
      expect(store.rollbackPrompt(second.assistantMessageId)).toBe(true);
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          sessionId,
        ),
      ).toEqual(expected);
    });
  });

  it("keeps SQL NULL, empty string, leading BOM, and mixed Unicode distinct", () => {
    withSessionStore(({ store }) => {
      const idle = store.create("u1");
      expect(store.list("u1")[0]?.title).toBeNull();
      expect(store.runtimeState(idle.id)?.ompSessionFile).toBeNull();
      expect(store.getMessages(idle.id, "u1")?.session.title).toBeNull();

      const empty = store.create("u1");
      const emptyAccepted = store.acceptPrompt(empty.id, "u1", EMPTY);
      expect(store.finishTurn(emptyAccepted.assistantMessageId, "done")).toBe(true);
      store.setSessionFile(empty.id, EMPTY);
      expect(store.list("u1").find((row) => row.id === empty.id)?.title).toBe(EMPTY);
      expect(store.getMessages(empty.id, "u1")?.messages[0]?.content).toBe(EMPTY);
      expect(store.runtimeState(empty.id)?.ompSessionFile).toBe(EMPTY);

      const unicode = store.create("u1");
      const unicodeAccepted = store.acceptPrompt(unicode.id, "u1", BOM_TEXT);
      expect(store.appendDelta(unicodeAccepted.assistantMessageId, ORDINARY_TEXT)).toBe(true);
      expect(store.finishTurn(unicodeAccepted.assistantMessageId, "done")).toBe(true);
      store.setSessionFile(unicode.id, BOM_TEXT);
      const tree = store.getMessages(unicode.id, "u1");
      expect(tree?.session.title).toBe(BOM_TEXT);
      expect(tree?.messages[0]?.content).toBe(BOM_TEXT);
      expect(tree?.messages[1]?.content).toBe(ORDINARY_TEXT);
      expect(store.runtimeState(unicode.id)?.ompSessionFile).toBe(BOM_TEXT);
    });
  });
});

describe("SessionStore database encoding and reopen", () => {
  it.each(ENCODINGS)(
    "round-trips ordinary Unicode on %s file databases across reopen",
    (encoding) => {
      const path = join(tempDir(), `${encoding.replaceAll("-", "").toLowerCase()}-ordinary.db`);
      const sessionId = withOpenCleanup(openEncodedDb(path, encoding), (db) => {
        expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
        return withStore(db, (store) => {
          const session = store.create("u1");
          const accepted = store.acceptPrompt(session.id, "u1", BOM_TEXT);
          expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
          expect(store.list("u1")[0]?.title).toBe(BOM_TEXT);
          expect(store.getMessages(session.id, "u1")?.messages[0]?.content).toBe(BOM_TEXT);
          return session.id;
        });
      });

      withOpenCleanup(openDb(path), (db) => {
        expect(pragmaEncoding(db)).toBe(encoding);
        expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
        withStore(db, (store) => {
          expect(store.list("u1")[0]?.id).toBe(sessionId);
          expect(store.list("u1")[0]?.title).toBe(BOM_TEXT);
          expect(store.getMessages(sessionId, "u1")?.session.title).toBe(BOM_TEXT);
        });
      });
    },
  );

  it.each(ENCODINGS)("preserves NUL titles on %s file databases across reopen", (encoding) => {
    const path = join(tempDir(), `${encoding.replaceAll("-", "").toLowerCase()}-nul.db`);
    const sessionId = withOpenCleanup(openEncodedDb(path, encoding), (db) =>
      withStore(db, (store) => {
        const id = seedCompletedThenNulTitle(store, ORDINARY_TEXT);
        expect(
          physicalText(
            db,
            "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
            id,
          ),
        ).toEqual({ hex: TITLE_NUL_HEX[encoding], storage: "text" });
        return id;
      }),
    );

    withOpenCleanup(openDb(path), (db) => {
      expect(pragmaEncoding(db)).toBe(encoding);
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          sessionId,
        ),
      ).toEqual({ hex: TITLE_NUL_HEX[encoding], storage: "text" });
      withStore(db, (store) => {
        expect(store.list("u1").some((row) => row.title === ORDINARY_TEXT)).toBe(true);
        expect(store.getMessages(sessionId, "u1")?.session.title).toBe(TITLE_WITH_NUL);
      });
    });
  });

  it("isolates encoding between interleaved connections", () => {
    const utf8Path = join(tempDir(), "interleave-utf8.db");
    const utf16Path = join(tempDir(), "interleave-utf16be.db");
    const utf8 = openEncodedDb(utf8Path, "UTF-8");
    const utf16 = openEncodedDb(utf16Path, "UTF-16be");
    try {
      const utf8Id = withStore(utf8, (store) => seedNulTitleSession(store, "u1"));
      const utf16Id = withStore(utf16, (store) => seedNulTitleSession(store, "u1"));

      expect(pragmaEncoding(utf8)).toBe("UTF-8");
      expect(pragmaEncoding(utf16)).toBe("UTF-16be");
      expect(
        physicalText(
          utf8,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          utf8Id,
        ),
      ).toEqual({ hex: TITLE_NUL_HEX["UTF-8"], storage: "text" });
      expect(
        physicalText(
          utf16,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          utf16Id,
        ),
      ).toEqual({ hex: TITLE_NUL_HEX["UTF-16be"], storage: "text" });

      withStore(utf8, (store) => {
        expect(store.list("u1")[0]?.id).toBe(utf8Id);
        expect(store.list("u1")[0]?.title).toBe(TITLE_WITH_NUL);
      });
      withStore(utf16, (store) => {
        expect(store.list("u1")[0]?.id).toBe(utf16Id);
        expect(store.list("u1")[0]?.title).toBe(TITLE_WITH_NUL);
      });
      expect(pragmaEncoding(utf8)).toBe("UTF-8");
      expect(pragmaEncoding(utf16)).toBe("UTF-16be");
    } finally {
      utf8.close();
      utf16.close();
    }
  });

  it("uses the current encoding after the same DatabaseSync handle reopens a replacement database", () => {
    const originalPath = join(tempDir(), "reopen-original.db");
    const replacementPath = join(tempDir(), "reopen-replacement.db");

    const originalId = withOpenCleanup(openEncodedDb(originalPath, "UTF-8"), (db) =>
      withStore(db, (store) => seedCompletedThenNulTitle(store, ORDINARY_TEXT)),
    );
    const replacementId = withOpenCleanup(openEncodedDb(replacementPath, "UTF-16le"), (db) =>
      withStore(db, (store) => seedCompletedThenNulTitle(store, BOM_TEXT)),
    );

    const handle = new DatabaseSync(originalPath);
    try {
      expect(pragmaEncoding(handle)).toBe("UTF-8");
      withStore(handle, (store) => {
        expect(store.list("u1").some((row) => row.title === ORDINARY_TEXT)).toBe(true);
      });
      handle.close();
      copyFileSync(replacementPath, originalPath);
      for (const suffix of ["-wal", "-shm"] as const) {
        const source = `${replacementPath}${suffix}`;
        const dest = `${originalPath}${suffix}`;
        if (existsSync(source)) {
          copyFileSync(source, dest);
        } else if (existsSync(dest)) {
          unlinkSync(dest);
        }
      }
      handle.open();

      expect(pragmaEncoding(handle)).toBe("UTF-16le");
      expect(ledgerFilenames(handle)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(
        physicalText(
          handle,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM chat_sessions WHERE id = ?",
          replacementId,
        ),
      ).toEqual({
        hex: TITLE_NUL_HEX["UTF-16le"],
        storage: "text",
      });
      withStore(handle, (store) => {
        expect(store.getMessages(originalId, "u1")).toBeNull();
        expect(store.list("u1").some((row) => row.title === BOM_TEXT)).toBe(true);
        expect(store.getMessages(replacementId, "u1")?.session.title).toBe(TITLE_WITH_NUL);
      });
    } finally {
      if (handle.isOpen) {
        handle.close();
      }
    }
  });
});

describe("core/audit lossless title reads", () => {
  it("returns complete NUL titles and already-correct detail JSON with actor filtering", () => {
    withOpenCleanup(openDb(":memory:"), (db) => {
      const u1Detail = { note: `inner${NUL}json`, count: 1 };
      const u2Detail = { note: `other${NUL}json` };
      const u1Title = `audit${NUL}one`;
      const u2Title = `审计${NUL}two`;
      const u1Id = emit(db, {
        kind: "dir.create",
        actorId: "u1",
        title: u1Title,
        detail: u1Detail,
        ts: 1,
      });
      const u2Id = emit(db, {
        kind: "workspace.create",
        actorId: "u2",
        title: u2Title,
        detail: u2Detail,
        ts: 2,
      });

      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM audit_events WHERE id = ?",
          u1Id,
        ),
      ).toEqual({
        hex: Buffer.from(u1Title, "utf8").toString("hex"),
        storage: "text",
      });
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM audit_events WHERE id = ?",
          u2Id,
        ),
      ).toEqual({
        hex: Buffer.from(u2Title, "utf8").toString("hex"),
        storage: "text",
      });

      const member = query(db, MEMBER_U1, {});
      expect(member.map((event) => event.actorId)).toEqual(["u1"]);
      expect(member.map((event) => event.id)).toEqual([u1Id]);
      expect(member[0]?.detail).toEqual(u1Detail);
      expect(member[0]?.title).toBe(u1Title);

      const otherMember = query(db, MEMBER_U2, {});
      expect(otherMember.map((event) => event.actorId)).toEqual(["u2"]);
      expect(otherMember[0]?.detail).toEqual(u2Detail);
      expect(otherMember[0]?.title).toBe(u2Title);

      const admin = query(db, ADMIN_U3, {});
      expect(admin.map((event) => event.id)).toEqual([u2Id, u1Id]);
      expect(admin.map((event) => event.actorId)).toEqual(["u2", "u1"]);
      expect(admin.map((event) => event.detail)).toEqual([u2Detail, u1Detail]);
      expect(admin.map((event) => event.title)).toEqual([u2Title, u1Title]);

      expect(() => db.exec("UPDATE audit_events SET title = title")).toThrow(
        /audit_events is append-only/,
      );
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM audit_events WHERE id = ?",
          u1Id,
        ).hex,
      ).toBe(Buffer.from(u1Title, "utf8").toString("hex"));
    });
  });

  it.each(ENCODINGS)("preserves audit titles on %s file databases", (encoding) => {
    const path = join(tempDir(), `${encoding.replaceAll("-", "").toLowerCase()}-audit.db`);
    const title = TITLE_WITH_NUL;
    const detail = { reason: `json${NUL}ok` };
    const eventId = withOpenCleanup(openEncodedDb(path, encoding), (db) => {
      const id = emit(db, {
        kind: "dir.create",
        actorId: "u1",
        title,
        detail,
        ts: 9,
      });
      expect(
        physicalText(
          db,
          "SELECT CAST(title AS BLOB) AS blob, typeof(title) AS storage FROM audit_events WHERE id = ?",
          id,
        ),
      ).toEqual({ hex: TITLE_NUL_HEX[encoding], storage: "text" });
      expect(query(db, MEMBER_U1, {})[0]?.detail).toEqual(detail);
      expect(query(db, MEMBER_U1, {})[0]?.title).toBe(title);
      return id;
    });

    withOpenCleanup(openDb(path), (db) => {
      expect(pragmaEncoding(db)).toBe(encoding);
      expect(query(db, ADMIN_U3, {})[0]?.id).toBe(eventId);
      expect(query(db, ADMIN_U3, {})[0]?.detail).toEqual(detail);
      expect(query(db, ADMIN_U3, {})[0]?.title).toBe(title);
    });
  });
});
