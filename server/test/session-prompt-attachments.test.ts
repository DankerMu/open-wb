/**
 * Issue #1019 prompts carrying attachments (s1g-composer-capabilities tasks 12.3 / 12.4;
 * message-attachments「prompt 携带附件」「附件落库与快照」, chat-sessions「Attachments are validated
 * before admission」「Attachment-only prompt is admitted」). The world is the one of
 * session-rest-slash.test.ts: the production createApp → registerSessions assembly over a real
 * in-memory SQLite, driven through `app.inject()`, with `supervisor.prompt` a resolving spy.
 * Workspaces are made over `POST /api/workspaces` and sessions bound over `POST /api/sessions`; the
 * files are written straight into `<root>/uploads/` (the upload route has its own tests). Oracles:
 * the response, the spy's arguments, the `chat_messages` / `chat_sessions` rows, the rows the
 * request added to `audit_events`, and the files on disk. The two exports of
 * `prompt-attachments.ts` are also called directly for what no request can reach: the byte
 * boundaries, and a sandbox port that answers something the real facade never would.
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import {
  type AttachmentAdmission,
  admitAttachments,
  parsePromptBody,
  type SessionSandboxPort,
} from "../src/sessions/prompt-attachments.js";
import { BAD_REQUEST_ENVELOPE } from "./session-db-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  getSessionMessages,
  postPrompt,
  SESSION_ARCHIVED_ENVELOPE,
  SESSION_BUSY_ENVELOPE,
} from "./session-rest-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import {
  createControlledRuntime,
  openBareSession,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";
import { seedUnboundSession, workspaceOf } from "./support/temporary-workspace.js";
import { SANDBOX_DENIED_ENVELOPE } from "./workspace-upload-helpers.js";

const NOTE = "用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：";
const A_PDF = "uploads/a.pdf";
const A_PDF_SUFFIX = `\n\n${NOTE}\n- ${A_PDF}`;
const MESSAGE_KEYS = [
  "id",
  "role",
  "content",
  "thinking",
  "status",
  "createdAt",
  "approvals",
  "undo",
  "attachments",
  "steps",
];

const fixtures: SupervisorApp[] = [];
const scratch: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A logged-in owner (zhangsan, `u1`) and one workspace `proj` holding `uploads/a.pdf` (3 bytes);
 * `wire` records every call that reaches the supervisor, `notified` every list notification.
 */
async function openWorld(uploadMaxFiles?: number) {
  const rt = createControlledRuntime(() => {});
  const opened = await openBareSession(
    rt.runtime,
    uploadMaxFiles === undefined ? {} : { assembly: { uploadMaxFiles } },
  );
  fixtures.push(opened.fixture);
  const { app, db, supervisor } = opened.fixture;
  // The workspace store realpaths the sandbox root, so it has to exist first.
  mkdirSync(rt.runtime.sandboxRoot, { recursive: true });
  const world = {
    app,
    db,
    supervisor,
    cookie: opened.cookie,
    wire: vi.spyOn(supervisor, "prompt").mockResolvedValue(undefined),
    notified: vi.spyOn(app.sessions.listEvents, "notify"),
  };
  const proj = await openBound(app, world.cookie, "proj");
  put(proj.root, A_PDF, "pdf");
  return { ...world, proj };
}

type World = Awaited<ReturnType<typeof openWorld>>;

/** A workspace of the cookie's account; `session()` creates a fresh idle session bound to it. */
async function openBound(app: FastifyInstance, cookie: string, dir: string) {
  const headers = { cookie, "content-type": "application/json" };
  const made = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers,
    payload: JSON.stringify({ name: dir, dir }),
  });
  expect(made.statusCode).toBe(201);
  const workspace = made.json<{ id: string; root: string }>();
  const session = async (): Promise<string> => {
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
      payload: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(created.statusCode).toBe(201);
    return created.json<{ id: string }>().id;
  };
  return { id: workspace.id, root: workspace.root, session };
}

function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function rowsOf(world: World, session: string) {
  return world.db
    .prepare(
      "SELECT role, content, typeof(content) AS kind, attachments FROM chat_messages WHERE session_id = ? ORDER BY id",
    )
    .all(session);
}

function auditRows(world: World) {
  return world.db
    .prepare("SELECT kind, actor_id, workspace_id, detail FROM audit_events ORDER BY id")
    .all()
    .map((row) => ({
      kind: row.kind,
      actorId: row.actor_id,
      workspaceId: row.workspace_id,
      detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
    }));
}

/**
 * Sends one prompt body and returns the response with what the request left behind: the audit rows
 * it added, the supervisor calls it made and the list notifications it sent.
 */
async function send(world: World, session: string, body: unknown, cookie = world.cookie) {
  const audited = auditRows(world).length;
  const dispatched = world.wire.mock.calls.length;
  const notified = world.notified.mock.calls.length;
  const response = await postPrompt(world.app, session, cookie, JSON.stringify(body));
  return {
    response,
    audit: auditRows(world).slice(audited),
    calls: world.wire.mock.calls.slice(dispatched),
    notified: world.notified.mock.calls.slice(notified).length,
  };
}

function expectEnvelope(response: LightMyRequestResponse, status: number, envelope: unknown): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(envelope);
  expect(response.headers["cache-control"]).toBe("no-store");
}

/** A refusal: the envelope, and no message row, title, dispatch or list notification from it. */
async function expectRefused(
  world: World,
  session: string,
  body: unknown,
  status: number,
  envelope: unknown,
  cookie = world.cookie,
) {
  const before = rowsOf(world, session);
  const sent = await send(world, session, body, cookie);
  expectEnvelope(sent.response, status, envelope);
  expect(rowsOf(world, session)).toEqual(before);
  expect(sessionRow(world.db, session).title).toBeNull();
  expect(sent.calls).toEqual([]);
  expect(sent.notified).toBe(0);
  return sent.audit;
}

async function expectAdmitted(world: World, session: string, body: unknown) {
  const sent = await send(world, session, body);
  expect(sent.response.statusCode).toBe(202);
  expect(Object.keys(sent.response.json() as object)).toEqual([
    "userMessageId",
    "assistantMessageId",
    "undo",
  ]);
  expect(sent.audit).toEqual([]);
  expect(sent.calls).toHaveLength(1);
  const [target, text, step] = sent.calls[0] ?? [];
  expect(target).toBe(session);
  expect(step).toBeTypeOf("function");
  return { text, body: sent.response.json<{ userMessageId: number; undo: string }>() };
}

describe("prompt with attachments (#1019)", () => {
  it("admits a prompt with an attachment: stored beside the text, suffixed only on the wire", async () => {
    const world = await openWorld();
    const session = await world.proj.session();

    const sent = await send(world, session, { message: " 看看这个 ", attachments: [A_PDF] });

    expect(sent.response.statusCode).toBe(202);
    expect(sent.calls.map(([id, text]) => [id, text])).toEqual([
      [session, `看看这个${A_PDF_SUFFIX}`],
    ]);
    expect(sent.audit).toEqual([]);
    expect(sent.notified).toBe(1);
    expect(rowsOf(world, session)).toEqual([
      {
        role: "user",
        content: "看看这个",
        kind: "text",
        attachments: `[{"path":"${A_PDF}","size":3}]`,
      },
      { role: "assistant", content: "", kind: "text", attachments: null },
    ]);
    expect(sessionRow(world.db, session).title).toBe("看看这个");
    // The resolved absolute path stays inside the check.
    for (const text of [sent.response.payload, String(sent.calls[0]?.[1])]) {
      expect(text).not.toContain(world.proj.root);
    }
  });

  it("serves the admitted list in the snapshot, also after the file is deleted", async () => {
    const world = await openWorld();
    const session = await world.proj.session();
    const { body } = await expectAdmitted(world, session, {
      message: "看看",
      attachments: [A_PDF],
    });

    for (const remove of [false, true]) {
      if (remove) {
        rmSync(join(world.proj.root, A_PDF));
      }
      const history = await getSessionMessages(world.app, session, world.cookie);
      expect(history.statusCode).toBe(200);
      const { messages } = history.json<{ messages: Array<Record<string, unknown>> }>();
      expect(messages.map((message) => Object.keys(message))).toEqual([MESSAGE_KEYS, MESSAGE_KEYS]);
      expect(messages.map((message) => [message.id, message.role, message.attachments])).toEqual([
        [body.userMessageId, "user", [{ path: A_PDF, size: 3 }]],
        [body.userMessageId + 1, "assistant", []],
      ]);
      expect(history.payload).not.toContain(world.proj.root);
    }
  });

  it("any regular file of the workspace can be attached, in request order with its own size", async () => {
    const world = await openWorld();
    put(world.proj.root, "docs/子目录/图 (1).png", "12345");
    put(world.proj.root, "empty.txt", "");
    const session = await world.proj.session();
    const paths = ["docs/子目录/图 (1).png", "empty.txt", "./uploads/a.pdf"];

    const { text } = await expectAdmitted(world, session, { message: "三个", attachments: paths });

    expect(text).toBe(`三个\n\n${NOTE}\n- docs/子目录/图 (1).png\n- empty.txt\n- ./uploads/a.pdf`);
    expect(JSON.parse(String(rowsOf(world, session)[0]?.attachments))).toEqual([
      { path: "docs/子目录/图 (1).png", size: 5 },
      { path: "empty.txt", size: 0 },
      { path: "./uploads/a.pdf", size: 3 },
    ]);
  });

  it("treats a missing `attachments` and `[]` alike: no column, no suffix", async () => {
    const world = await openWorld();

    for (const body of [{ message: "你好" }, { message: "你好", attachments: [] }]) {
      const session = await world.proj.session();
      expect((await expectAdmitted(world, session, body)).text).toBe("你好");
      expect(rowsOf(world, session).map((row) => row.attachments)).toEqual([null, null]);
    }
  });
});

describe("attachment-only prompt (#1019)", () => {
  it("admits empty text with attachments: empty content, the suffix alone, the file name as title", async () => {
    const world = await openWorld();
    put(world.proj.root, "uploads/季度报表.xlsx", "xls");
    put(world.proj.root, "uploads/b.png", "12345");
    const two = ["uploads/季度报表.xlsx", "uploads/b.png"];
    const first = await world.proj.session();

    const admitted = await expectAdmitted(world, first, { message: "", attachments: two });

    expect(admitted.text).toBe(`\n\n${NOTE}\n- uploads/季度报表.xlsx\n- uploads/b.png`);
    expect(admitted.body.undo).not.toBe("command");
    expect(rowsOf(world, first)[0]).toEqual({
      role: "user",
      content: "",
      kind: "text",
      attachments: '[{"path":"uploads/季度报表.xlsx","size":3},{"path":"uploads/b.png","size":5}]',
    });
    expect(sessionRow(world.db, first).title).toBe("季度报表.xlsx");
    const history = await getSessionMessages(world.app, first, world.cookie);
    const user = history.json<{ messages: Array<Record<string, unknown>> }>().messages[0];
    expect(Object.keys(user ?? {})).toEqual(MESSAGE_KEYS);
    expect(user).toMatchObject({
      content: "",
      attachments: [
        { path: "uploads/季度报表.xlsx", size: 3 },
        { path: "uploads/b.png", size: 5 },
      ],
    });

    for (const [message, path, title] of [
      ["  \n", "uploads/b.png", "b.png"],
      [" \n ", A_PDF, "a.pdf"],
    ] as const) {
      const session = await world.proj.session();
      const blank = await expectAdmitted(world, session, { message, attachments: [path] });
      expect(blank.text).toBe(`\n\n${NOTE}\n- ${path}`);
      expect(rowsOf(world, session)[0]).toMatchObject({ content: "", kind: "text" });
      expect(sessionRow(world.db, session).title).toBe(title);
    }
  });

  it.each([
    ["看看", null],
    ["", null],
  ])(
    "a 502 after admitting %j with an attachment removes the pair and leaves the file",
    async (message, title) => {
      const world = await openWorld();
      const session = await world.proj.session();
      world.wire.mockRejectedValueOnce(new HttpError("agent_unavailable"));

      const sent = await send(world, session, { message, attachments: [A_PDF] });

      expectEnvelope(sent.response, 502, AGENT_UNAVAILABLE_ENVELOPE);
      expect(sent.calls).toHaveLength(1);
      expect(rowsOf(world, session)).toEqual([]);
      expect(sessionRow(world.db, session)).toMatchObject({ title, status: "idle" });
      expect(existsSync(join(world.proj.root, A_PDF))).toBe(true);
      const history = await getSessionMessages(world.app, session, world.cookie);
      expect(history.json<{ messages: unknown[] }>().messages).toEqual([]);
    },
  );
});

describe("attachment shape and preconditions (#1019)", () => {
  const eleven = Array.from({ length: 11 }, (_, index) => `uploads/f${String(index)}.txt`);

  it.each<[string, unknown]>([
    ["a string instead of a list", { message: "看看", attachments: A_PDF }],
    ["null instead of a list", { message: "看看", attachments: null }],
    ["a number element", { message: "看看", attachments: [1] }],
    ["an empty element", { message: "看看", attachments: [""] }],
    ["a path with a newline", { message: "看看", attachments: ["uploads/a\n.pdf"] }],
    ["a path with U+007F", { message: "看看", attachments: ["uploads/a\u007f.pdf"] }],
    ["a path with a lone surrogate", { message: "看看", attachments: ["uploads/\ud800.pdf"] }],
    ["a path ending in `/`", { message: "看看", attachments: [`${A_PDF}/`] }],
    ["the same path twice", { message: "看看", attachments: [A_PDF, A_PDF] }],
    ["more paths than UPLOAD_MAX_FILES", { message: "看看", attachments: eleven }],
    ["a path of 1025 bytes", { message: "看看", attachments: [`uploads/${"a".repeat(1017)}`] }],
    ["a file that does not exist", { message: "看看", attachments: ["uploads/missing.pdf"] }],
    ["a directory", { message: "看看", attachments: ["uploads"] }],
    ["the workspace root itself", { message: "看看", attachments: ["."] }],
    ["a path through a regular file", { message: "看看", attachments: [`${A_PDF}/x`] }],
    ["a builtin command", { message: "/todo", attachments: [A_PDF] }],
    ["a builtin command after trimming", { message: " /todo", attachments: [A_PDF] }],
    ["empty text and []", { message: "", attachments: [] }],
    ["blank text and no attachments", { message: "   " }],
    ["no `message` key", { attachments: [A_PDF] }],
    ["a null `message`", { message: null, attachments: [A_PDF] }],
    ["empty text and a missing file", { message: "", attachments: ["uploads/不存在.pdf"] }],
    ["blank text and a missing file", { message: "  ", attachments: ["uploads/missing.pdf"] }],
    ["an unknown key", { message: "看看", extra: 1 }],
    ["an unknown key beside both", { message: "看看", attachments: [A_PDF], extra: 1 }],
  ])("answers 400 for %s: no row, no dispatch, no audit", async (_label, body) => {
    const world = await openWorld();
    for (const path of eleven) {
      put(world.proj.root, path, "x");
    }

    const audit = await expectRefused(
      world,
      await world.proj.session(),
      body,
      400,
      BAD_REQUEST_ENVELOPE,
    );

    expect(audit).toEqual([]);
  });

  it("refuses any attachment on a session without a workspace, before any path is resolved", async () => {
    const world = await openWorld();
    const unbound = seedUnboundSession(world.db, "u1", "7".repeat(32));

    for (const path of [A_PDF, "../other/secret.txt"]) {
      const audit = await expectRefused(
        world,
        unbound,
        { message: "看看", attachments: [path] },
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expect(audit).toEqual([]);
    }
    expect((await expectAdmitted(world, unbound, { message: "看看", attachments: [] })).text).toBe(
      "看看",
    );
  });

  it("admits as many attachments as the configured limit, and no more", async () => {
    const world = await openWorld(2);
    const paths = ["uploads/f0.txt", "uploads/f1.txt", "uploads/f2.txt"];
    for (const path of paths) {
      put(world.proj.root, path, "x");
    }

    const audit = await expectRefused(
      world,
      await world.proj.session(),
      { message: "看看", attachments: paths },
      400,
      BAD_REQUEST_ENVELOPE,
    );
    expect(audit).toEqual([]);
    const admitted = await expectAdmitted(world, await world.proj.session(), {
      message: "看看",
      attachments: paths.slice(0, 2),
    });
    expect(admitted.text).toBe(`看看\n\n${NOTE}\n- uploads/f0.txt\n- uploads/f1.txt`);
  });

  it("admits ten attachments under the default limit", async () => {
    const world = await openWorld();
    for (const path of eleven) {
      put(world.proj.root, path, "x");
    }

    const body = { message: "", attachments: eleven.slice(0, 10) };
    await expectAdmitted(world, await world.proj.session(), body);
  });
});

describe("escaping attachments are refused and audited (#1019)", () => {
  const reject = (world: World, relPath: string) => ({
    kind: "sandbox.reject",
    actorId: "u1",
    workspaceId: world.proj.id,
    detail: { relPath, op: "read", reason: expect.any(String) },
  });

  it.each(["看看", ""])(
    "answers 403 with exactly one sandbox.reject for message %j",
    async (message) => {
      const world = await openWorld();
      const outside = join(world.proj.root, "..", "other");
      put(outside, "secret.txt", "secret");
      symlinkSync(join(world.proj.root, A_PDF), join(world.proj.root, "uploads/link.pdf"));
      symlinkSync(outside, join(world.proj.root, "linked"), "dir");

      for (const path of [
        "../other/secret.txt",
        "uploads/link.pdf",
        "linked/secret.txt",
        "/etc/hosts",
      ]) {
        const audit = await expectRefused(
          world,
          await world.proj.session(),
          { message, attachments: [path] },
          403,
          SANDBOX_DENIED_ENVELOPE,
        );
        expect(audit).toEqual([reject(world, path)]);
      }
    },
  );

  it("resolves every path before it looks at any file, and stops at the first refusal", async () => {
    const world = await openWorld();

    const missingFirst = await expectRefused(
      world,
      await world.proj.session(),
      { message: "看看", attachments: ["uploads/不存在.pdf", "../x"] },
      403,
      SANDBOX_DENIED_ENVELOPE,
    );
    expect(missingFirst).toEqual([reject(world, "../x")]);

    const twoEscapes = await expectRefused(
      world,
      await world.proj.session(),
      { message: "看看", attachments: [A_PDF, "../x", "../y"] },
      403,
      SANDBOX_DENIED_ENVELOPE,
    );
    expect(twoEscapes).toEqual([reject(world, "../x")]);
  });

  it("resolves a path in the session's own workspace, whoever else holds such a file", async () => {
    const world = await openWorld();
    const lisi = await cookieFor(world.app, "lisi");
    const theirs = await openBound(world.app, lisi, "proj");
    const session = await theirs.session();
    // Another workspace of the same owner does not hold the file either.
    const other = await openBound(world.app, world.cookie, "other");

    for (const [target, cookie] of [
      [session, lisi],
      [await other.session(), world.cookie],
    ] as const) {
      const audit = await expectRefused(
        world,
        target,
        { message: "看看", attachments: [A_PDF] },
        400,
        BAD_REQUEST_ENVELOPE,
        cookie,
      );
      expect(audit).toEqual([]);
    }
    // And the escape is audited against the session's own workspace and account.
    const escaped = await expectRefused(
      world,
      session,
      { message: "看看", attachments: ["../../u1/proj/uploads/a.pdf"] },
      403,
      SANDBOX_DENIED_ENVELOPE,
      lisi,
    );
    expect(escaped).toEqual([
      {
        kind: "sandbox.reject",
        actorId: workspaceOwner(world, theirs.id),
        workspaceId: theirs.id,
        detail: { relPath: "../../u1/proj/uploads/a.pdf", op: "read", reason: expect.any(String) },
      },
    ]);
    expect(escaped[0]?.actorId).not.toBe("u1");
  });

  it("the lexical rules, the workspace rule and the builtin rule come before any resolve", async () => {
    const world = await openWorld();
    const unbound = seedUnboundSession(world.db, "u1", "8".repeat(32));

    for (const [session, body] of [
      [await world.proj.session(), { message: "看看", attachments: ["../x", "../x"] }],
      [await world.proj.session(), { message: "/todo", attachments: ["../x"] }],
      [await world.proj.session(), { message: "", attachments: ["../x/"] }],
      [unbound, { message: "看看", attachments: ["../x"] }],
    ] as const) {
      const audit = await expectRefused(world, session, body, 400, BAD_REQUEST_ENVELOPE);
      expect(audit).toEqual([]);
    }
  });

  it("an archived or claimed session answers 409 before any path is resolved", async () => {
    const world = await openWorld();
    const body = { message: "看看", attachments: ["../x"] };

    const archived = await world.proj.session();
    world.db.prepare("UPDATE chat_sessions SET archived_at = 1 WHERE id = ?").run(archived);
    expect(await expectRefused(world, archived, body, 409, SESSION_ARCHIVED_ENVELOPE)).toEqual([]);

    const claimed = await world.proj.session();
    vi.spyOn(world.supervisor, "controlHeld").mockReturnValue(true);
    expect(await expectRefused(world, claimed, body, 409, SESSION_BUSY_ENVELOPE)).toEqual([]);
  });

  it("a running session answers 403 for an escaping path and 409 for a valid one", async () => {
    const world = await openWorld();
    const session = await world.proj.session();
    world.db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(session);

    const escaped = await expectRefused(
      world,
      session,
      { message: "看看", attachments: ["../x"] },
      403,
      SANDBOX_DENIED_ENVELOPE,
    );
    expect(escaped).toEqual([reject(world, "../x")]);
    const busy = await expectRefused(
      world,
      session,
      { message: "看看", attachments: [A_PDF] },
      409,
      SESSION_BUSY_ENVELOPE,
    );
    expect(busy).toEqual([]);
  });
});

function workspaceOwner(world: World, workspaceId: string): string {
  return String(
    world.db.prepare("SELECT owner_id FROM workspaces WHERE id = ?").get(workspaceId)?.owner_id,
  );
}

describe("prompt-attachments.ts on its own (#1019)", () => {
  const badRequest = (run: () => unknown) => {
    expect(run).toThrowError(expect.objectContaining({ code: "bad_request" }));
  };

  it("parsePromptBody trims the text once and keeps the paths as given", () => {
    expect(parsePromptBody({ message: " 看看 \n" }, 10)).toEqual({ text: "看看", paths: [] });
    expect(parsePromptBody({ message: "", attachments: ["a", "./a", " a "] }, 3)).toEqual({
      text: "",
      paths: ["a", "./a", " a "],
    });
  });

  it("parsePromptBody holds the byte limits of the text and of each path", () => {
    const limit = "😀".repeat(8_192);
    expect(parsePromptBody({ message: limit }, 10).text).toBe(limit);
    badRequest(() => parsePromptBody({ message: `${limit}a` }, 10));
    badRequest(() => parsePromptBody({ message: `${limit}a`, attachments: ["a"] }, 10));

    const longest = `图${"a".repeat(1_021)}`;
    expect(Buffer.byteLength(longest, "utf8")).toBe(1_024);
    expect(parsePromptBody({ message: "", attachments: [longest] }, 1).paths).toEqual([longest]);
    badRequest(() => parsePromptBody({ message: "", attachments: [`${longest}a`] }, 1));
  });

  it("parsePromptBody counts against the limit it is given", () => {
    expect(parsePromptBody({ message: "", attachments: ["a", "b"] }, 2).paths).toEqual(["a", "b"]);
    badRequest(() => parsePromptBody({ message: "", attachments: ["a", "b"] }, 1));
    expect(
      parsePromptBody(
        { message: "", attachments: Array.from({ length: 12 }, (_, i) => String(i)) },
        12,
      ).paths,
    ).toHaveLength(12);
  });

  it.each(["\u0000", "\u001f", "\u007f", "\ud800", "\udc00x"])(
    "parsePromptBody refuses a path holding %j",
    (unit) => {
      badRequest(() => parsePromptBody({ message: "看看", attachments: [`a${unit}`] }, 10));
      // A well-formed pair and the first character after the controls are fine.
      expect(
        parsePromptBody({ message: "看看", attachments: ["a😀", "a b"] }, 10).paths,
      ).toHaveLength(2);
    },
  );

  /** An admission of `paths` on a bound session with plain text, over the given `resolve`. */
  function admission(paths: string[], resolve: SessionSandboxPort["resolve"]): AttachmentAdmission {
    return {
      sandbox: { resolve },
      principal: { id: "u1" },
      workspaceId: "w",
      builtin: false,
      paths,
    };
  }

  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "open-wb-1019-"));
    scratch.push(dir);
    return dir;
  }

  it("admitAttachments asks the port for every path as a read of that account and workspace", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "one"), "1");
    writeFileSync(join(dir, "two"), "22");
    const asked: unknown[][] = [];
    const principal = { id: "u9" };

    const stored = admitAttachments({
      ...admission(["two", "one"], (...args) => {
        asked.push(args);
        return join(dir, args[2]);
      }),
      principal,
      workspaceId: "w".repeat(32),
    });

    expect(asked).toEqual([
      [principal, "w".repeat(32), "two", "read"],
      [principal, "w".repeat(32), "one", "read"],
    ]);
    expect(stored).toEqual([
      { path: "two", size: 2 },
      { path: "one", size: 1 },
    ]);
  });

  it("admitAttachments does not follow a link the port answered", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "real"), "1");
    symlinkSync(join(dir, "real"), join(dir, "link"));

    badRequest(() => admitAttachments(admission(["link"], () => join(dir, "link"))));
    expect(admitAttachments(admission(["real"], () => join(dir, "real")))).toEqual([
      { path: "real", size: 1 },
    ]);
  });

  it("admitAttachments stops asking at the first refusal and rethrows what it cannot read", () => {
    const dir = scratchDir();
    const asked: string[] = [];
    const refuse = admission(["missing", "bad", "later"], (_principal, _workspace, path) => {
      asked.push(path);
      if (path === "bad") {
        throw new HttpError("sandbox_denied");
      }
      return join(dir, path);
    });

    expect(() => admitAttachments(refuse)).toThrow(
      expect.objectContaining({ code: "sandbox_denied" }),
    );
    expect(asked).toEqual(["missing", "bad"]);
    expect(() => admitAttachments(admission(["long"], () => join(dir, "n".repeat(300))))).toThrow(
      expect.objectContaining({ code: "ENAMETOOLONG" }),
    );
  });

  it("admitAttachments asks the port nothing without a workspace, for a builtin or for no path", () => {
    const never = (): string => {
      throw new Error("resolved");
    };

    badRequest(() => admitAttachments({ ...admission(["a"], never), workspaceId: null }));
    badRequest(() => admitAttachments({ ...admission(["a"], never), builtin: true }));
    expect(admitAttachments({ ...admission([], never), workspaceId: null, builtin: true })).toEqual(
      [],
    );
  });
});

// message-attachments「没有工作空间的会话」: a temporary workspace is addressed like any other.
describe("a session created without a workspace (#1019)", () => {
  it("attaches a file of its temporary workspace like any other", async () => {
    const rt = createControlledRuntime(() => {});
    const opened = await openBareSession(rt.runtime);
    fixtures.push(opened.fixture);
    const wire = vi.spyOn(opened.fixture.supervisor, "prompt").mockResolvedValue(undefined);
    const workspace = workspaceOf(opened.fixture.db, opened.session);
    const upload = await opened.fixture.app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/uploads?name=a.pdf`,
      headers: { cookie: opened.cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("pdf"),
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json<{ path: string; size: number }>();

    const response = await postPrompt(
      opened.fixture.app,
      opened.session,
      opened.cookie,
      JSON.stringify({ message: "", attachments: [uploaded.path] }),
    );

    expect(response.statusCode).toBe(202);
    expect(wire.mock.calls.map(([, text]) => text)).toEqual([A_PDF_SUFFIX]);
    expect(
      opened.fixture.db
        .prepare("SELECT attachments FROM chat_messages WHERE session_id = ? AND role = 'user'")
        .get(opened.session)?.attachments,
    ).toBe(`[{"path":"${A_PDF}","size":3}]`);
    expect(uploaded).toMatchObject({ path: A_PDF, size: 3 });
  });
});
