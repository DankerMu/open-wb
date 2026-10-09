/**
 * Issue #1018 undo of messages with attachments (s1g-composer-capabilities task 12.1; spec
 * message-attachments「带附件消息的撤回对位」): the branch alignment of an undo uses the same wire
 * candidates as regenerate and fork, so a message stored with attachments — and every message after
 * it — is aligned when its entry carries the attachment suffix, and is not when it does not. Undo is
 * requested over REST on the production assembly; the entry list is the scripted child's. The
 * scripted `branch` always answers QUESTION: a `draft` that is anything else is the stored text.
 *
 * The `attachments` key of the undo response is #1020's: the body here is still exactly
 * `{session, draft, files}`.
 */
import { describe, expect, it } from "vitest";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  A_PDF_STORED,
  A_PDF_SUFFIX,
  attach,
  FIRST,
  forkWorlds,
  messagesOf,
  openForkScripted,
} from "./session-fork-helpers.js";
import { held, QUESTION, scriptedAt, types } from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import { observed, postUndo, seedUndoable, undone } from "./session-undo-helpers.js";

const worlds = forkWorlds();

/**
 * u1 (FIRST, or `content`) → a1 → u2 (QUESTION) → a2, both undoable, u1 storing `uploads/a.pdf`;
 * the temporary process lists `u1Entry` and then QUESTION.
 */
async function attached(u1Entry: string, content?: string) {
  const world = await openForkScripted(worlds, [
    {
      messages: [
        { entryId: "e-1", text: u1Entry },
        { entryId: "e-2", text: QUESTION },
      ],
    },
  ]);
  const seeded = seedUndoable(world);
  attach(world.fixture.db, seeded.u1, content);
  return { world, seeded };
}

/** The entry ids the n-th spawned process was asked to branch to. */
function branchedTo(world: Awaited<ReturnType<typeof attached>>["world"], index: number) {
  return scriptedAt(world.scripted, index)
    .frames.filter((frame) => frame.type === "branch")
    .map((frame) => frame.entryId);
}

describe("undo alignment of messages with attachments (#1018)", () => {
  it.each([
    ["the text followed by the suffix", undefined, `${FIRST}${A_PDF_SUFFIX}`, FIRST],
    [
      "escaped `/` text followed by the suffix",
      "/etc/hosts 是什么",
      ` /etc/hosts 是什么${A_PDF_SUFFIX}`,
      "/etc/hosts 是什么",
    ],
    ["no text: the suffix alone", "", A_PDF_SUFFIX, ""],
  ])(
    "带附件消息的撤回对位: u1's entry is %s — u2 and u1 are each undone",
    async (_n, content, entry, draft) => {
      const later = await attached(entry, content);
      const u1Row = () =>
        later.world.fixture.db
          .prepare("SELECT content, attachments FROM chat_messages WHERE id = ?")
          .get(later.seeded.u1);
      const stored = u1Row();
      expect(stored).toEqual({ content: draft, attachments: A_PDF_STORED });

      const second = undone(await postUndo(later.world, later.seeded.u2));

      expect(second.draft).toBe(QUESTION);
      expect(branchedTo(later.world, 0)).toEqual(["e-2"]);
      expect(messagesOf(later.world.fixture.db, later.world.session).map((m) => m.id)).toEqual([
        later.seeded.u1,
        later.seeded.a1,
      ]);
      expect(u1Row()).toEqual(stored);

      const own = await attached(entry, content);

      const first = undone(await postUndo(own.world, own.seeded.u1));

      expect(first.draft).toBe(draft);
      expect(branchedTo(own.world, 0)).toEqual(["e-1"]);
      expect(messagesOf(own.world.fixture.db, own.world.session)).toEqual([]);
    },
  );

  it.each([
    ["the text alone", undefined, FIRST],
    ["the suffix without its two leading newlines", "", A_PDF_SUFFIX.slice(2)],
  ])(
    "u1's entry is %s: undo of u2 and of u1 are both 502 with nothing changed",
    async (_n, content, entry) => {
      const { world, seeded } = await attached(entry, content);
      // The trap this case must not fall into: with equal texts u2 would take u1's entry and be 200.
      expect(messagesOf(world.fixture.db, world.session)[0]?.content).not.toBe(QUESTION);

      for (const target of [seeded.u2, seeded.u1]) {
        const before = observed(world);

        expectEnvelope(await postUndo(world, target), 502, AGENT_UNAVAILABLE_ENVELOPE);

        const frames = types(scriptedAt(world.scripted, before.spawns).frames);
        expect(frames).toContain("get_branch_messages");
        expect(frames).not.toContain("branch");
        expect(observed(world)).toEqual({ ...before, spawns: before.spawns + 1 });
        expect(held(world)).toBe(false);
      }
      seeded.unchanged();
    },
  );
});
