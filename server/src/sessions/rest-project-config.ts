/**
 * `GET /api/project-config` (#773 design D4): the project configuration files that exist at the
 * locations omp v18.0.10 reads for the cwd a session of the caller would run in. A list of files
 * present, not of files in effect: omp keeps one instruction file per directory level by provider
 * priority, and the host does not reproduce that. Same request rules as `GET /api/commands`
 * (`requestCwd`), same resolved directories as the project skills (`projectDirs`). The sandbox is
 * writable by the omp uid, so the host only `lstat`s: no content is read, no link is followed, and
 * every directory between an inspected directory and a listed file must be a real directory.
 * The location table is pinned by server/test/omp-official-project-config.test.ts; when an omp
 * upgrade turns that red, the spec changes first.
 */
import { lstatSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { compareMigrationFilenames as compareCodePoints } from "../core/db/migration-assets.js";
import { noStoreSessionHeaders } from "./rest.js";
import { type RequestCwdDependencies, requestCwd } from "./rest-commands.js";
import { projectDirs, readDirBounded } from "./slash-commands.js";

interface ConfigFile {
  /** Relative to the directory `depth` levels above the cwd, `/`-separated. */
  path: string;
  kind: "instructions" | "system" | "agent";
  depth: number;
}

/** `link` and `none` differ only for `.omp` and `.omp/agents`: a link ends a nearest search. */
type EntryType = "dir" | "file" | "link" | "none";

/** Agent definitions listed: the first ones in code-point order. */
const MAX_AGENT_FILES = 64;

export function registerProjectConfigRoutes(
  app: FastifyInstance,
  dependencies: RequestCwdDependencies,
): void {
  app.get("/api/project-config", { onRequest: noStoreSessionHeaders }, async (request, reply) => {
    const cwd = requestCwd(request, dependencies);
    const files = cwd === null ? [] : listProjectConfig(cwd, dependencies.sandboxRoot);
    return reply.code(200).send({ files });
  });
}

/**
 * The files present at omp's read locations, ordered by depth, then by path in code-point order:
 * in every directory of the walk `AGENTS.md` and `.agents/AGENTS.md`; in the cwd `.claude/CLAUDE.md`;
 * in the nearest directory of the walk whose `.omp` holds an entry `.omp/AGENTS.md`, `.omp/RULES.md`
 * and, when that directory is the cwd, `.omp/SYSTEM.md`; and the agent definitions of the nearest
 * `.omp/agents`. `[]` when the cwd cannot be resolved inside the sandbox root. Never throws.
 */
export function listProjectConfig(cwd: string, sandboxRoot: string): ConfigFile[] {
  const { chain, walk } = projectDirs(cwd, sandboxRoot);
  const files: ConfigFile[] = [];
  const add = (depth: number, path: string, kind: ConfigFile["kind"] = "instructions"): void => {
    if (entryType(chain[depth], path) === "file") {
      files.push({ path, kind, depth });
    }
  };
  for (let depth = 0; depth < walk; depth += 1) {
    add(depth, "AGENTS.md");
    if (entryType(chain[depth], ".agents") === "dir") {
      add(depth, ".agents/AGENTS.md");
    }
  }
  if (entryType(chain[0], ".claude") === "dir") {
    add(0, ".claude/CLAUDE.md");
  }
  const omp = nearestDir(chain.slice(0, walk), [".omp"], (entries) => entries.length > 0);
  if (omp !== null) {
    add(omp.depth, ".omp/AGENTS.md");
    add(omp.depth, ".omp/RULES.md");
    if (omp.depth === 0) {
      add(0, ".omp/SYSTEM.md", "system");
    }
  }
  files.push(...agentFiles(chain));
  return files.sort(
    (left, right) => left.depth - right.depth || compareCodePoints(left.path, right.path),
  );
}

/**
 * The regular `*.md` files of the nearest `.omp/agents`, at most the first `MAX_AGENT_FILES` in
 * code-point order. The lookup runs over the whole chain, not stopping at `.git` (omp's
 * `findAllNearestProjectConfigDirs`), and takes the nearest `.omp/agents` that is a directory,
 * whatever it or its `.omp` holds.
 */
function agentFiles(chain: readonly Buffer[]): ConfigFile[] {
  const agents = nearestDir(chain, [".omp", ".omp/agents"], () => true);
  if (agents === null) {
    return [];
  }
  const files: ConfigFile[] = [];
  const names = [...new Set(agents.entries.filter((name) => name.endsWith(".md")))];
  for (const name of names.sort(compareCodePoints)) {
    if (files.length === MAX_AGENT_FILES) {
      break;
    }
    const path = `.omp/agents/${name}`;
    if (entryType(chain[agents.depth], path) === "file") {
      files.push({ path, kind: "agent", depth: agents.depth });
    }
  }
  return files;
}

/**
 * The nearest directory of `dirs` under which the last of `paths` — each one the parent of the
 * next — is a real directory accepted by `accept`, with that directory's entry names. A missing,
 * non-directory, unreadable or unaccepted one lets the search go on upwards; a link at any of
 * `paths`, or a last one holding more entries than `readDirBounded` reads, ends it with null (omp
 * follows the link and stops there: going on would list files omp does not read).
 */
function nearestDir(
  dirs: readonly Buffer[],
  paths: readonly string[],
  accept: (entries: readonly string[]) => boolean,
): { depth: number; entries: string[] } | null {
  for (const [depth, dir] of dirs.entries()) {
    // One at a time: a path below a link is never `lstat`ed.
    let type: EntryType = "dir";
    for (let index = 0; index < paths.length && type === "dir"; index += 1) {
      type = entryType(dir, paths[index] ?? "");
    }
    if (type === "link") {
      return null;
    }
    if (type !== "dir") {
      continue;
    }
    let entries: string[] | null;
    try {
      entries = readDirBounded(Buffer.concat([dir, Buffer.from(`/${String(paths.at(-1))}`)]));
    } catch {
      continue;
    }
    if (entries === null) {
      return null;
    }
    if (accept(entries)) {
      return { depth, entries };
    }
  }
  return null;
}

/** What `lstat` says `<dir>/<path>` is; `none` for anything else, a missing entry or an error. */
function entryType(dir: Buffer | undefined, path: string): EntryType {
  if (dir === undefined) {
    return "none";
  }
  try {
    const stat = lstatSync(Buffer.concat([dir, Buffer.from(`/${path}`)]));
    if (stat.isSymbolicLink()) {
      return "link";
    }
    if (stat.isDirectory()) {
      return "dir";
    }
    return stat.isFile() ? "file" : "none";
  } catch {
    return "none";
  }
}
