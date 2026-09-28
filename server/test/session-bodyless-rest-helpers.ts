/**
 * Bodyless session-route test plumbing (#467, reusable by #469): the body catalogue that must be an
 * owned 400 on a bodyless content-parser owner, inject and real-socket request helpers
 * parameterised by the route's action segment (`/api/sessions/:id/<action>`), the no-store
 * envelope assertion and the `chat_messages` AUTOINCREMENT high-water mark (the only oracle that
 * tells "never written" from "written then rolled back").
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { OVERSIZED_PARSER_INPUT } from "./session-rest-helpers.js";

const JSON_TYPE = "application/json";

/** `contentType` undefined sends no content-type header. */
export interface BodyInput {
  name: string;
  payload: string;
  contentType?: string;
}

export const MALFORMED_JSON: BodyInput = {
  name: "malformed JSON",
  payload: "{",
  contentType: JSON_TYPE,
};
export const EMPTY_JSON: BodyInput = { name: "empty JSON", payload: "", contentType: JSON_TYPE };
export const OCTET: BodyInput = {
  name: "unsupported media",
  payload: "x",
  contentType: "application/octet-stream",
};

/** Tiny bodies only (≤2 bytes): `{}` is above the 1-byte limit; `1`/`x`/`""` parse into a body. */
export const WIRE_BODIES: readonly BodyInput[] = [
  { name: "{} JSON (over the limit)", payload: "{}", contentType: JSON_TYPE },
  MALFORMED_JSON,
  EMPTY_JSON,
  OCTET,
  { name: "1 JSON", payload: "1", contentType: JSON_TYPE },
  { name: "x text/plain", payload: "x", contentType: "text/plain" },
  { name: "empty text/plain", payload: "", contentType: "text/plain" },
];

/** WIRE_BODIES plus a parsed object, a header-less body and the 1.1 MB input (inject only). */
export const INJECT_BODIES: readonly BodyInput[] = [
  ...WIRE_BODIES,
  { name: '{"x":1} JSON', payload: '{"x":1}', contentType: JSON_TYPE },
  { name: "1 without content-type", payload: "1" },
  OVERSIZED_PARSER_INPUT,
];

/** 401/404-before-parser bodies: none, malformed and the 1.1 MB oversized input (inject only). */
export const PRE_PARSER_BODIES: ReadonlyArray<BodyInput | undefined> = [
  undefined,
  MALFORMED_JSON,
  OVERSIZED_PARSER_INPUT,
];

function headersFor(cookie: string | null, body: BodyInput | undefined): Record<string, string> {
  return {
    ...(cookie === null ? {} : { cookie }),
    ...(body?.contentType === undefined ? {} : { "content-type": body.contentType }),
  };
}

/** Injects `POST /api/sessions/<session>/<action>`; no `body` sends neither payload nor type. */
export function postSessionAction(
  app: FastifyInstance,
  action: string,
  session: string,
  cookie: string | null,
  body?: BodyInput,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${session}/${action}`,
    headers: headersFor(cookie, body),
    ...(body === undefined ? {} : { payload: body.payload }),
  });
}

/** The same request over a real socket; what the wire returned, read in full while listening. */
export async function wireSessionAction(
  origin: string,
  action: string,
  session: string,
  cookie: string | null,
  body?: BodyInput,
) {
  const response = await fetch(`${origin}/api/sessions/${session}/${action}`, {
    method: "POST",
    headers: headersFor(cookie, body),
    ...(body === undefined ? {} : { body: body.payload }),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    setCookie: response.headers.get("set-cookie"),
    text: await response.text(),
  };
}

/** Expected wire outcome: route-owned no-store and no set-cookie. */
export function onWire(status: number, text: string) {
  return { status, cacheControl: "no-store", setCookie: null, text };
}

export function expectEnvelope(
  response: LightMyRequestResponse,
  status: number,
  envelope: object,
): void {
  expect({
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    payload: response.payload,
  }).toEqual({ status, cacheControl: "no-store", payload: JSON.stringify(envelope) });
}

/** `chat_messages` AUTOINCREMENT high-water mark (0 before any insert); a rollback keeps it. */
export function messageSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'").get() as
    | { seq: number }
    | undefined;
  return row === undefined ? 0 : Number(row.seq);
}
