/**
 * `GET /api/commands` (#551, parent D15): the slash-command directory — the two whitelisted
 * builtins, then the platform skills of `<agentDir>/skills`, recomputed on every request. It is
 * session-independent: no SQLite row, session or process is touched. Not a content-parser owner:
 * Fastify never parses a GET body, so a body is recognised by its headers alone. The query/body
 * probe runs in the handler, after the root preParsing guard, so an unauthenticated request
 * carrying either is still 401.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { noStoreSessionHeaders } from "./rest.js";
import { BUILTIN_COMMANDS, listSkills } from "./slash-commands.js";

interface CommandRouteDependencies {
  agentDir: string;
}

const SKILL_HINT = "可选参数";

export function registerCommandRoutes(
  app: FastifyInstance,
  dependencies: CommandRouteDependencies,
): void {
  app.get("/api/commands", { onRequest: noStoreSessionHeaders }, async (request, reply) => {
    if (carriesQueryOrBody(request)) {
      throw new HttpError("bad_request");
    }
    const builtins = BUILTIN_COMMANDS.map(({ name, label, description, hint }) => ({
      name,
      label,
      description,
      hint,
      source: "builtin",
    }));
    const skills = listSkills(dependencies.agentDir).map(({ name, description }) => ({
      name: `skill:${name}`,
      label: name,
      description,
      hint: SKILL_HINT,
      source: "skill",
    }));
    return reply.code(200).send({ commands: [...builtins, ...skills] });
  });
}

/** `raw.url` keeps the query string through `rewriteUrl`; a GET body shows only in its headers. */
function carriesQueryOrBody(request: FastifyRequest): boolean {
  return (
    (request.raw.url ?? "").includes("?") ||
    Number(request.headers["content-length"]) > 0 ||
    request.headers["transfer-encoding"] !== undefined
  );
}
