/**
 * `GET /api/commands` (#551, parent D15; #773): the slash-command directory of the cwd a session
 * of the caller would run in — the two whitelisted builtins, then `sessionSkills` (the platform
 * skills of `<agentDir>/skills`, then the project skills of that cwd), recomputed on every request.
 * The cwd is the caller's owner root, or the root of the workspace named by the optional
 * `workspaceId`; that lookup is the route's only SQLite read, and no session or process is
 * touched. Not a content-parser owner: Fastify never parses a GET body, so a body is recognised
 * by its headers alone. The query/body probe runs in the handler, after the root preParsing guard,
 * so an unauthenticated request carrying either is still 401.
 */
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { noStoreSessionHeaders } from "./rest.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import { BUILTIN_COMMANDS, sessionSkills } from "./slash-commands.js";

interface CommandRouteDependencies {
  agentDir: string;
  sandboxRoot: string;
  /** The workspace store's owner-scoped `rootOf`: null for an id that is not the caller's. */
  workspaceRootOf: WorkspaceRootOf;
}

const SKILL_HINT = "可选参数";
const WORKSPACE_KEY = "workspaceId";

export function registerCommandRoutes(
  app: FastifyInstance,
  dependencies: CommandRouteDependencies,
): void {
  app.get("/api/commands", { onRequest: noStoreSessionHeaders }, async (request, reply) => {
    const principal = request.principal;
    if (principal === null) {
      throw new HttpError("unauthorized");
    }
    const cwd = commandCwd(dependencies, principal.id, workspaceIdOf(request));
    const builtins = BUILTIN_COMMANDS.map(({ name, label, description, hint }) => ({
      name,
      label,
      description,
      hint,
      source: "builtin",
      overrides: false,
    }));
    const skills = sessionSkills(dependencies.agentDir, cwd, dependencies.sandboxRoot).map(
      ({ name, description, source, overrides }) => ({
        name: `skill:${name}`,
        label: name,
        description,
        hint: SKILL_HINT,
        source,
        overrides,
      }),
    );
    return reply.code(200).send({ commands: [...builtins, ...skills] });
  });
}

/**
 * The cwd whose project skills are listed: the owner root, or the workspace root. An id that is
 * malformed, unknown or another account's is 404 (`rootOf` answers null for all three); a
 * workspace of the caller whose root is unusable (`rootOf` throws) is not an error and has no
 * project skill — null.
 */
function commandCwd(
  dependencies: CommandRouteDependencies,
  ownerId: string,
  workspaceId: string | undefined,
): string | null {
  if (workspaceId === undefined) {
    return join(dependencies.sandboxRoot, ownerId);
  }
  let root: string | null;
  try {
    root = dependencies.workspaceRootOf(ownerId, workspaceId);
  } catch {
    return null;
  }
  if (root === null) {
    throw new HttpError("not_found");
  }
  return root;
}

/**
 * The `workspaceId` of the query string, undefined without one. `raw.url` keeps the query string
 * through `rewriteUrl`; a GET body shows only in its headers. Anything but exactly one
 * `workspaceId` key with one non-empty value, and any body, is 400.
 */
function workspaceIdOf(request: FastifyRequest): string | undefined {
  if (
    Number(request.headers["content-length"]) > 0 ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw new HttpError("bad_request");
  }
  const url = request.raw.url ?? "";
  const mark = url.indexOf("?");
  if (mark === -1) {
    return undefined;
  }
  const query = new URLSearchParams(url.slice(mark + 1));
  const values = query.getAll(WORKSPACE_KEY);
  const [value] = values;
  if ([...query.keys()].length !== 1 || values.length !== 1 || !value) {
    throw new HttpError("bad_request");
  }
  return value;
}
