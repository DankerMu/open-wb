/**
 * Issue #367 migration 033: nullable chat_steps.output appended to an existing chat database.
 * Expected rows are fixture literals seeded before the upgrade, not store-derived values.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackedMigrationAssets } from "../src/core/db/migration-assets.js";
import { validatedAppliedFilenames } from "../src/core/db/migration-ledger.js";
import { runMigration } from "../src/core/db/migration-runner.js";
import { createSessionStore } from "../src/sessions/store.js";
import {
  createCanonicalLedger,
  expectRepeatedOpenStable,
  ledgerFilenames,
  MIGRATION_032,
  MIGRATION_033,
  MIGRATION_034,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import { seedMessage, seedSession } from "./session-store-helpers.js";

afterEach(removeTempDirs);

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const PRE_033_STEPS = [
  {
    id: 1,
    message_id: 2,
    ordinal: 0,
    name: "bash",
    detail: '{"output":"legacy end-overwritten"}',
    status: "done",
    started_at: 30,
    ended_at: 31,
  },
  {
    id: 2,
    message_id: 2,
    ordinal: 1,
    name: "read",
    detail: '{"path":"README.md"}',
    status: "running",
    started_at: 32,
    ended_at: null,
  },
];

function stepRows(db: DatabaseSync, columns: string) {
  return db.prepare(`SELECT ${columns} FROM chat_steps ORDER BY id`).all();
}

function seedPre033Database(path: string): void {
  const assets = trackedMigrationAssets().filter(
    (asset) => asset.filename !== MIGRATION_033 && asset.filename !== MIGRATION_034,
  );
  const filenames = assets.map((asset) => asset.filename);
  expect(filenames).toEqual(TRACKED_MIGRATION_FILENAMES.slice(0, 6));
  expect(filenames.at(-1)).toBe(MIGRATION_032);
  withDatabase(path, (db) => {
    createCanonicalLedger(db);
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of assets) {
      runMigration(db, migration, () => {
        validatedAppliedFilenames(db, filenames);
      });
    }
    seedSession(db, {
      id: SESSION_ID,
      ownerId: "u1",
      title: "legacy",
      status: "done",
      ompSessionFile: null,
      streamEpoch: 1,
      createdAt: 10,
      updatedAt: 20,
    });
    seedMessage(db, {
      sessionId: SESSION_ID,
      role: "user",
      content: "hi",
      status: "done",
      createdAt: 1,
    });
    seedMessage(db, {
      sessionId: SESSION_ID,
      role: "assistant",
      content: "ok",
      status: "done",
      createdAt: 2,
    });
    const insert = db.prepare(
      "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const step of PRE_033_STEPS) {
      insert.run(
        step.message_id,
        step.ordinal,
        step.name,
        step.detail,
        step.status,
        step.started_at,
        step.ended_at,
      );
    }
  });
}

describe("core/db chat step output migration", () => {
  it("six-receipt chat database gains output once, keeps prior step fields, and reads NULL as empty", () => {
    const file = join(tempDir(), "chat-step-output.db");
    seedPre033Database(file);
    const before = withDatabase(file, (db) => ({
      filenames: ledgerFilenames(db),
      steps: stepRows(db, "*"),
    }));
    expect(before.filenames).toEqual(TRACKED_MIGRATION_FILENAMES.slice(0, 6));
    expect(before.steps).toEqual(PRE_033_STEPS);

    withOpenDb(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(ledgerFilenames(db).filter((name) => name === MIGRATION_033)).toHaveLength(1);
      expect(stepRows(db, "*")).toEqual(PRE_033_STEPS.map((step) => ({ ...step, output: null })));
      const store = createSessionStore(db, { onFlushError: () => undefined });
      const tree = store.getMessages(SESSION_ID, "u1");
      expect(tree?.messages[1]?.steps.map((step) => [step.detail, step.output])).toEqual([
        ['{"output":"legacy end-overwritten"}', ""],
        ['{"path":"README.md"}', ""],
      ]);
      store.close();
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(stepRows(db, "*")).toEqual(PRE_033_STEPS.map((step) => ({ ...step, output: null })));
    });
  });
});
