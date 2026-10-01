/**
 * Issue #555 branch alignment for slash text (parent s1c-session-metadata-presentation tasks
 * 10.4b, design D15; chat-sessions Scenario「Command-anchored regenerate and fork」). Regenerate and
 * fork are requested over REST on the production createApp → registerSessions assembly; the omp
 * side is a real fake-omp `branch` child whose list is the fixed two entries plus `--branch-entry`
 * values, and one scripted FakeChild for a malformed list. Histories are written through the store
 * (no spawn); skills are real `SKILL.md` files under `ompAgentDir(stateDir)/skills`. Oracles:
 * status and envelope, SQL rows and counts, per-child stdin frames, the spawn log, liveness, the
 * control claim and the `readdirSync` calls naming `<agentDir>/skills`.
 */
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { BAD_REQUEST_ENVELOPE } from "./session-db-helpers.js";
import {
  FIRST,
  forkWorlds,
  listedIds,
  messagesOf,
  openForkScripted,
  openForkWorld,
  realSource,
  rowCounts,
  seedTwoTurns,
} from "./session-fork-helpers.js";
import { held, QUESTION, scriptedAt, snapshot, types } from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { OWNER_ID, type RecordingWorld, waitForTurn } from "./session-supervisor-helpers.js";
import { isLive, presetSessionFile } from "./session-supervisor-pool-helpers.js";

const SKILL = "weekly-report";
const SKILL_CALL = "/skill:weekly-report 写周报";
const HELP = "/help 这是什么";
/** The entry the fake appends for the first `--branch-entry` (after its fixed two). */
const APPENDED = "fake-entry-3";

type ForkWorld = Awaited<ReturnType<typeof openForkWorld>>;
type Reply = LightMyRequestResponse;

const worlds = forkWorlds();

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

async function openWorld(options: { entries?: string[]; skill?: boolean } = {}) {
  const world = worlds.track(await openForkWorld({ entries: options.entries ?? [] }));
  if (options.skill === true) {
    installSkill(world.rt.runtime.stateDir);
  }
  return world;
}

function skillsDirOf(stateDir: string): string {
  return join(ompAgentDir(stateDir), "skills");
}

function installSkill(stateDir: string): void {
  const dir = join(skillsDirOf(stateDir), SKILL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: 生成一份周报\n---\n正文\n`,
  );
}

/**
 * One settled turn per text, written through the store (no spawn, so the first child is the
 * request's own), then a real resume file. Returns the user message ids in order.
 */
function seedTurns(world: RecordingWorld, texts: readonly string[]) {
  const { store, db } = world.fixture;
  const users = texts.map((text) => {
    const admitted = store.acceptPrompt(world.session, OWNER_ID, text);
    store.finishTurn(admitted.assistantMessageId, "done");
    return admitted.userMessageId;
  });
  const source = realSource();
  presetSessionFile(db, world.session, source.file);
  return { users, last: users.at(-1) ?? -1, unchanged: source.unchanged };
}

function postRegenerate(world: RecordingWorld): Promise<Reply> {
  return postSessionAction(world.fixture.app, "regenerate", world.session, world.cookie);
}

function postFork(world: RecordingWorld, messageId: number): Promise<Reply> {
  return postSessionAction(world.fixture.app, "fork", world.session, world.cookie, {
    name: "fork at a message",
    payload: JSON.stringify({ messageId }),
    contentType: "application/json",
  });
}

function userTexts(world: RecordingWorld, session = world.session): string[] {
  return messagesOf(world.fixture.db, session)
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}

/** The source's rows (epoch included), every table's count and the listed sessions. */
async function baselineOf(world: RecordingWorld) {
  const { db } = world.fixture;
  return {
    source: snapshot(db, world.session, true),
    rows: rowCounts(db),
    listed: await listedIds(world),
  };
}

/** A refusal before any process: `status`, then no spawn, no child, no row change, no claim. */
async function expectRefused(
  world: ForkWorld,
  request: () => Promise<Reply>,
  status: number,
  envelope: object,
): Promise<void> {
  const before = await baselineOf(world);

  expectEnvelope(await request(), status, envelope);
  await settle();

  expect(world.rt.calls).toHaveLength(0);
  expect(world.spawned).toHaveLength(0);
  expect(await baselineOf(world)).toEqual(before);
  expect(held(world)).toBe(false);
}

/** A fork that found no aligned entry: 502, the list was read, no `branch`, nothing written. */
async function expectUnaligned(world: ForkWorld, messageId: number): Promise<void> {
  const before = await baselineOf(world);

  expectEnvelope(await postFork(world, messageId), 502, AGENT_UNAVAILABLE_ENVELOPE);

  const temp = spawnedAt(world, 0);
  expect(types(temp.stdin)).toContain("get_branch_messages");
  expect(types(temp.stdin)).not.toContain("branch");
  expect(isLive(temp.child)).toBe(false);
  expect(world.rt.calls).toHaveLength(1);
  expect(await baselineOf(world)).toEqual(before);
  expect(held(world)).toBe(false);
}

/**
 * A fork at the last seeded user message that succeeds: 201, one new session holding the earlier
 * history, the temporary child gone. Returns the draft and the entry the `branch` frame named.
 */
async function forkAtLast(world: ForkWorld, texts: readonly string[]) {
  const seeded = seedTurns(world, texts);
  const rows = rowCounts(world.fixture.db);
  const source = snapshot(world.fixture.db, world.session, true);

  const response = await postFork(world, seeded.last);

  expect([response.statusCode, response.headers["cache-control"]]).toEqual([201, "no-store"]);
  const body = response.json<{ session: { id: string }; draft: string }>();
  const temp = spawnedAt(world, 0);
  expect(isLive(temp.child)).toBe(false);
  expect(rowCounts(world.fixture.db).sessions).toBe(rows.sessions + 1);
  expect(userTexts(world, body.session.id)).toEqual(texts.slice(0, -1));
  expect(snapshot(world.fixture.db, world.session, true)).toEqual(source);
  seeded.unchanged();
  expect(held(world)).toBe(false);
  const branches = temp.stdin.filter((frame) => frame.type === "branch");
  expect(branches).toHaveLength(1);
  return { seeded, draft: body.draft, entryId: branches[0]?.entryId };
}

/** `readdirSync` call-through spy; returns how often `<agentDir>/skills` was enumerated so far. */
function spySkillScans(world: ForkWorld): () => number {
  const skillsDir = skillsDirOf(world.rt.runtime.stateDir);
  const spy = vi.spyOn(fs, "readdirSync");
  syncBuiltinESMExports();
  return () => spy.mock.calls.filter(([path]) => String(path) === skillsDir).length;
}

describe("regenerate at slash text (#555)", () => {
  it(
    "E5 a `/todo` last user message is 400 before any spawn, frame, row or claim",
    REAL,
    async () => {
      const world = await openWorld();
      seedTurns(world, ["/todo"]);

      await expectRefused(world, () => postRegenerate(world), 400, BAD_REQUEST_ENVELOPE);
    },
  );

  it("E5 an installed skill invocation as the last user message is 400", REAL, async () => {
    const world = await openWorld({ skill: true });
    seedTurns(world, [SKILL_CALL]);

    await expectRefused(world, () => postRegenerate(world), 400, BAD_REQUEST_ENVELOPE);
  });

  it(
    "E5 the same text with the skill not installed is plain: the last pair differs, 502",
    REAL,
    async () => {
      const world = await openWorld();
      const { db } = world.fixture;
      seedTurns(world, [SKILL_CALL]);
      const before = snapshot(db, world.session);
      const rows = rowCounts(db);

      expectEnvelope(await postRegenerate(world), 502, AGENT_UNAVAILABLE_ENVELOPE);

      const child = spawnedAt(world, 0);
      expect(types(child.stdin)).toContain("get_branch_messages");
      expect(types(child.stdin)).not.toContain("branch");
      expect(snapshot(db, world.session)).toEqual(before);
      expect(rowCounts(db)).toEqual(rows);
      expect(held(world)).toBe(false);
    },
  );

  it(
    "E7 an escaped last message matches its wire-form entry: 202, dispatched as branched",
    REAL,
    async () => {
      const world = await openWorld({ entries: [` ${HELP}`] });
      seedTurns(world, ["/todo", HELP]);

      const response = await postRegenerate(world);

      expect(response.statusCode).toBe(202);
      const { assistantMessageId } = response.json<{ assistantMessageId: number }>();
      const ended = await waitForTurn(world.fixture, world.session, "done");
      expect(ended.messages.at(-1)?.id).toBe(assistantMessageId);
      const frames = spawnedAt(world, 0).stdin.slice(2);
      expect(types(frames)).toEqual(["get_branch_messages", "branch", "get_state", "prompt"]);
      expect(frames[1]).toMatchObject({ type: "branch", entryId: APPENDED });
      expect(frames[3]).toMatchObject({ type: "prompt", message: ` ${HELP}` });
      expect(userTexts(world)).toEqual(["/todo", HELP]);
    },
  );
});

describe("the busy check precedes the command check (#555)", () => {
  it(
    "E6 a running session whose last user message is `/todo`: regenerate and fork are 409",
    REAL,
    async () => {
      const world = await openWorld();
      const running = world.fixture.store.acceptPrompt(world.session, OWNER_ID, "/todo");

      await expectRefused(world, () => postRegenerate(world), 409, SESSION_BUSY_ENVELOPE);
      await expectRefused(
        world,
        () => postFork(world, running.userMessageId),
        409,
        SESSION_BUSY_ENVELOPE,
      );
    },
  );
});

describe("fork at slash text (#555)", () => {
  it(
    "E8 an installed skill invocation as the anchor is 400 before any spawn, frame or row",
    REAL,
    async () => {
      const world = await openWorld({ skill: true });
      const seeded = seedTurns(world, [FIRST, QUESTION, SKILL_CALL]);

      await expectRefused(world, () => postFork(world, seeded.last), 400, BAD_REQUEST_ENVELOPE);
      seeded.unchanged();
    },
  );

  it(
    "E8 the same anchor with the skill not installed is aligned instead: no entry, 502",
    REAL,
    async () => {
      const world = await openWorld();
      const seeded = seedTurns(world, [FIRST, QUESTION, SKILL_CALL]);

      await expectUnaligned(world, seeded.last);
      seeded.unchanged();
    },
  );

  it(
    "E9 `/todo` consumed no entry: the next message aligns to the appended entry",
    REAL,
    async () => {
      const world = await openWorld({ entries: ["继续"] });
      const scans = spySkillScans(world);

      const forked = await forkAtLast(world, [FIRST, QUESTION, "/todo", "继续"]);

      expect(forked.draft).toBe("继续");
      expect(forked.entryId).toBe(APPENDED);
      // The anchor does not start with `/`: its precheck never lists the skills directory.
      expect(scans()).toBe(0);
      // Positive control: the same spy sees the scan a `/`-prefixed anchor's precheck needs.
      expectEnvelope(
        await postFork(world, forked.seeded.users[2] ?? -1),
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expect(scans()).toBe(1);
    },
  );

  it("E10 a message stored before escaping aligns to its verbatim entry", REAL, async () => {
    const world = await openWorld({ entries: ["/legacy"] });

    const forked = await forkAtLast(world, [FIRST, QUESTION, "/legacy"]);

    expect(forked.draft).toBe("/legacy");
    expect(forked.entryId).toBe(APPENDED);
  });

  it(
    "E11 an escaped message aligns to its wire-form entry; the draft carries no space",
    REAL,
    async () => {
      const world = await openWorld({ entries: [` ${HELP}`] });

      const forked = await forkAtLast(world, [FIRST, QUESTION, HELP]);

      expect(forked.draft).toBe(HELP);
      expect(forked.entryId).toBe(APPENDED);
    },
  );

  it("E12 a mid-prompt skill invocation left no entry and is no command: 502", REAL, async () => {
    const world = await openWorld({ skill: true });
    const seeded = seedTurns(world, [FIRST, QUESTION, "今天 /skill:weekly-report 帮我"]);

    await expectUnaligned(world, seeded.last);
    seeded.unchanged();
  });

  it(
    "E13 a skill installed after its text was sent escaped does not move the alignment",
    REAL,
    async () => {
      const world = await openWorld({ entries: [` ${SKILL_CALL}`, "继续"], skill: true });

      const forked = await forkAtLast(world, [FIRST, QUESTION, SKILL_CALL, "继续"]);

      expect(forked.draft).toBe("继续");
      expect(forked.entryId).toBe("fake-entry-4");
    },
  );

  it("E14 a malformed entry matches nothing and is never skipped: 502 without `branch`", async () => {
    const world = await openForkScripted(worlds, [
      {
        messages: [
          { entryId: "e1", text: 5 },
          { entryId: "e2", text: QUESTION },
        ],
      },
    ]);
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);
    const before = snapshot(db, world.session, true);
    const rows = rowCounts(db);

    expectEnvelope(await postFork(world, seeded.u2), 502, AGENT_UNAVAILABLE_ENVELOPE);

    const frames = types(scriptedAt(world.scripted, 0).frames);
    expect(frames).toContain("get_branch_messages");
    expect(frames).not.toContain("branch");
    expect(world.errors).toEqual([]);
    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(rowCounts(db)).toEqual(rows);
    seeded.unchanged();
    expect(held(world)).toBe(false);
  });
});
