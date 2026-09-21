import { constants } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  captureThrown,
  expectHttpError,
  FIXED_NOW,
  HEX32,
  messageRows,
  persistenceSnapshot,
  sessionRow,
  withFakeClock,
  withSessionStore,
} from "./session-store-helpers.js";

describe("SessionStore owner-scoped persisted views", () => {
  it("returns only ordered declared DTO fields and hides foreign message trees", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ store }) => {
        const oldest = store.create("u1");
        const foreign = store.create("u2");
        vi.setSystemTime(FIXED_NOW + 10);
        const firstTie = store.create("u1");
        const secondTie = store.create("u1");

        const tied = [firstTie, secondTie].toSorted((left, right) =>
          left.id.localeCompare(right.id),
        );
        expect(store.list("u1")).toEqual([...tied, oldest]);
        expect(store.list("u2")).toEqual([foreign]);
        expect(oldest).toEqual({
          id: oldest.id,
          title: null,
          status: "idle",
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        });
        expect(oldest.id).toMatch(HEX32);
        expect(new Set([oldest.id, foreign.id, firstTie.id, secondTie.id]).size).toBe(4);

        vi.setSystemTime(FIXED_NOW + 20);
        const accepted = store.acceptPrompt(oldest.id, "u1", "owner-visible prompt");
        vi.setSystemTime(FIXED_NOW + 21);
        const secondStepId = store.startStep(accepted.assistantMessageId, {
          ordinal: 2,
          name: "later work",
          detail: "queued second",
        });
        vi.setSystemTime(FIXED_NOW + 22);
        const firstStepId = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "first work",
          detail: "queued first",
        });

        expect(store.getMessages(oldest.id, "u1")).toEqual({
          session: {
            id: oldest.id,
            title: "owner-visible prom",
            status: "running",
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW + 20,
          },
          messages: [
            {
              id: accepted.userMessageId,
              role: "user",
              content: "owner-visible prompt",
              status: "done",
              createdAt: FIXED_NOW + 20,
              steps: [],
            },
            {
              id: accepted.assistantMessageId,
              role: "assistant",
              content: "",
              status: "running",
              createdAt: FIXED_NOW + 20,
              steps: [
                {
                  id: firstStepId,
                  ordinal: 0,
                  name: "first work",
                  detail: "queued first",
                  status: "running",
                  startedAt: FIXED_NOW + 22,
                  endedAt: null,
                },
                {
                  id: secondStepId,
                  ordinal: 2,
                  name: "later work",
                  detail: "queued second",
                  status: "running",
                  startedAt: FIXED_NOW + 21,
                  endedAt: null,
                },
              ],
            },
          ],
        });
        expect(store.getMessages(oldest.id, "u2")).toBeNull();
        expect(store.getMessages("f".repeat(32), "u1")).toBeNull();
      });
    });
  });
});

describe("SessionStore admission, metadata, and compensation", () => {
  it("keeps epoch and resume metadata independent while rollback restores an unprogressed pair", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const prompt = `${"😀".repeat(18)} after the title boundary`;
        vi.setSystemTime(FIXED_NOW + 1);
        const accepted = store.acceptPrompt(session.id, "u1", prompt);

        expect(store.runtimeState(session.id)).toEqual({
          ownerId: "u1",
          ompSessionFile: null,
          streamEpoch: 0,
          activeTurn: accepted,
        });
        expect(sessionRow(db, session.id)).toMatchObject({
          title: "😀".repeat(18),
          status: "running",
          stream_epoch: 0,
          omp_session_file: null,
          updated_at: FIXED_NOW + 1,
        });
        expect(store.bumpStreamEpoch(session.id)).toBe(1);
        store.setSessionFile(session.id, "resume/turn.jsonl");

        expect(store.rollbackPrompt(accepted.assistantMessageId)).toBe(true);
        expect(sessionRow(db, session.id)).toEqual({
          id: session.id,
          owner_id: "u1",
          title: null,
          status: "idle",
          omp_session_file: "resume/turn.jsonl",
          stream_epoch: 1,
          created_at: FIXED_NOW,
          updated_at: FIXED_NOW,
        });
        expect(messageRows(db)).toEqual([]);
        expect(store.runtimeState(session.id)).toEqual({
          ownerId: "u1",
          ompSessionFile: "resume/turn.jsonl",
          streamEpoch: 1,
          activeTurn: null,
        });
        expect(store.rollbackPrompt(accepted.assistantMessageId)).toBe(false);
      });
    });
  });

  it("does not disclose a busy foreign session and leaves both rejected admissions unchanged", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "first prompt");
        const before = persistenceSnapshot(db);

        expectHttpError(() => store.acceptPrompt(session.id, "u2", "foreign probe"), "not_found");
        expect(persistenceSnapshot(db)).toEqual(before);
        expectHttpError(
          () => store.acceptPrompt(session.id, "u1", "second prompt"),
          "session_busy",
        );
        expect(persistenceSnapshot(db)).toEqual(before);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("rolls back ignored and raising admission writes before a later valid admission", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const before = persistenceSnapshot(db);

        db.exec(`CREATE TEMP TRIGGER ignore_prompt_messages
          BEFORE INSERT ON chat_messages
          BEGIN SELECT RAISE(IGNORE); END`);
        expect(captureThrown(() => store.acceptPrompt(session.id, "u1", "ignored"))).toBeInstanceOf(
          Error,
        );
        expect(persistenceSnapshot(db)).toEqual(before);
        db.exec("DROP TRIGGER ignore_prompt_messages");

        db.exec(`CREATE TEMP TRIGGER abort_prompt_session
          BEFORE UPDATE OF status ON chat_sessions
          WHEN NEW.id = '${session.id}' AND NEW.status = 'running'
          BEGIN SELECT RAISE(ABORT, 'session write denied'); END`);
        const raised = captureThrown(() => store.acceptPrompt(session.id, "u1", "raising"));
        expect(raised).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(String((raised as Error).message)).toContain("session write denied");
        expect(persistenceSnapshot(db)).toEqual(before);
        db.exec("DROP TRIGGER abort_prompt_session");

        const accepted = store.acceptPrompt(session.id, "u1", "committed after faults");
        expect(messageRows(db).map((message) => message.content)).toEqual([
          "committed after faults",
          "",
        ]);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("rolls back a denied commit without retaining an active turn, then accepts after recovery", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const before = persistenceSnapshot(db);
        db.setAuthorizer((actionCode, arg1) =>
          actionCode === constants.SQLITE_TRANSACTION && arg1 === "COMMIT"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
        try {
          const error = captureThrown(() => store.acceptPrompt(session.id, "u1", "commit denied"));
          expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR" });
          expect(persistenceSnapshot(db)).toEqual(before);
          expect(db.isTransaction).toBe(false);
        } finally {
          db.setAuthorizer(null);
        }

        const accepted = store.acceptPrompt(session.id, "u1", "commit repaired");
        expect(store.runtimeState(session.id)?.activeTurn).toEqual(accepted);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("leaves a caller-owned transaction and metadata untouched before accepting after rollback", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").run(
            "caller marker",
            session.id,
          );
          expect(
            captureThrown(() => store.acceptPrompt(session.id, "u1", "inside caller transaction")),
          ).toBeInstanceOf(Error);
          expect(captureThrown(() => store.bumpStreamEpoch(session.id))).toBeInstanceOf(Error);
          expect(
            captureThrown(() => store.setSessionFile(session.id, "caller-unsafe.jsonl")),
          ).toBeInstanceOf(Error);
          expect(db.isTransaction).toBe(true);
          expect(sessionRow(db, session.id)).toMatchObject({
            title: "caller marker",
            stream_epoch: 0,
            omp_session_file: null,
          });
          expect(messageRows(db)).toEqual([]);
        } finally {
          db.exec("ROLLBACK");
        }

        expect(sessionRow(db, session.id)).toMatchObject({
          title: null,
          stream_epoch: 0,
          omp_session_file: null,
        });
        expect(store.bumpStreamEpoch(session.id)).toBe(1);
        store.setSessionFile(session.id, "recovered.jsonl");
        const accepted = store.acceptPrompt(session.id, "u1", "outside caller transaction");
        expect(store.runtimeState(session.id)).toEqual({
          ownerId: "u1",
          ompSessionFile: "recovered.jsonl",
          streamEpoch: 1,
          activeTurn: accepted,
        });
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });
});
