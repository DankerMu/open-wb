/**
 * The world and the oracles of the prompt-attachment tests (issue #1019), shared by
 * session-prompt-attachments.test.ts and session-prompt-attachments-shape.test.ts (#1257). The
 * production createApp → registerSessions assembly over a real in-memory SQLite, driven through
 * `app.inject()`, with `supervisor.prompt` a resolving spy; workspaces are made over
 * `POST /api/workspaces` and sessions bound over `POST /api/sessions`. A test file that opens a
 * world closes it with `afterEach(closeWorlds)`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect, vi } from "vitest";
import { postPrompt } from "./session-rest-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import {
  createControlledRuntime,
  openBareSession,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";

export const A_PDF = "uploads/a.pdf";

const fixtures: SupervisorApp[] = [];

/** Has `closeWorlds` close an app the test opened by itself. */
export function closeAfterTest(fixture: SupervisorApp): void {
  fixtures.push(fixture);
}

/** Restores every spy and closes every world this test opened. */
export async function closeWorlds(): Promise<void> {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
}

/**
 * A logged-in owner (zhangsan, `u1`) and one workspace `proj` holding `uploads/a.pdf` (3 bytes);
 * `wire` records every call that reaches the supervisor, `notified` every list notification.
 */
export async function openWorld(uploadMaxFiles?: number) {
  const rt = createControlledRuntime(() => {});
  const opened = await openBareSession(
    rt.runtime,
    uploadMaxFiles === undefined ? {} : { assembly: { uploadMaxFiles } },
  );
  closeAfterTest(opened.fixture);
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

export type World = Awaited<ReturnType<typeof openWorld>>;

/** A workspace of the cookie's account; `session()` creates a fresh idle session bound to it. */
export async function openBound(app: FastifyInstance, cookie: string, dir: string) {
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

export function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function rowsOf(world: World, session: string) {
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
export async function send(world: World, session: string, body: unknown, cookie = world.cookie) {
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

export function expectEnvelope(
  response: LightMyRequestResponse,
  status: number,
  envelope: unknown,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(envelope);
  expect(response.headers["cache-control"]).toBe("no-store");
}

/** A refusal: the envelope, and no message row, title, dispatch or list notification from it. */
export async function expectRefused(
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

export async function expectAdmitted(world: World, session: string, body: unknown) {
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
