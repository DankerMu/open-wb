/**
 * Issue #815 (#773 task group 3) `GET /api/project-config`: chat-sessions Requirement
 * 「项目配置文件列表」, Scenario「Files present at the read locations」, in the world of
 * commands-rest-helpers.ts (the production createApp assembly, `app.inject()`, no omp process).
 * The owner root is `sandbox/u1`, a workspace root one level below it. Expected values are the
 * literals of the scenario and of the requirement's location table; nothing is derived from the
 * module under test. What the host touches on the filesystem is observed through the call recorder
 * of slash-commands-skills-hardening.test.ts.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const system = (path: string, depth: number) => file(path, depth, "system");

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

/**
 * Removes the `.git` repo-root marker the host planted at creation (omp-runtime「会话工作目录的仓库根
 * 标记」), as the omp uid could: the walk below the marker is then the one a spawn would re-bound.
 */
function removeMarker(root: string): void {
  expect(readdirSync(join(root, ".git"))).toEqual([]);
  rmdirSync(join(root, ".git"));
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
  it("lists the workspace's files by depth then path, the owner root's AGENTS.md only once the marker is gone, touching no session or process", async () => {
    const { app, db, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    plant(workspace.root, [
      "AGENTS.md",
      ".omp/RULES.md",
      ".omp/SYSTEM_TEMPLATE.md",
      ".omp/agents/reviewer.md",
      ".claude/CLAUDE.md",
      ".claude/SYSTEM.md",
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
    const own = [
      { path: ".claude/CLAUDE.md", kind: "instructions", depth: 0 },
      { path: ".claude/SYSTEM.md", kind: "system", depth: 0 },
      { path: ".omp/RULES.md", kind: "instructions", depth: 0 },
      { path: ".omp/SYSTEM_TEMPLATE.md", kind: "system", depth: 0 },
      { path: ".omp/agents/reviewer.md", kind: "agent", depth: 0 },
      { path: "AGENTS.md", kind: "instructions", depth: 0 },
    ];

    // The created workspace root holds the `.git` marker: the walk is that root alone.
    expect(bound.statusCode).toBe(200);
    expect(bound.payload).toBe(JSON.stringify({ files: own }));
    removeMarker(workspace.root);
    expect(await listed(app, cookie, workspace.id)).toBe(
      JSON.stringify({ files: [...own, { path: "AGENTS.md", kind: "instructions", depth: 1 }] }),
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
    removeMarker(workspace.root);

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
    const marked = await createWorkspace(app, cookie, sandboxRoot, "marked");
    plant(skillsOnly.root, [".omp/skills/x/SKILL.md"]);
    plant(emptyOmp.root, [".omp/"]);
    plant(ownerRoot, [".omp/RULES.md", ".omp/SYSTEM.md", ".omp/agents/far.md"]);
    for (const workspace of [skillsOnly, noOmp, emptyOmp]) {
      removeMarker(workspace.root);
    }

    // The nearer non-empty `.omp` has no RULES.md or SYSTEM.md; `agents` is looked up on its own.
    expect(await listed(app, cookie, skillsOnly.id)).toBe(
      JSON.stringify({ files: [agent(".omp/agents/far.md", 1)] }),
    );
    const fromOwnerRoot = JSON.stringify({
      files: [
        file(".omp/RULES.md", 1),
        system(".omp/SYSTEM.md", 1),
        agent(".omp/agents/far.md", 1),
      ],
    });
    expect(await listed(app, cookie, noOmp.id)).toBe(fromOwnerRoot);
    // An empty `.omp` is not the nearest one (omp's `ifNonEmptyDir`).
    expect(await listed(app, cookie, emptyOmp.id)).toBe(fromOwnerRoot);
    // With its marker in place the walk ends at the workspace root; the agents lookup does not.
    expect(await listed(app, cookie, marked.id)).toBe(
      JSON.stringify({ files: [agent(".omp/agents/far.md", 1)] }),
    );
  });

  it("lists .claude/CLAUDE.md only for the cwd and .omp/SYSTEM.md at the nearest non-empty .omp", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    plant(ownerRoot, [".claude/CLAUDE.md", ".omp/SYSTEM.md", ".omp/AGENTS.md"]);
    removeMarker(workspace.root);

    // #1570 (omp v18.12.3): the owner root's `.omp` is the nearest one, so its SYSTEM.md is listed.
    expect(await listed(app, cookie, workspace.id)).toBe(
      JSON.stringify({ files: [file(".omp/AGENTS.md", 1), system(".omp/SYSTEM.md", 1)] }),
    );
  });

  /**
   * Issue #1570 (task 6.2): the rows #1563 adds to the location table, each placed once in the cwd
   * and once one level up with no `.git` in between, plus the host's marker bounding them.
   */
  it("lists the system rows: .agent|.agents and .omp at every level, .claude|.codex in the cwd only", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    const here = await createWorkspace(app, cookie, sandboxRoot, "here");
    const below = await createWorkspace(app, cookie, sandboxRoot, "below");
    const marked = await createWorkspace(app, cookie, sandboxRoot, "marked");
    const rows = [
      ".agent/AGENTS.md",
      ".agent/SYSTEM.md",
      ".agent/SYSTEM_TEMPLATE.md",
      ".agents/AGENTS.md",
      ".agents/SYSTEM.md",
      ".agents/SYSTEM_TEMPLATE.md",
      ".claude/SYSTEM.md",
      ".claude/SYSTEM_TEMPLATE.md",
      ".codex/SYSTEM.md",
      ".codex/SYSTEM_TEMPLATE.md",
      ".omp/SYSTEM.md",
      ".omp/SYSTEM_TEMPLATE.md",
    ];
    plant(here.root, rows);
    plant(ownerRoot, rows);
    removeMarker(below.root);

    expect(await listed(app, cookie, here.id)).toBe(
      JSON.stringify({
        files: [
          file(".agent/AGENTS.md", 0),
          system(".agent/SYSTEM.md", 0),
          system(".agent/SYSTEM_TEMPLATE.md", 0),
          file(".agents/AGENTS.md", 0),
          system(".agents/SYSTEM.md", 0),
          system(".agents/SYSTEM_TEMPLATE.md", 0),
          system(".claude/SYSTEM.md", 0),
          system(".claude/SYSTEM_TEMPLATE.md", 0),
          system(".codex/SYSTEM.md", 0),
          system(".codex/SYSTEM_TEMPLATE.md", 0),
          system(".omp/SYSTEM.md", 0),
          system(".omp/SYSTEM_TEMPLATE.md", 0),
        ],
      }),
    );
    // One level up: every row but the cwd-only `.claude` and `.codex` ones.
    expect(await listed(app, cookie, below.id)).toBe(
      JSON.stringify({
        files: [
          file(".agent/AGENTS.md", 1),
          system(".agent/SYSTEM.md", 1),
          system(".agent/SYSTEM_TEMPLATE.md", 1),
          file(".agents/AGENTS.md", 1),
          system(".agents/SYSTEM.md", 1),
          system(".agents/SYSTEM_TEMPLATE.md", 1),
          system(".omp/SYSTEM.md", 1),
          system(".omp/SYSTEM_TEMPLATE.md", 1),
        ],
      }),
    );
    // With the host's marker in the cwd, none of them is listed.
    expect(await listed(app, cookie, marked.id)).toBe(NONE);
  });

  it("stops the walk at the .git level but not the agents lookup", async () => {
    const { app, cookie, sandboxRoot, ownerRoot } = await ownerWorld();
    // The `.git` of `repo` is the marker the host planted at creation; a real repository's is the same.
    const repo = await createWorkspace(app, cookie, sandboxRoot, "repo");
    const plain = await createWorkspace(app, cookie, sandboxRoot, "plain");
    plant(ownerRoot, ["AGENTS.md", ".agents/AGENTS.md", ".omp/RULES.md", ".omp/agents/far.md"]);
    removeMarker(plain.root);

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
  it("lists neither a linked file, a directory, nor a file behind a linked .agent(s), .claude or .codex", async () => {
    const { app, cookie, sandboxRoot } = await ownerWorld();
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    const real = join(workspace.root, "real");
    plant(workspace.root, [
      "real/AGENTS.md",
      "real/CLAUDE.md",
      "real/SYSTEM.md",
      "real/SYSTEM_TEMPLATE.md",
      "real/x.md",
      "AGENTS.md/",
      ".omp/AGENTS.md",
      ".omp/agents/kept.md",
      ".omp/agents/dir.md/",
      ".omp/agents/notes.txt",
    ]);
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "RULES.md"));
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "SYSTEM.md"));
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "SYSTEM_TEMPLATE.md"));
    symlinkSync(join(real, "x.md"), join(workspace.root, ".omp", "agents", "linked.md"));
    for (const dir of [".agent", ".agents", ".claude", ".codex"]) {
      symlinkSync(real, join(workspace.root, dir), "dir");
    }
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
      removeMarker(workspace.root);
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
