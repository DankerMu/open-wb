/**
 * Session list event connection test plumbing (issues #931 / #933 / #932): a real HTTP client on
 * `GET /api/sessions/events` whose bytes are read natively, shared by the endpoint cases and the
 * trigger-point cases. Frames and the heartbeat interval are spec literals.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { requestMe } from "./auth-lifecycle-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { type RecordingWorld, waitFor } from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

export const EVENTS_URL = "/api/sessions/events";
export const CHANGED_FRAME = "event: sessions.changed\ndata: {}\n\n";
export const HEARTBEAT_FRAME = ": keepalive\n\n";
export const HEARTBEAT_MS = 15_000;

export interface ListClient {
  req: ClientRequest;
  res: IncomingMessage;
  text(): string;
  closed(): boolean;
}

/** Where list connections are opened: the listening origin and the clients to destroy afterwards. */
export interface ListTarget {
  origin: string;
  clients: ListClient[];
}

/** A world whose app listens on a real port, with the clock that writes its heartbeats. */
export type Listening<W extends RecordingWorld> = W & ListTarget & { clock: TestClock };

const cleanups: Array<() => Promise<void>> = [];

/** Starts the listener; `closeListening` destroys the clients, kills live children and closes. */
export async function listening<W extends RecordingWorld>(
  world: W,
  clock: TestClock,
  children: () => ChildProcessWithoutNullStreams[] = () => [],
): Promise<Listening<W>> {
  const clients: ListClient[] = [];
  cleanups.push(async () => {
    for (const client of clients) {
      client.req.destroy();
    }
    for (const child of children()) {
      if (isLive(child)) {
        child.kill("SIGKILL");
      }
    }
    await world.fixture.close().catch(() => undefined);
  });
  const origin = await world.fixture.app.listen({ host: "127.0.0.1", port: 0 });
  return { ...world, origin, clients, clock };
}

/** For `afterEach`: tears down every world `listening` opened in this test file. */
export async function closeListening(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}

/** The owner's `GET /api/sessions` entry for `session`; `undefined` when it is not listed. */
export async function listedSession<T>(
  app: FastifyInstance,
  cookie: string,
  session: string,
): Promise<(T & { id: string }) | undefined> {
  const response = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const { sessions } = response.json<{ sessions: Array<T & { id: string }> }>();
  return sessions.find((entry) => entry.id === session);
}

export async function accountOf(app: FastifyInstance, account: string) {
  const cookie = await cookieFor(app, account);
  const me = await requestMe(app, cookie);
  expect(me.statusCode).toBe(200);
  const id = (me.json() as { id: unknown }).id;
  if (typeof id !== "string") {
    throw new Error("GET /api/auth/me returned no principal id");
  }
  return { cookie, id };
}

/** Sends the request; the returned promise settles with the response head (any status). */
export function startRequest(
  opened: ListTarget,
  cookie: string | undefined,
  headers: Record<string, string> = {},
): { req: ClientRequest; response: Promise<IncomingMessage> } {
  let req!: ClientRequest;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = httpRequest(
      `${opened.origin}${EVENTS_URL}`,
      { agent: false, headers: { ...(cookie === undefined ? {} : { cookie }), ...headers } },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  void response.catch(() => {});
  return { req, response };
}

export async function openList(
  opened: ListTarget,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<ListClient> {
  const { req, response } = startRequest(opened, cookie, headers);
  const res = await response;
  expect(res.statusCode).toBe(200);
  let text = "";
  let closed = false;
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    text += chunk;
  });
  res.on("error", () => {});
  res.on("close", () => {
    closed = true;
  });
  req.on("error", () => {});
  const client: ListClient = { req, res, text: () => text, closed: () => closed };
  opened.clients.push(client);
  return client;
}

export function textOf(client: ListClient, expected: string): Promise<string> {
  return waitFor(
    () => (client.text().length >= expected.length ? client.text() : undefined),
    `list event bytes ${JSON.stringify(expected)}`,
  );
}

export function count(text: string, frame: string): number {
  return text.split(frame).length - 1;
}

export function changedSince(client: ListClient, mark: number): number {
  return count(client.text().slice(mark), CHANGED_FRAME);
}

export async function changed(client: ListClient, mark: number, what: string, atLeast = 1) {
  await waitFor(
    () => (changedSince(client, mark) >= atLeast ? true : undefined),
    `${String(atLeast)} sessions.changed after ${what}`,
  );
}

/**
 * Reads the connections empty: one heartbeat is written after everything handed to the transport
 * so far, so once it arrived nothing older is still in flight. Returns the marks for "after this".
 */
export async function drainedBy(clock: TestClock, clients: ListClient[]): Promise<number[]> {
  const beats = clients.map((client) => count(client.text(), HEARTBEAT_FRAME));
  clock.advance(HEARTBEAT_MS);
  await waitFor(
    () =>
      clients.every((client, index) => count(client.text(), HEARTBEAT_FRAME) > (beats[index] ?? 0))
        ? true
        : undefined,
    "heartbeat sentinel",
  );
  return clients.map((client) => client.text().length);
}

/** Every frame on the connection is a `sessions.changed` with `data` exactly `{}` or a heartbeat. */
export function expectOnlyChangedFrames(client: ListClient): void {
  expect(client.text().replaceAll(CHANGED_FRAME, "").replaceAll(HEARTBEAT_FRAME, "")).toBe("");
}

export async function bounded<T>(work: Promise<T>, description: string, ms = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${description}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
