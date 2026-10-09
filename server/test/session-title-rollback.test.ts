/**
 * Issue #524 (parent s1c-session-metadata-presentation tasks 4.2, design D2 "重命名与
 * `rollbackPrompt`"): a `PATCH /api/sessions/:id` title write survives prompt compensation, and
 * PATCH works while a turn is running. Every world is the production createApp → registerSessions
 * assembly over a controlled fake child, driven through `app.inject()` on real in-memory SQLite.
 * The compensation cases hold the prompt frame write (`holdNextPromptWrite`), PATCH during the
 * hold, then release it into a failed prompt receipt (`success:false`) before any turn progress:
 * the supervisor rejects with `agent_unavailable`, the route rolls the accepted pair back and
 * answers 502. Oracles: response status/headers/bytes and `chat_sessions`/`chat_messages` rows.
 *
 * Issue #1019 (chat-sessions「Attachment-only admission titles from the first file name」): the last
 * describe drives `store.acceptPrompt` itself on a bare store — the prompt route does not pass
 * attachments yet — and reads the rows the admission and its rollback leave.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, postPrompt } from "./session-rest-helpers.js";
import { withSessionStore } from "./session-store-helpers.js";
import {
  closeOnEof,
  completeHeldTurn,
  createControlledRuntime,
  openBareSession,
  openHeldPromptSession,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { holdNextPromptWrite, observePromise } from "./support/omp-rpc.js";

/** 23 code points; the admission title is its first 18 (`store.ts` titlePrefix). */
const PROMPT_TEXT = "请帮我整理一下本季度的销售数据并生成汇报材料";
const PROMPT_PREFIX = "请帮我整理一下本季度的销售数据并生成";
const FOURTEEN_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
  "archivedAt",
  "pendingApproval",
  "temporaryWorkspace",
  "approvalMode",
  "modelId",
  "reasoningEffort",
];

const fixtures: SupervisorApp[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

interface MetadataRow {
  title: string | null;
  status: string;
  updated_at: number;
  scene: string | null;
  pinned_at: number | null;
}

interface FailingWorld {
  fixture: SupervisorApp;
  cookie: string;
  session: string;
  held(): Promise<{ release(): void }>;
}

function metadataRow(db: DatabaseSync, id: string): MetadataRow {
  return db
    .prepare("SELECT title, status, updated_at, scene, pinned_at FROM chat_sessions WHERE id = ?")
    .get(id) as unknown as MetadataRow;
}

function sessionMessageCount(db: DatabaseSync, id: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?")
    .get(id) as { n: number };
  return Number(row.n);
}

function patch(
  fixture: SupervisorApp,
  cookie: string,
  session: string,
  body: object,
): Promise<LightMyRequestResponse> {
  return fixture.app.inject({
    method: "PATCH",
    url: `/api/sessions/${session}`,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(body),
  });
}

async function expectPatched(response: Promise<LightMyRequestResponse>) {
  const settled = await response;
  expect(settled.statusCode).toBe(200);
  expect(settled.headers["cache-control"]).toBe("no-store");
  const view = settled.json() as { title: string | null; scene: string | null; status: string };
  expect(Object.keys(view)).toEqual(FOURTEEN_KEYS);
  return view;
}

/** A world whose first prompt frame write is held and then answered with a failed receipt. */
async function openFailingPromptWorld(): Promise<FailingWorld> {
  let hold: { entered: Promise<void>; release(): void } | undefined;
  const runtime = createControlledRuntime((child) => {
    hold = holdNextPromptWrite(child);
    closeOnEof(child);
    child.onCommand("prompt", (frame) => {
      child.emitLine({ id: frame.id, type: "response", command: "prompt", success: false });
    });
  });
  const { fixture, cookie, session } = await openBareSession(runtime.runtime);
  fixtures.push(fixture);
  return {
    fixture,
    cookie,
    session,
    async held() {
      const armed = await waitFor(() => hold, "prompt-write hold armed");
      await armed.entered;
      return armed;
    },
  };
}

/**
 * Snapshot → admit → hold (admission wrote running + prefix/kept title) → PATCHes → release into
 * the failed receipt → 502 with the accepted pair removed and status/updatedAt restored.
 */
async function compensate(world: FailingWorld, during: object[]): Promise<MetadataRow> {
  const { fixture, cookie, session } = world;
  const admitted = metadataRow(fixture.db, session);
  const pending = postPrompt(
    fixture.app,
    session,
    cookie,
    JSON.stringify({ message: PROMPT_TEXT }),
  );
  const observation = observePromise(pending);
  const held = await world.held();
  const running = metadataRow(fixture.db, session);
  expect(running.status).toBe("running");
  expect(running.title).toBe(admitted.title ?? PROMPT_PREFIX);
  expect(sessionMessageCount(fixture.db, session)).toBe(2);
  for (const body of during) {
    await expectPatched(patch(fixture, cookie, session, body));
  }
  expect(observation.outcome).toBe("pending");
  held.release();
  expectEnvelope(await pending, 502, AGENT_UNAVAILABLE_ENVELOPE);
  const after = metadataRow(fixture.db, session);
  expect(sessionMessageCount(fixture.db, session)).toBe(0);
  expect({ status: after.status, updated_at: after.updated_at }).toEqual({
    status: admitted.status,
    updated_at: admitted.updated_at,
  });
  return after;
}

/** Pre-admission PATCHes (non-NULL scene and pin make "unchanged" observable); the row after. */
async function preset(world: FailingWorld, bodies: object[]): Promise<MetadataRow> {
  for (const body of bodies) {
    await expectPatched(patch(world.fixture, world.cookie, world.session, body));
  }
  const row = metadataRow(world.fixture.db, world.session);
  expect(row.scene).toBe("office");
  expect(row.pinned_at).toEqual(expect.any(Number));
  return row;
}

const PRESET = { scene: "office", pinned: true };

describe("prompt compensation keeps a PATCHed title", { timeout: 15_000 }, () => {
  it("8a a title PATCHed during the held admission survives the rollback", async () => {
    const world = await openFailingPromptWorld();
    expect(metadataRow(world.fixture.db, world.session).title).toBeNull();

    const after = await compensate(world, [{ title: "季度汇报" }]);

    expect(after).toMatchObject({ title: "季度汇报", scene: null, pinned_at: null });
  });

  it("8b without a PATCH the admission prefix is restored to NULL", async () => {
    const world = await openFailingPromptWorld();
    const before = await preset(world, [PRESET]);
    expect(before.title).toBeNull();

    const after = await compensate(world, []);

    expect(after).toMatchObject({ title: null, scene: "office", pinned_at: before.pinned_at });
  });

  it("8c a session titled before admission keeps its title after the rollback", async () => {
    const world = await openFailingPromptWorld();
    const before = await preset(world, [PRESET, { title: "季度汇报" }]);
    expect(before.title).toBe("季度汇报");

    const after = await compensate(world, []);

    expect(after).toMatchObject({
      title: "季度汇报",
      scene: "office",
      pinned_at: before.pinned_at,
    });
  });

  it("8d a rename during the held admission beats the pre-admission title", async () => {
    const world = await openFailingPromptWorld();
    const before = await preset(world, [PRESET, { title: "旧名" }]);

    const after = await compensate(world, [{ title: "新名" }]);

    expect(after).toMatchObject({ title: "新名", scene: "office", pinned_at: before.pinned_at });
  });

  it("8e a scene/pin-only PATCH during the hold still lets the prefix fall back to NULL", async () => {
    const world = await openFailingPromptWorld();
    const before = Date.now();

    const after = await compensate(world, [{ scene: "code", pinned: true }]);

    expect(after.title).toBeNull();
    expect(after.scene).toBe("code");
    expect(after.pinned_at).toBeGreaterThanOrEqual(before);
    expect(after.pinned_at).toBeLessThanOrEqual(Date.now());
  });
});

describe("PATCH while a turn is running", { timeout: 15_000 }, () => {
  it("E2 writes title, scene and pin at once and the finished turn keeps them", async () => {
    const opened = await openHeldPromptSession("held turn");
    fixtures.push(opened.fixture);
    const { fixture, cookie, session } = opened;
    expect(metadataRow(fixture.db, session)).toMatchObject({
      status: "running",
      title: "held turn",
    });
    const before = Date.now();

    const view = await expectPatched(
      patch(fixture, cookie, session, { title: "新名", scene: "office", pinned: true }),
    );

    const after = Date.now();
    expect(view).toMatchObject({ title: "新名", scene: "office", status: "running" });
    const pinned = metadataRow(fixture.db, session);
    expect(pinned).toMatchObject({ title: "新名", scene: "office", status: "running" });
    expect(pinned.pinned_at).toBeGreaterThanOrEqual(before);
    expect(pinned.pinned_at).toBeLessThanOrEqual(after);

    completeHeldTurn(opened.child);
    await waitForTurn(fixture, session, "done");

    expect(metadataRow(fixture.db, session)).toMatchObject({
      title: "新名",
      status: "done",
      scene: "office",
      pinned_at: pinned.pinned_at,
    });
  });
});

describe("attachment-only admission titles from the first file name (#1019)", () => {
  const LONG = [
    { path: "uploads/子目录/2026 年第三季度销售数据汇总与分析报告.xlsx", size: 3 },
    { path: "uploads/b.png", size: 5 },
  ];
  const LONG_STORED =
    '[{"path":"uploads/子目录/2026 年第三季度销售数据汇总与分析报告.xlsx","size":3},{"path":"uploads/b.png","size":5}]';
  const ASSISTANT = { role: "assistant", content: "", kind: "text", attachments: null };

  /** The session's title, and each message's role, content (with storage class) and column. */
  function rowsOf(db: DatabaseSync, id: string) {
    const messages = db
      .prepare(
        "SELECT role, content, typeof(content) AS kind, attachments FROM chat_messages WHERE session_id = ? ORDER BY id",
      )
      .all(id);
    return { title: metadataRow(db, id).title, messages };
  }

  it.each([
    ["the file name's first 18 code points", null, "", LONG, "2026 年第三季度销售数据汇总与分"],
    ["a path without a directory whole", null, "", [{ path: "a.pdf", size: 3 }], "a.pdf"],
    ["the text when there is text", null, "看看", LONG, "看看"],
    ["nothing over an existing title", "季度汇报", "", LONG, "季度汇报"],
  ])("takes %s; the content is the given text", (_name, titled, text, attachments, title) => {
    withSessionStore(({ db, store }) => {
      const session = store.create("u1");
      db.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").run(titled, session.id);

      store.acceptPrompt(session.id, "u1", text, attachments);

      const stored = attachments === LONG ? LONG_STORED : '[{"path":"a.pdf","size":3}]';
      expect(rowsOf(db, session.id)).toEqual({
        title,
        messages: [{ role: "user", content: text, kind: "text", attachments: stored }, ASSISTANT],
      });
    });
  });

  it("an absent or empty list stores NULL, and extra keys of an element are not stored", () => {
    const wide = { path: "a.pdf", size: 3, absPath: "/srv/a.pdf" };
    withSessionStore(({ db, store }) => {
      for (const [attachments, stored] of [
        [undefined, null],
        [[], null],
        [[wide], '[{"path":"a.pdf","size":3}]'],
      ] as const) {
        const session = store.create("u1");

        store.acceptPrompt(session.id, "u1", "看看", attachments);

        expect(rowsOf(db, session.id)).toEqual({
          title: "看看",
          messages: [
            { role: "user", content: "看看", kind: "text", attachments: stored },
            ASSISTANT,
          ],
        });
      }
    });
  });

  it("rolled back unprogressed, the title reads NULL again and the accepted pair is gone", () => {
    withSessionStore(({ db, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "", LONG);
      expect(metadataRow(db, session.id).title).toBe("2026 年第三季度销售数据汇总与分");

      expect(store.rollbackPrompt(accepted.assistantMessageId)).toBe(true);

      expect(rowsOf(db, session.id)).toEqual({ title: null, messages: [] });
      expect(metadataRow(db, session.id).status).toBe("idle");
    });
  });
});
