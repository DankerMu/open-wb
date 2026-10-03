/**
 * Issue #551 `GET /api/commands` (parent s1c-session-metadata-presentation tasks 10.4a, design
 * D15; chat-sessions Scenario「Command directory」). Every world is the production createApp
 * assembly over a real in-memory SQLite with `assembly.runtime.stateDir` in a temporary directory,
 * driven through `app.inject()`; no omp process is started. Oracles: response status, headers and
 * bytes, SQLite row counts, `liveProcessCount` and the env a recording `spawnImpl` receives from
 * `spawnOmp`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ompAgentDir, type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  loginSessionPair,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { recordedSpawn, type SpawnCall } from "./session-supervisor-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";

const ROUTE = "/api/commands";
const MODEL = "deepseek-v4.1-flash";
const FIVE_KEYS = ["name", "label", "description", "hint", "source"];
const BUILTIN_ENTRIES = [
  {
    name: "compact",
    label: "整理上下文",
    description: "压缩较长对话的上下文，保留要点",
    hint: "可选：想保留的重点",
    source: "builtin",
  },
  {
    name: "todo",
    label: "任务清单",
    description: "查看或修改助手的任务清单",
    hint: "可选：append <任务>",
    source: "builtin",
  },
];

/** Authenticated requests the route must refuse: anything carrying a query string or a body. */
const REJECTED: ReadonlyArray<{
  name: string;
  url?: string;
  headers?: Record<string, string>;
  payload?: string;
}> = [
  { name: "a query string", url: `${ROUTE}?x=1` },
  { name: "a JSON body", headers: { "content-type": "application/json" }, payload: "{}" },
  { name: "a body without a content type", payload: "x" },
  { name: "a transfer-encoding header", headers: { "transfer-encoding": "chunked" } },
];

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  root: string;
  stateDir: string;
}

const apps: FastifyInstance[] = [];
const databases: DatabaseSync[] = [];
const temps: string[] = [];
const fakeChildren: FakeChild[] = [];

afterEach(async () => {
  for (const child of fakeChildren.splice(0)) {
    child.destroy();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "commands-rest-"));
  temps.push(root);
  const stateDir = join(root, "state dir");
  const db = openDb(":memory:");
  databases.push(db);
  const app = createApp({
    db,
    assembly: {
      runtime: {
        bin: join(root, "omp-bin"),
        sandboxRoot: join(root, "sandbox"),
        stateDir,
        modelId: MODEL,
      },
    },
  });
  apps.push(app);
  return { app, db, root, stateDir };
}

function writeSkill(skillsDir: string, entry: string, frontmatter: readonly string[]): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(join(skillsDir, entry, "SKILL.md"), `---\n${frontmatter.join("\n")}\n---\n正文\n`);
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

  it("lists the two builtins then the installed skills by name, five keys each, touching no row or process", async () => {
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
      },
      {
        name: "skill:weekly-report",
        label: "weekly-report",
        description: "写周报",
        hint: "可选参数",
        source: "skill",
      },
    ];
    const body = response.json<{ commands: Array<Record<string, unknown>> }>();
    expect(body.commands).toHaveLength(4);
    expect(body.commands.map((command) => Object.keys(command))).toEqual([
      FIVE_KEYS,
      FIVE_KEYS,
      FIVE_KEYS,
      FIVE_KEYS,
    ]);
    expect(response.payload).toBe(JSON.stringify({ commands: expected }));
    expect({
      audit: rowCount(db, "audit_events"),
      sessions: rowCount(db, "chat_sessions"),
    }).toEqual(before);
    expect(app.sessions.supervisor.liveProcessCount()).toBe(0);
  });

  it.each(REJECTED)("is 400 bad_request for the owner sending $name", async (input) => {
    const { app } = openWorld();
    const cookie = await loginSessionPair(app);
    const { url = ROUTE, headers = {}, payload } = input;

    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, cookie },
      ...(payload === undefined ? {} : { payload }),
    });

    expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
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
        token: "a".repeat(64),
        resumePath: null,
      },
      recording,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
    const exported = join(String(calls[0]?.env.HOME), ".omp", "agent");
    expect(exported).toBe(ompAgentDir(stateDir));
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
    });
  });
});
