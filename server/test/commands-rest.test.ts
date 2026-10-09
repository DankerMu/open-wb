/**
 * Issue #551 `GET /api/commands` (parent s1c-session-metadata-presentation tasks 10.4a, design
 * D15; chat-sessions Scenario「Command directory」). Every world is the production createApp
 * assembly over a real in-memory SQLite with `assembly.runtime.stateDir` in a temporary directory,
 * driven through `app.inject()`; no omp process is started. Oracles: response status, headers and
 * bytes, SQLite row counts, `liveProcessCount` and the env a recording `spawnImpl` receives from
 * `spawnOmp`. Issue #813 (#773 task group 1; Scenario「Command directory per workspace」): the
 * optional `workspaceId`, `source:"project"` and `overrides`; workspaces are created over
 * `POST /api/workspaces`, project skills are real `SKILL.md` files under `<root>/.omp/skills`.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ompAgentDir, type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import {
  createWorkspace,
  expectRejected,
  getDirectory,
  MODEL,
  openWorld as openDirectoryWorld,
  REJECTED,
} from "./commands-rest-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  loginSessionPair,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { recordedSpawn, type SpawnCall } from "./session-supervisor-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";

const ROUTE = "/api/commands";
const SIX_KEYS = ["name", "label", "description", "hint", "source", "overrides"];
const BUILTIN_ENTRIES = [
  {
    name: "compact",
    label: "整理上下文",
    description: "压缩较长对话的上下文，保留要点",
    hint: "可选：想保留的重点",
    source: "builtin",
    overrides: false,
  },
  {
    name: "todo",
    label: "任务清单",
    description: "查看或修改助手的任务清单",
    hint: "可选：append <任务>",
    source: "builtin",
    overrides: false,
  },
];

const fakeChildren: FakeChild[] = [];

afterEach(() => {
  for (const child of fakeChildren.splice(0)) {
    child.destroy();
  }
});

function openWorld() {
  return openDirectoryWorld("commands-rest-");
}

function writeSkill(skillsDir: string, entry: string, frontmatter: readonly string[]): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(join(skillsDir, entry, "SKILL.md"), `---\n${frontmatter.join("\n")}\n---\n正文\n`);
}

function projectSkills(dir: string): string {
  return join(dir, ".omp", "skills");
}

function skillEntry(name: string, description: string, source: string, overrides = false) {
  return { name: `skill:${name}`, label: name, description, hint: "可选参数", source, overrides };
}

function getCommands(app: FastifyInstance, cookie: string, workspaceId?: string) {
  return getDirectory(app, ROUTE, cookie, workspaceId);
}

function rowCount(db: DatabaseSync, table: "audit_events" | "chat_sessions"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (row === undefined || typeof row.count !== "number") {
    throw new Error(`missing count for ${table}`);
  }
  return row.count;
}

describe("GET /api/commands", () => {
  it("is 401 no-store without a session, also with a query string or a JSON body", async () => {
    const { app } = openWorld();

    expectEnvelope(await app.inject({ method: "GET", url: ROUTE }), 401, UNAUTHORIZED_ENVELOPE);
    expectEnvelope(
      await app.inject({ method: "GET", url: `${ROUTE}?x=1` }),
      401,
      UNAUTHORIZED_ENVELOPE,
    );
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

  it("lists the two builtins then the installed skills by name, six keys each with overrides false, touching no row or process", async () => {
    const { app, db, stateDir } = openWorld();
    const skillsDir = join(ompAgentDir(stateDir), "skills");
    writeSkill(skillsDir, "weekly-report", ["name: weekly-report", 'description: "写周报"']);
    writeSkill(skillsDir, "code-review", ["description: Review a diff before it is merged"]);
    const cookie = await loginSessionPair(app);
    const before = {
      audit: rowCount(db, "audit_events"),
      sessions: rowCount(db, "chat_sessions"),
    };

    const response = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const expected = [
      ...BUILTIN_ENTRIES,
      {
        name: "skill:code-review",
        label: "code-review",
        description: "Review a diff before it is merged",
        hint: "可选参数",
        source: "skill",
        overrides: false,
      },
      {
        name: "skill:weekly-report",
        label: "weekly-report",
        description: "写周报",
        hint: "可选参数",
        source: "skill",
        overrides: false,
      },
    ];
    const body = response.json<{ commands: Array<Record<string, unknown>> }>();
    expect(body.commands).toHaveLength(4);
    expect(body.commands.map((command) => Object.keys(command))).toEqual([
      SIX_KEYS,
      SIX_KEYS,
      SIX_KEYS,
      SIX_KEYS,
    ]);
    expect(response.payload).toBe(JSON.stringify({ commands: expected }));
    expect({
      audit: rowCount(db, "audit_events"),
      sessions: rowCount(db, "chat_sessions"),
    }).toEqual(before);
    expect(app.sessions.supervisor.liveProcessCount()).toBe(0);
  });

  it.each(REJECTED)("is 400 bad_request for the owner sending $name", async (input) => {
    await expectRejected(ROUTE, input);
  });

  it("holds exactly the two builtins when no skills directory exists, also with content-length 0", async () => {
    const { app } = openWorld();
    const cookie = await loginSessionPair(app);

    const response = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });
    const zeroLength = await app.inject({
      method: "GET",
      url: ROUTE,
      headers: { cookie, "content-length": "0" },
    });

    for (const reply of [response, zeroLength]) {
      expect(reply.statusCode).toBe(200);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.payload).toBe(JSON.stringify({ commands: BUILTIN_ENTRIES }));
    }
  });

  it("serves a skill installed after an earlier response from the same app", async () => {
    const { app, stateDir } = openWorld();
    const cookie = await loginSessionPair(app);

    const before = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });
    writeSkill(join(ompAgentDir(stateDir), "skills"), "late", ["description: installed later"]);
    const after = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });

    expect(before.statusCode).toBe(200);
    expect(before.payload).toBe(JSON.stringify({ commands: BUILTIN_ENTRIES }));
    expect(after.statusCode).toBe(200);
    expect(after.payload).toBe(
      JSON.stringify({
        commands: [
          ...BUILTIN_ENTRIES,
          {
            name: "skill:late",
            label: "late",
            description: "installed later",
            hint: "可选参数",
            source: "skill",
            overrides: false,
          },
        ],
      }),
    );
  });

  it("lists a skill installed under <state>/home/.omp/agent/skills and none from a legacy <state>/agent/skills", async () => {
    const { app, stateDir } = openWorld();
    writeSkill(join(stateDir, "home", ".omp", "agent", "skills"), "managed", [
      "description: installed in the managed layout",
    ]);
    const legacySkills = join(stateDir, "agent", "skills");
    writeSkill(legacySkills, "x", ["description: left over from the old layout"]);
    const legacyBytes = readFileSync(join(legacySkills, "x", "SKILL.md"));
    const cookie = await loginSessionPair(app);

    const response = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const names = response.json<{ commands: { name: string }[] }>().commands.map((c) => c.name);
    expect(names).toEqual(["compact", "todo", "skill:managed"]);
    expect(response.body).not.toContain("left over from the old layout");
    expect(readFileSync(join(legacySkills, "x", "SKILL.md")).equals(legacyBytes)).toBe(true);
    expect(readdirSync(join(stateDir, "agent")).toSorted()).toEqual(["skills"]);
  });

  it("reads `.omp/agent` under the HOME the spawn exports, omp's default agent dir", async () => {
    const { app, root, stateDir } = openWorld();
    const calls: SpawnCall[] = [];
    const child = new FakeChild();
    fakeChildren.push(child);
    const recording: SpawnImpl = (command, args, options) => {
      calls.push(recordedSpawn(command, args, options));
      return child.spawnImpl(command, args, options);
    };

    await spawnOmp(
      {
        bin: join(root, "omp-bin"),
        sandboxRoot: join(root, "sandbox"),
        stateDir,
        ownerId: "u1",
        cwd: join(root, "sandbox", "u1"),
        modelId: MODEL,
        approvalMode: "write",
        token: "a".repeat(64),
        resumePath: null,
      },
      recording,
    );

    expect(calls).toHaveLength(1);
    const exported = join(String(calls[0]?.env.HOME), ".omp", "agent");
    expect(exported).toBe(ompAgentDir(stateDir));
    expect(calls[0]?.env.PI_CODING_AGENT_DIR).toBe(exported);
    writeSkill(join(String(exported), "skills"), "from-spawn-dir", ["description: same source"]);
    const cookie = await loginSessionPair(app);
    const response = await app.inject({ method: "GET", url: ROUTE, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ commands: unknown[] }>().commands[2]).toEqual({
      name: "skill:from-spawn-dir",
      label: "from-spawn-dir",
      description: "same source",
      hint: "可选参数",
      source: "skill",
      overrides: false,
    });
  });
});

describe("GET /api/commands per workspace (#813)", () => {
  it("lists the workspace's and its ancestors' project skills with workspaceId, the owner root's without", async () => {
    const { app, db, root, stateDir } = openWorld();
    const cookie = await loginSessionPair(app);
    const workspace = await createWorkspace(app, cookie, join(root, "sandbox"));
    writeSkill(join(ompAgentDir(stateDir), "skills"), "code-review", [
      "description: Review a diff",
    ]);
    writeSkill(join(ompAgentDir(stateDir), "skills"), "weekly-report", ["description: 平台的周报"]);
    writeSkill(projectSkills(workspace.root), "deploy", ["description: 上线到生产"]);
    writeSkill(projectSkills(workspace.root), "weekly-report", ["description: 项目自己的周报"]);
    writeSkill(projectSkills(join(root, "sandbox", "u1")), "mine", ["description: 我的技能"]);
    const sessions = rowCount(db, "chat_sessions");

    const bound = await getCommands(app, cookie, workspace.id);
    const unbound = await getCommands(app, cookie);

    expect(bound.statusCode).toBe(200);
    expect(bound.payload).toBe(
      JSON.stringify({
        commands: [
          ...BUILTIN_ENTRIES,
          skillEntry("code-review", "Review a diff", "skill"),
          skillEntry("deploy", "上线到生产", "project"),
          skillEntry("mine", "我的技能", "project"),
          skillEntry("weekly-report", "项目自己的周报", "project", true),
        ],
      }),
    );
    expect(unbound.statusCode).toBe(200);
    expect(unbound.payload).toBe(
      JSON.stringify({
        commands: [
          ...BUILTIN_ENTRIES,
          skillEntry("code-review", "Review a diff", "skill"),
          skillEntry("weekly-report", "平台的周报", "skill"),
          skillEntry("mine", "我的技能", "project"),
        ],
      }),
    );
    for (const command of bound.json<{ commands: object[] }>().commands) {
      expect(Object.keys(command)).toEqual(SIX_KEYS);
    }
    expect(rowCount(db, "chat_sessions")).toBe(sessions);
    expect(app.sessions.supervisor.liveProcessCount()).toBe(0);
  });

  it("is 404 not_found for another account's workspace id, an unknown id and a malformed id", async () => {
    const { app, root } = openWorld();
    const cookie = await loginSessionPair(app);
    const otherCookie = await loginSessionPair(app, "zhaoliu");
    const foreign = await createWorkspace(app, otherCookie, join(root, "sandbox"));
    writeSkill(projectSkills(foreign.root), "theirs", ["description: 别人的技能"]);

    // Positive control: the id is a real workspace with a listed skill for its own account.
    const own = await getCommands(app, otherCookie, foreign.id);
    expect(own.json<{ commands: { name: string }[] }>().commands.at(-1)?.name).toBe("skill:theirs");

    for (const id of [foreign.id, "f".repeat(32), "..%2F..", "not-an-id"]) {
      const response = await getCommands(app, cookie, id);
      expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
      expect(response.payload).not.toContain("别人的技能");
    }
  });

  it("is 401 without a session whatever the workspaceId", async () => {
    const { app, root } = openWorld();
    const workspace = await createWorkspace(
      app,
      await loginSessionPair(app),
      join(root, "sandbox"),
    );

    for (const id of [workspace.id, "f".repeat(32)]) {
      expectEnvelope(
        await app.inject({ method: "GET", url: `${ROUTE}?workspaceId=${id}` }),
        401,
        UNAUTHORIZED_ENVELOPE,
      );
    }
  });

  it("is 200 with the builtins and the platform skills only once the workspace root is a symlink or gone", async () => {
    const { app, root, stateDir } = openWorld();
    const cookie = await loginSessionPair(app);
    const sandboxRoot = join(root, "sandbox");
    const linked = await createWorkspace(app, cookie, sandboxRoot, "linked");
    const removed = await createWorkspace(app, cookie, sandboxRoot, "removed");
    writeSkill(join(ompAgentDir(stateDir), "skills"), "code-review", [
      "description: Review a diff",
    ]);
    writeSkill(projectSkills(join(sandboxRoot, "u1")), "mine", ["description: 我的技能"]);
    writeSkill(projectSkills(join(root, "outside")), "x", ["description: 沙箱外的技能"]);
    rmSync(linked.root, { recursive: true });
    symlinkSync(join(root, "outside"), linked.root, "dir");
    rmSync(removed.root, { recursive: true });
    const platformOnly = JSON.stringify({
      commands: [...BUILTIN_ENTRIES, skillEntry("code-review", "Review a diff", "skill")],
    });

    for (const workspace of [linked, removed]) {
      const response = await getCommands(app, cookie, workspace.id);
      expect(response.statusCode).toBe(200);
      expect(response.payload).toBe(platformOnly);
    }
  });

  it("is 200 with the builtins and the platform skills only when the owner root is a link out of the sandbox", async () => {
    const { app, root, stateDir } = openWorld();
    const cookie = await loginSessionPair(app);
    const sandboxRoot = join(root, "sandbox");
    const workspace = await createWorkspace(app, cookie, sandboxRoot);
    writeSkill(join(ompAgentDir(stateDir), "skills"), "code-review", [
      "description: Review a diff",
    ]);
    writeSkill(projectSkills(sandboxRoot), "root", ["description: 沙箱根技能"]);
    writeSkill(projectSkills(join(root, "outside")), "x", ["description: 沙箱外的技能"]);
    mkdirSync(join(root, "outside", "proj"));
    renameSync(join(sandboxRoot, "u1"), join(root, "moved-owner-root"));
    symlinkSync(join(root, "outside"), join(sandboxRoot, "u1"), "dir");
    const platformOnly = JSON.stringify({
      commands: [...BUILTIN_ENTRIES, skillEntry("code-review", "Review a diff", "skill")],
    });

    const unbound = await getCommands(app, cookie);
    const bound = await getCommands(app, cookie, workspace.id);

    for (const response of [unbound, bound]) {
      expect(response.statusCode).toBe(200);
      expect(response.payload).toBe(platformOnly);
    }
  });
});
