/**
 * Issue #464 R20: SessionStore approval settlement fails closed without an injected audit emit.
 * Store-level through the public createSessionStore entry over real SQLite; the positive control
 * is a second store on the same DB given core/audit's emit. Values are fixture literals.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";

const T = 1_700_000_000_000;
const TITLE = "Allow tool: bash\nCommand: echo workbuddy-smoke";

function pendingIn(store: SessionStore) {
  const session = store.create("u1").id;
  const accepted = store.acceptPrompt(session, "u1", "run the tool");
  const pending = store.insertApproval(session, { requestId: "r1", tool: "bash", title: TITLE }, T);
  return { session, accepted, pending };
}

function decisionOf(db: DatabaseSync, id: number) {
  return db.prepare("SELECT decision, decided_at FROM chat_approvals WHERE id = ?").get(id) as {
    decision: string | null;
    decided_at: number | null;
  };
}

function approvalAudits(db: DatabaseSync) {
  return db
    .prepare("SELECT actor_id, title, detail FROM audit_events WHERE kind = 'session.approval'")
    .all();
}

describe("SessionStore approval settlement", () => {
  it("R20 settles only with an audit emit; without one it throws and writes nothing", () => {
    const db = openDb(":memory:");
    try {
      const bare = createSessionStore(db, { onFlushError() {}, composer: TEST_COMPOSER });
      const first = pendingIn(bare);
      expect(first.pending).toStrictEqual({
        approvalId: expect.any(Number),
        messageId: first.accepted.assistantMessageId,
        expiresAt: T + 60_000,
      });

      expect(() =>
        bare.settleApproval(first.session, first.pending.approvalId, "allow", T + 1),
      ).toThrow();
      expect(decisionOf(db, first.pending.approvalId)).toEqual({
        decision: null,
        decided_at: null,
      });
      expect(approvalAudits(db)).toEqual([]);

      const audited = createSessionStore(db, { onFlushError() {}, emit, composer: TEST_COMPOSER });
      const second = pendingIn(audited);
      expect(
        audited.settleApproval(second.session, second.pending.approvalId, "allow", T + 1),
      ).toStrictEqual({
        id: second.pending.approvalId,
        tool: "bash",
        title: TITLE,
        requestedAt: T,
        expiresAt: T + 60_000,
        decision: "allow",
      });
      expect(decisionOf(db, second.pending.approvalId)).toEqual({
        decision: "allow",
        decided_at: T + 1,
      });
      expect(approvalAudits(db)).toEqual([
        {
          actor_id: "u1",
          title: "工具执行审批",
          detail: JSON.stringify({
            sessionId: second.session,
            messageId: second.accepted.assistantMessageId,
            tool: "bash",
            decision: "allow",
          }),
        },
      ]);
    } finally {
      db.close();
    }
  });
});
