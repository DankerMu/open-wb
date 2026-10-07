/**
 * Session list event connection test plumbing (issues #931 / #933): a real HTTP client on
 * `GET /api/sessions/events` whose bytes are read natively, shared by the endpoint cases and the
 * trigger-point cases. Frames and the heartbeat interval are spec literals.
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { requestMe } from "./auth-lifecycle-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { waitFor } from "./session-supervisor-helpers.js";

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
