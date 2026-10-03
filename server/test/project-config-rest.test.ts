/**
 * Issue #815 (#773 task group 3) `GET /api/project-config`: chat-sessions Requirement
 * 「项目配置文件列表」, Scenario「Files present at the read locations」, in the world of
 * commands-rest-helpers.ts (the production createApp assembly, `app.inject()`, no omp process).
 * The owner root is `sandbox/u1`, a workspace root one level below it. Expected values are the
 * literals of the scenario and of the requirement's location table; nothing is derived from the
 * module under test. What the host touches on the filesystem is observed through the call recorder
 * of slash-commands-skills-hardening.test.ts.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  type DirectoryWorld,
  expectRejected,
  getDirectory,
  openWorld,
  REJECTED,
} from "./commands-rest-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  loginSessionPair,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";

const ROUTE = "/api/project-config";
const NONE = JSON.stringify({ files: [] });

type Kind = "instructions" | "system" | "agent";

const file = (path: string, depth: number, kind: Kind = "instructions") => ({ path, kind, depth });
const agent = (path: string, depth: number) => file(path, depth, "agent");

/** Regular files (their content is never read), or directories for paths ending in `/`. */
function plant(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    mkdirSync(join(root, path.endsWith("/") ? path : dirname(path)), { recursive: true });
    if (!path.endsWith("/")) {
      writeFileSync(join(root, path), "内容\n");
    }
  }
}

/** A logged-in owner (`u1`) and the owner root, which the first workspace creates. */
async function ownerWorld(): Promise<DirectoryWorld & { cookie: string; ownerRoot: string }> {
  const world = openWorld("project-config-rest-");
  const cookie = await loginSessionPair(world.app);
  return { ...world, cookie, ownerRoot: join(world.sandboxRoot, "u1") };
}

function getConfig(app: FastifyInstance, cookie: string, workspaceId?: string) {
  return getDirectory(app, ROUTE, cookie, workspaceId);
}

/** The 200 payload of the route, as bytes: key order and entry order are part of the contract. */
async function listed(app: FastifyInstance, cookie: string, workspaceId?: string): Promise<string> {
  const response = await getConfig(app, cookie, workspaceId);
  expect(response.statusCode).toBe(200);
  return response.payload;
}

function sessionRows(db: DatabaseSync): unknown {
  return db.prepare("SELECT COUNT(*) AS count FROM chat_sessions").get()?.count;
}

describe("GET /api/project-config: request rules", () => {
  it("is 401 no-store without a session, also with a query string, a workspaceId or a JSON body", async () => {
    const { app, cookie, sandboxRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);

    for (const url of [ROUTE, `${ROUTE}?x=1`, `${ROUTE}?workspaceId=${workspace.id}`]) {
      expectEnvelope(await app.inject({ method: "GET", url }), 401, UNAUTHORIZED_ENVELOPE);
    }
    expectEnvelope(
      await app.inject({
        method: "GET",
        url: ROUTE,
        headers: { "content-type": "application/json" },
        payload: "{}",
      }),
      401,
      UNAUTHORIZED_ENVELOPE,
    );
  });

  it.each(REJECTED)("is 400 bad_request for the owner sending $name", async (input) => {
    await expectRejected(ROUTE, input);
  });

  it("is 404 not_found for another account's workspace id, an unknown id and a malformed id", async () => {
    const { app, cookie, sandboxRoot } = await ownerWorld();
    const otherCookie = await loginSessionPair(app, "zhaoliu");
    const foreign = await createWorkspace(app, otherCookie, sandboxRoot);
    plant(foreign.root, ["AGENTS.md"]);

    // Positive control: the id is a real workspace with a listed file for its own account.
    expect(await listed(app, otherCookie, foreign.id)).toBe(
      JSON.stringify({ files: [file("AGENTS.md", 0)] }),
    );

    for (const id of [foreign.id, "f".repeat(32), "..%2F..", "not-an-id"]) {
      const response = await getConfig(app, cookie, id);
      expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
      expect(response.payload).not.toContain("AGENTS.md");
    }
  });
});

describe("GET /api/project-config: files present at the read locations", () => {
  it("lists the workspace's files and the owner root's AGENTS.md, by depth then path, touching no session or process", async () => {
    const { app, db, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    plant(workspace.root, [
      "AGENTS.md",
      ".omp/RULES.md",
      ".omp/agents/reviewer.md",
      ".claude/CLAUDE.md",
      "GEMINI.md",
      "elsewhere.md",
    ]);
    symlinkSync(join(workspace.root, "elsewhere.md"), join(workspace.root, ".omp", "SYSTEM.md"));
    plant(ownerRoot, [
      "AGENTS.md",
      ".claude/CLAUDE.md",
      ".omp/RULES.md",
      ".omp/SYSTEM.md",
      ".omp/agents/far.md",
    ]);
    const sessions = sessionRows(db);

    const bound = await getConfig(app, cookie, workspace.id);
    const unbound = await getConfig(app, cookie);

    expect(bound.statusCode).toBe(200);
    expect(bound.payload).toBe(
      JSON.stringify({
        files: [
          { path: ".claude/CLAUDE.md", kind: "instructions", depth: 0 },
          { path: ".omp/RULES.md", kind: "instructions", depth: 0 },
          { path: ".omp/agents/reviewer.md", kind: "agent", depth: 0 },
          { path: "AGENTS.md", kind: "instructions", depth: 0 },
          { path: "AGENTS.md", kind: "instructions", depth: 1 },
        ],
      }),
    );
    // Without a workspaceId the cwd is the owner root: its own cwd-only rows are listed.
    expect(unbound.statusCode).toBe(200);
    expect(unbound.payload).toBe(
      JSON.stringify({
        files: [
          { path: ".claude/CLAUDE.md", kind: "instructions", depth: 0 },
          { path: ".omp/RULES.md", kind: "instructions", depth: 0 },
          { path: ".omp/SYSTEM.md", kind: "system", depth: 0 },
          { path: ".omp/agents/far.md", kind: "agent", depth: 0 },
          { path: "AGENTS.md", kind: "instructions", depth: 0 },
        ],
      }),
    );
    expect(sessionRows(db)).toBe(sessions);
    expect(app.sessions.supervisor.liveProcessCount()).toBe(0);
  });

  it("orders a deeper file after a nearer one whatever their paths", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    plant(workspace.root, ["AGENTS.md"]);
    plant(ownerRoot, [".agents/AGENTS.md"]);
    plant(sandboxRoot, [".agents/AGENTS.md", "AGENTS.md", ".omp/agents/root.md"]);

    expect(await listed(app, cookie, workspace.id)).toBe(
      JSON.stringify({
        files: [
          file("AGENTS.md", 0),
          file(".agents/AGENTS.md", 1),
          file(".agents/AGENTS.md", 2),
          agent(".omp/agents/root.md", 2),
          file("AGENTS.md", 2),
        ],
      }),
    );
  });

  it("locates the nearest non-empty .omp and the nearest .omp/agents separately", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const skillsOnly = await createWorkspace(app, cookie, sandboxRoot, "skills-only");
    const noOmp = await createWorkspace(app, cookie, sandboxRoot, "no-omp");
    const emptyOmp = await createWorkspace(app, cookie, sandboxRoot, "empty-omp");
    plant(skillsOnly.root, [".omp/skills/x/SKILL.md"]);
    plant(emptyOmp.root, [".omp/"]);
    plant(ownerRoot, [".omp/RULES.md", ".omp/agents/far.md"]);

    // The nearer non-empty `.omp` has no RULES.md; `agents` is looked up on its own.
    expect(await listed(app, cookie, skillsOnly.id)).toBe(
      JSON.stringify({ files: [agent(".omp/agents/far.md", 1)] }),
    );
    const fromOwnerRoot = JSON.stringify({
      files: [file(".omp/RULES.md", 1), agent(".omp/agents/far.md", 1)],
    });
    expect(await listed(app, cookie, noOmp.id)).toBe(fromOwnerRoot);
    // An empty `.omp` is not the nearest one (omp's `ifNonEmptyDir`).
    expect(await listed(app, cookie, emptyOmp.id)).toBe(fromOwnerRoot);
  });

  it("lists .claude/CLAUDE.md and .omp/SYSTEM.md only for the cwd", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    plant(ownerRoot, [".claude/CLAUDE.md", ".omp/SYSTEM.md", ".omp/AGENTS.md"]);

    // The owner root's `.omp` is the nearest one, yet it is not the cwd: no SYSTEM.md.
    expect(await listed(app, cookie, workspace.id)).toBe(
      JSON.stringify({ files: [file(".omp/AGENTS.md", 1)] }),
    );
  });

  it("stops the walk at the .git level but not the agents lookup", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const repo = await createWorkspace(app, cookie, sandboxRoot, "repo");
    const plain = await createWorkspace(app, cookie, sandboxRoot, "plain");
    plant(repo.root, [".git/"]);
    plant(ownerRoot, ["AGENTS.md", ".agents/AGENTS.md", ".omp/RULES.md", ".omp/agents/far.md"]);

    expect(await listed(app, cookie, repo.id)).toBe(
      JSON.stringify({ files: [agent(".omp/agents/far.md", 1)] }),
    );
    // Control: the same owner root seen from a workspace without `.git`.
    expect(await listed(app, cookie, plain.id)).toBe(
      JSON.stringify({
        files: [
          file(".agents/AGENTS.md", 1),
          file(".omp/RULES.md", 1),
          agent(".omp/agents/far.md", 1),
          file("AGENTS.md", 1),
        ],
      }),
    );
  });

  it("ends both nearest searches at a linked .omp and the agents search at a linked .omp/agents, listing nothing of the target", async () => {
    const { app, cookie, root, sandboxRoot, ownerRoot } = await ownerWorld();
    const linkedOmp = await createWorkspace(app, cookie, sandboxRoot, "linked-omp");
    const linkedAgents = await createWorkspace(app, cookie, sandboxRoot, "linked-agents");
    plant(join(root, "outside"), ["RULES.md", "agents/a.md"]);
    plant(ownerRoot, [".omp/RULES.md", ".omp/agents/far.md"]);
    symlinkSync(join(root, "outside"), join(linkedOmp.root, ".omp"), "dir");
    plant(linkedAgents.root, [".omp/"]);
    symlinkSync(join(root, "outside", "agents"), join(linkedAgents.root, ".omp", "agents"), "dir");

    expect(await listed(app, cookie, linkedOmp.id)).toBe(NONE);
    // The real `.omp` holds an entry (the link), so it is the nearest; the agents search ends at it.
    expect(await listed(app, cookie, linkedAgents.id)).toBe(NONE);
  });

  it("is 200 with no file for an empty workspace, an unusable workspace root and an owner root linked out of the sandbox", async () => {
    const { app, cookie, root, sandboxRoot, ownerRoot } = await ownerWorld();
    const empty = await createWorkspace(app, cookie, sandboxRoot, "empty");
    const linked = await createWorkspace(app, cookie, sandboxRoot, "linked");
    const removed = await createWorkspace(app, cookie, sandboxRoot, "removed");
    plant(join(root, "outside"), ["AGENTS.md", ".omp/RULES.md", "empty/AGENTS.md"]);
    rmSync(linked.root, { recursive: true });
    symlinkSync(join(root, "outside"), linked.root, "dir");
    rmSync(removed.root, { recursive: true });

    for (const workspace of [empty, linked, removed]) {
      expect(await listed(app, cookie, workspace.id)).toBe(NONE);
    }

    // Control, then the owner root becomes a link to the outside directory.
    plant(ownerRoot, ["AGENTS.md"]);
    expect(await listed(app, cookie)).toBe(JSON.stringify({ files: [file("AGENTS.md", 0)] }));
    renameSync(ownerRoot, join(root, "moved-owner-root"));
    symlinkSync(join(root, "outside"), ownerRoot, "dir");

    expect(await listed(app, cookie)).toBe(NONE);
    expect(await listed(app, cookie, empty.id)).toBe(NONE);
  });
});

describe("GET /api/project-config: a sandbox writable by the omp uid", () => {
  it("lists neither a linked file, a directory, nor a file behind a linked .agents or .claude", async () => {
    const { app, cookie, sandboxRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    const real = join(workspace.root, "real");
    plant(workspace.root, [
      "real/AGENTS.md",
      "real/CLAUDE.md",
      "real/x.md",
      "AGENTS.md/",
      ".omp/AGENTS.md",
      ".omp/agents/kept.md",
      ".omp/agents/dir.md/",
      ".omp/agents/notes.txt",
    ]);
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "RULES.md"));
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "SYSTEM.md"));
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "agents", "linked.md"));
    symlinkSync(real, join(workspace.root, ".agents"), "dir");
    symlinkSync(real, join(workspace.root, ".claude"), "dir");
    const plainLink = await createWorkspace(app, cookie, sandboxRoot, "plain-link");
    plant(plainLink.root, ["x.md"]);
    symlinkSync(join(plainLink.root, "x.md"), join(plainLink.root, "AGENTS.md"));

    expect(await listed(app, cookie, workspace.id)).toBe(
      JSON.stringify({ files: [file(".omp/AGENTS.md", 0), agent(".omp/agents/kept.md", 0)] }),
    );
    expect(await listed(app, cookie, plainLink.id)).toBe(NONE);
  });

  it.skipIf(process.getuid?.() === 0)(
    "lists nothing for an unreadable location and searches on past an unreadable .omp",
    async () => {
      const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
      const workspace = await createWorkspace(app, cookie, sandboxRoot);
      plant(workspace.root, [".agents/AGENTS.md", ".omp/RULES.md", "AGENTS.md"]);
      plant(ownerRoot, [".omp/RULES.md"]);
      const locked = [join(workspace.root, ".agents"), join(workspace.root, ".omp")];

      for (const dir of locked) {
        chmodSync(dir, 0o000);
      }
      let payload: string;
      try {
        payload = await listed(app, cookie, workspace.id);
      } finally {
        for (const dir of locked) {
          chmodSync(dir, 0o700);
        }
      }

      expect(payload).toBe(
        JSON.stringify({ files: [file("AGENTS.md", 0), file(".omp/RULES.md", 1)] }),
      );
    },
  );

  it("ends the nearest searches at a .omp or .omp/agents holding more than 4096 entries, and lists one holding exactly 4096", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const bigOmp = await createWorkspace(app, cookie, sandboxRoot, "big-omp");
    const fullOmp = await createWorkspace(app, cookie, sandboxRoot, "full-omp");
    const bigAgents = await createWorkspace(app, cookie, sandboxRoot, "big-agents");
    const filler = (count: number) =>
      Array.from({ length: count }, (_, index) => `.omp/f-${String(index)}`);
    plant(ownerRoot, [".omp/RULES.md", ".omp/agents/far.md"]);
    plant(bigOmp.root, [".omp/RULES.md", ...filler(4096)]);
    plant(fullOmp.root, [".omp/RULES.md", ...filler(4095)]);
    plant(bigAgents.root, [
      ".omp/agents/a.md",
      ...Array.from({ length: 4096 }, (_, index) => `.omp/agents/f-${String(index)}`),
    ]);

    // 4097 entries: nothing of this `.omp`, and the owner root's is not the nearest either.
    expect(await listed(app, cookie, bigOmp.id)).toBe(
      JSON.stringify({ files: [agent(".omp/agents/far.md", 1)] }),
    );
    expect(await listed(app, cookie, fullOmp.id)).toBe(
      JSON.stringify({ files: [file(".omp/RULES.md", 0), agent(".omp/agents/far.md", 1)] }),
    );
    // 4097 entries in `.omp/agents`: the agents search ends there; `.omp` itself is the nearest.
    expect(await listed(app, cookie, bigAgents.id)).toBe(NONE);
  });

  it("lists at most the first 64 regular *.md agent files in code-point order", async () => {
    const { app, cookie, sandboxRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    const names = Array.from({ length: 70 }, (_, index) => `a-${String(index).padStart(2, "0")}`);
    plant(workspace.root, [
      ...names.map((name) => `.omp/agents/${name}.md`),
      // Code-point order puts an upper-case name first; a locale order would not.
      ".omp/agents/Z.md",
      // Sorted among the first 64 names, neither a regular `*.md` file: they take no slot.
      ".omp/agents/a-000.md/",
      ".omp/agents/a-00.txt",
    ]);
    symlinkSync(
      join(workspace.root, ".omp", "agents", "a-00.md"),
      join(workspace.root, ".omp", "agents", "a-001.md"),
    );

    const expected = ["Z", ...names.slice(0, 63)].map((name) => agent(`.omp/agents/${name}.md`, 0));
    expect(expected).toHaveLength(64);
    expect(await listed(app, cookie, workspace.id)).toBe(JSON.stringify({ files: expected }));
  });
});
