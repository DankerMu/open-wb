/**
 * Issue #1018 undo of messages with attachments (s1g-composer-capabilities task 12.1; spec
 * message-attachments「带附件消息的撤回对位」): the branch alignment of an undo uses the same wire
 * candidates as regenerate and fork, so a message stored with attachments — and every message after
 * it — is aligned when its entry carries the attachment suffix, and is not when it does not. Undo is
 * requested over REST on the production assembly; the entry list is the scripted child's. The
 * scripted `branch` always answers QUESTION: a `draft` that is anything else is the stored text.
 *
 * Issue #1020 the attachments an undo hands back (task 12.6; spec message-undo「撤回 REST」
 * 「响应带回仍存在的附件」): the 200 is exactly `{session, draft, files, attachments}`, and
 * `attachments` is what the undone message stored, less the items that are no longer a regular
 * file inside the workspace once the undo (and its restore) is done. The second describe admits
 * its messages over the real prompt route, in a real workspace directory with real snapshots.
 */
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "./session-approval-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  A_PDF,
  A_PDF_STORED,
  A_PDF_SUFFIX,
  attach,
  FIRST,
  forkWorlds,
  messagesOf,
  openForkScripted,
} from "./session-fork-helpers.js";
import { count, held, QUESTION, scriptedAt, types } from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, postPrompt } from "./session-rest-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";
import {
  at,
  type FilesWorld,
  openFilesWorld,
  put,
  restoredBy,
  turnAt,
  undoWith,
} from "./session-undo-files-helpers.js";
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
function branchedTo(world: Pick<FilesWorld, "scripted">, index: number) {
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

const B_PNG = { path: "uploads/b.png", size: 1 };
/** The suffix omp was given for both paths, spelled out as `A_PDF_SUFFIX` is. */
const BOTH_SUFFIX = `${A_PDF_SUFFIX}\n- uploads/b.png`;

/**
 * u1 (FIRST, no attachment) → a1 → u2 (`message` with `paths`) → a2 over the real prompt route,
 * both undoable; `uploads/a.pdf` (3 bytes) and `uploads/b.png` (1 byte) are there before either
 * turn, so u2's snapshot holds both. Spawns: 0 the session's process, 1 the undo's temporary one,
 * which lists FIRST and then `u2Entry`.
 */
async function admitted(message: string, paths: string[], u2Entry: string) {
  const world = await openFilesWorld(worlds, [
    {},
    {
      messages: [
        { entryId: "e-1", text: FIRST },
        { entryId: "e-2", text: u2Entry },
      ],
    },
  ]);
  put(world, A_PDF.path, "pdf");
  put(world, B_PNG.path, "p");
  const u1 = await turnAt(world, 10, FIRST);
  at(20);
  const payload = JSON.stringify({ message, attachments: paths });
  const response = await postPrompt(world.fixture.app, world.session, world.cookie, payload);
  expect([response.statusCode, response.json()]).toEqual([
    202,
    expect.objectContaining({ undo: "available" }),
  ]);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
  at(30);
  return { world, u1, u2: (response.json() as { userMessageId: number }).userMessageId };
}

/** u2 is `QUESTION` with both files attached. */
function withBoth() {
  return admitted(QUESTION, [A_PDF.path, B_PNG.path], `${QUESTION}${BOTH_SUFFIX}`);
}

function rejections(world: FilesWorld): number {
  const sql = "SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'sandbox.reject'";
  return count(world.fixture.db, sql);
}

describe("the attachments an undo hands back (#1020)", () => {
  beforeEach(() => {
    // `Date` alone: the bare form would also freeze the timers the scripted runtime runs on.
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("响应带回仍存在的附件 keep: a deleted file is left out, a rewritten one keeps its stored size", async () => {
    const { world, u2 } = await withBoth();
    rmSync(join(world.root, B_PNG.path));
    put(world, A_PDF.path, "no longer three bytes");

    const body = undone(await undoWith(world, u2, "keep"));

    expect(body.attachments).toEqual([A_PDF]);
    expect(body.draft).toBe(QUESTION);
    expect(rejections(world)).toBe(0);
  });

  it("响应带回仍存在的附件 restore: the file the restore put back is handed back, in stored order", async () => {
    const { world, u2 } = await withBoth();
    rmSync(join(world.root, B_PNG.path));

    const body = restoredBy(await undoWith(world, u2, "restore"));

    expect(body.attachments).toEqual([A_PDF, B_PNG]);
    expect(body.files.restored).toBe(1);
    expect(rejections(world)).toBe(0);
  });

  it("响应带回仍存在的附件: a message stored without attachments hands back []", async () => {
    const { world, u1 } = await withBoth();

    const body = undone(await undoWith(world, u1, "keep"));

    expect(body.attachments).toEqual([]);
    expect(branchedTo(world, 1)).toEqual(["e-1"]);
    expect(rejections(world)).toBe(0);
  });

  it("响应带回仍存在的附件: a file swapped for a link to a real file outside is left out", async () => {
    const { world, u2 } = await withBoth();
    const outside = join(world.root, "..", "outside-1020.pdf");
    writeFileSync(outside, "pdf");
    rmSync(join(world.root, A_PDF.path));
    symlinkSync(outside, join(world.root, A_PDF.path));

    const body = undone(await undoWith(world, u2, "keep"));

    expect(body.attachments).toEqual([B_PNG]);
    expect(rejections(world)).toBe(0);
  });

  it("a directory on the way swapped for a link to itself: nothing under it is handed back", async () => {
    const { world, u2 } = await withBoth();
    renameSync(join(world.root, "uploads"), join(world.root, "moved"));
    symlinkSync(join(world.root, "moved"), join(world.root, "uploads"), "dir");

    const body = undone(await undoWith(world, u2, "keep"));

    expect(body.attachments).toEqual([]);
    expect(rejections(world)).toBe(0);
  });

  it("a file swapped for a directory of its name is left out", async () => {
    const { world, u2 } = await withBoth();
    rmSync(join(world.root, A_PDF.path));
    mkdirSync(join(world.root, A_PDF.path));

    const body = undone(await undoWith(world, u2, "keep"));

    expect(body.attachments).toEqual([B_PNG]);
    expect(rejections(world)).toBe(0);
  });

  it("a name only a read may carry (a backslash) is handed back: the resolution is a read", async () => {
    const name = { path: "uploads/a\\b.pdf", size: 2 };
    const entry = A_PDF_SUFFIX.replace(A_PDF.path, name.path);
    const world = await openFilesWorld(worlds, [
      {},
      { messages: [{ entryId: "e-1", text: entry }] },
    ]);
    put(world, name.path, "ab");
    at(10);
    const payload = JSON.stringify({ message: "", attachments: [name.path] });
    const response = await postPrompt(world.fixture.app, world.session, world.cookie, payload);
    expect(response.statusCode).toBe(202);
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    const u1 = (response.json() as { userMessageId: number }).userMessageId;

    const body = undone(await undoWith(world, u1, "keep"));

    expect(body.attachments).toEqual([name]);
    expect(rejections(world)).toBe(0);
  });

  it("只有附件的消息: draft is the empty string, the attachment is handed back, the suffix entry aligned", async () => {
    const { world, u2 } = await admitted("", [A_PDF.path], A_PDF_SUFFIX);

    const body = undone(await undoWith(world, u2, "keep"));

    expect(body.draft).toBe("");
    expect(body.attachments).toEqual([A_PDF]);
    expect(branchedTo(world, 1)).toEqual(["e-2"]);
    expect(rejections(world)).toBe(0);
  });
});
