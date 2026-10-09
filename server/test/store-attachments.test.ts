/**
 * Issue #1018 read side of `chat_messages.attachments` (s1g-composer-capabilities task 12.1; design
 * D12): `parseAttachments` over the stored text and `readAttachmentPaths` / the store's
 * `attachmentPaths` over a real in-memory SQLite migrated to the head. The column has no CHECK
 * (migration 042), so anything can be in it: NULL and every value that is not a list of
 * `{path, size}` read as no attachment, without a throw and without the column being rewritten.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseAttachments, readAttachmentPaths } from "../src/sessions/store-attachments.js";
import { FIXED_NOW, seedMessage, seedSession, withSessionStore } from "./session-store-helpers.js";

const SESSION = "a".repeat(32);
const OTHER = "b".repeat(32);

function session(db: DatabaseSync, id: string): void {
  seedSession(db, {
    id,
    ownerId: "u1",
    title: null,
    status: "done",
    ompSessionFile: null,
    streamEpoch: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
}

/** One message of `sessionId` whose column holds `stored` as it is (a string, a blob or NULL). */
function message(
  db: DatabaseSync,
  sessionId: string,
  stored: string | Uint8Array | null,
  role: "user" | "assistant" = "user",
): number {
  const id = seedMessage(db, { sessionId, role, content: "q", status: "done", createdAt: 1 });
  db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = ?").run(stored, id);
  return id;
}

function stored(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT id, attachments, typeof(attachments) AS type FROM chat_messages ORDER BY id")
    .all();
}

describe("parseAttachments (#1018)", () => {
  it("reads a stored list in order, keeping exactly path and size", () => {
    expect(
      parseAttachments(
        '[{"path":"uploads/a.pdf","size":3},{"path":"uploads/图 (1).png","size":0}]',
      ),
    ).toEqual([
      { path: "uploads/a.pdf", size: 3 },
      { path: "uploads/图 (1).png", size: 0 },
    ]);
    const [extra] = parseAttachments('[{"path":"a","size":9007199254740991,"name":"x"}]');
    expect(extra).toEqual({ path: "a", size: 9007199254740991 });
    expect(Object.keys(extra ?? {})).toEqual(["path", "size"]);
    expect(parseAttachments("[]")).toEqual([]);
  });

  it.each([
    ["NULL", null],
    ["undefined", undefined],
    ["a number", 3],
    ["a blob", new Uint8Array([0x5b, 0x5d])],
    ["an already parsed list", [{ path: "a", size: 1 }]],
    ["a list holding the stored text", ['[{"path":"a","size":1}]']],
    ["an empty string", ""],
    ["text that is not JSON", "not json"],
    ["an object", "{}"],
    ["one attachment outside a list", '{"path":"a","size":1}'],
    ["a list wrapped in an object", '{"0":{"path":"a","size":1},"length":1}'],
    ["a JSON string", '"uploads/a.pdf"'],
    ["JSON null", "null"],
    ["a path that is not a string", '[{"path":1}]'],
    ["a path that is not a string, with a size", '[{"path":1,"size":1}]'],
    ["an empty path", '[{"path":"","size":1}]'],
    ["no size", '[{"path":"a"}]'],
    ["a size that is a string", '[{"path":"a","size":"1"}]'],
    ["a negative size", '[{"path":"a","size":-1}]'],
    ["a fractional size", '[{"path":"a","size":1.5}]'],
    ["a size past the safe integers", '[{"path":"a","size":9007199254740992}]'],
    ["an element that is a string", '["uploads/a.pdf"]'],
    ["an element that is null", "[null]"],
    ["an element that is a list", '[["a",1]]'],
    ["one bad element after a good one", '[{"path":"a","size":1},{"path":"b"}]'],
    ["one bad element before a good one", '[{"size":1},{"path":"b","size":1}]'],
  ])("坏值: %s reads as no attachment and does not throw", (_name, value) => {
    expect(parseAttachments(value)).toEqual([]);
  });
});

describe("readAttachmentPaths and SessionStore.attachmentPaths (#1018)", () => {
  it("maps the session's messages that store attachments to their paths, and no other message", () => {
    withSessionStore(({ db, store }) => {
      session(db, SESSION);
      session(db, OTHER);
      const one = message(db, SESSION, '[{"path":"uploads/a.pdf","size":3}]');
      message(db, SESSION, null, "assistant");
      const two = message(
        db,
        SESSION,
        '[{"path":"uploads/b.png","size":1},{"path":"notes/c.md","size":2}]',
      );
      message(db, SESSION, null);
      const elsewhere = message(db, OTHER, '[{"path":"uploads/z.txt","size":1}]');
      const before = stored(db);

      const paths = readAttachmentPaths(db, SESSION);

      expect([...paths]).toEqual([
        [one, ["uploads/a.pdf"]],
        [two, ["uploads/b.png", "notes/c.md"]],
      ]);
      expect([...store.attachmentPaths(SESSION)]).toEqual([...paths]);
      expect([...store.attachmentPaths(OTHER)]).toEqual([[elsewhere, ["uploads/z.txt"]]]);
      expect([...store.attachmentPaths("f".repeat(32))]).toEqual([]);
      expect(stored(db)).toEqual(before);
    });
  });

  it("坏值: a value that is not a list of attachments has no entry, and the column is left as it is", () => {
    withSessionStore(({ db, store }) => {
      session(db, SESSION);
      const good = message(db, SESSION, '[{"path":"uploads/a.pdf","size":3}]');
      for (const bad of ["not json", "{}", '[{"path":1}]', "", "[]"]) {
        message(db, SESSION, bad);
      }
      message(db, SESSION, new Uint8Array([0x5b, 0x5d]));
      message(db, SESSION, null);
      const before = stored(db);

      expect([...store.attachmentPaths(SESSION)]).toEqual([[good, ["uploads/a.pdf"]]]);
      expect(stored(db)).toEqual(before);
      expect(before).toHaveLength(8);
    });
  });
});
