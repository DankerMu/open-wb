import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { query } from "../core/audit/index.js";
import { HttpError } from "../core/errors/index.js";

/** exact audit route 的最早响应策略：在 guard 与 handler 之前声明不可存储。 */
const noStoreAuditResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerAccounts(app: FastifyInstance, { db }: { db: DatabaseSync }): void {
  app.get("/api/audit", { onRequest: noStoreAuditResponse }, async (request) => {
    const principal = request.principal;
    if (principal === null) {
      throw new HttpError("unauthorized");
    }
    return { events: query(db, principal, parseAuditQuery(request.query)) };
  });
}

function parseAuditQuery(wire: unknown): { limit?: number; before?: string } {
  if (typeof wire !== "object" || wire === null) {
    return {};
  }

  const opts: { limit?: number; before?: string } = {};
  if ("limit" in wire) {
    if (typeof wire.limit !== "string") {
      throw new HttpError("bad_request");
    }
    opts.limit = Number(wire.limit);
  }
  if ("before" in wire) {
    if (typeof wire.before !== "string") {
      throw new HttpError("bad_request");
    }
    opts.before = wire.before;
  }
  return opts;
}
