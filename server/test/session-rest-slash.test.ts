/**
 * Issue #555 prompt-route escaping (parent s1c-session-metadata-presentation tasks 10.4b, design
 * D15; chat-sessions Scenario「Slash text reaches storage as typed and omp as decided」). Every
 * world is the production createApp → registerSessions assembly over a real in-memory SQLite,
 * driven through `app.inject()`. `app.sessions.supervisor.prompt` is a resolving spy: the wire text
 * is the argument the route hands the supervisor, and no omp process is ever spawned. Skills are
 * real `SKILL.md` files under `ompAgentDir(stateDir)/skills`. Oracles: response status, the spy's
 * arguments, SQLite rows, the spawn log and the `readdirSync` calls naming `<agentDir>/skills`.
 * Issue #813 (#773 task group 1; Scenario「A project skill is a command for the prompt route,
 * regenerate and fork」): the skills are those of the session's own cwd. Workspaces are created
 * over `POST /api/workspaces`, bound sessions over `POST /api/sessions {workspaceId}`, project
 * skills are real `SKILL.md` files under `<root>/.omp/skills`.
 */
import fs, { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import { postPrompt } from "./session-rest-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import {
  createControlledRuntime,
  createSession,
  openBareSession,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";

const SKILL = "weekly-report";

/** What the owner typed, what SQLite must hold (the trimmed original) and what omp must be handed. */
const INPUTS = [
  { typed: "/todo", stored: "/todo", wire: "/todo" },
  { typed: "/todo append 买菜", stored: "/todo append 买菜", wire: "/todo append 买菜" },
  {
    typed: "/skill:weekly-report 写周报",
    stored: "/skill:weekly-report 写周报",
    wire: "/skill:weekly-report 写周报",
  },
  { typed: "  /session delete", stored: "/session delete", wire: " /session delete" },
  { typed: "/TODO", stored: "/TODO", wire: " /TODO" },
  { typed: "/skill:nope", stored: "/skill:nope", wire: " /skill:nope" },
  { typed: "/etc/hosts 是什么", stored: "/etc/hosts 是什么", wire: " /etc/hosts 是什么" },
] as const;

const fixtures: SupervisorApp[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

/** A logged-in owner with one idle session; `wire` records every text handed to the supervisor. */
async function openWorld() {
  const rt = createControlledRuntime(() => {});
  const opened = await openBareSession(rt.runtime);
  fixtures.push(opened.fixture);
  const wire = vi.spyOn(opened.fixture.supervisor, "prompt").mockResolvedValue(undefined);
  return {
    ...opened,
    wire,
    spawns: rt.calls,
    skillsDir: join(ompAgentDir(rt.runtime.stateDir), "skills"),
    sandboxRoot: rt.runtime.sandboxRoot,
  };
}

type World = Awaited<ReturnType<typeof openWorld>>;

function installSkill(world: World, name: string, skillsDir = world.skillsDir): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(
    join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: 测试用的 ${name}\n---\n正文\n`,
  );
}

function projectSkills(dir: string): string {
  return join(dir, ".omp", "skills");
}

/** A workspace of the owner; `session()` creates a fresh idle session bound to it. */
async function openBound(world: World, dir: string) {
  const headers = { cookie: world.cookie, "content-type": "application/json" };
  // The workspace store realpaths the sandbox root, so it has to exist first.
  mkdirSync(world.sandboxRoot, { recursive: true });
  const made = await world.fixture.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers,
    payload: JSON.stringify({ name: dir, dir }),
  });
  expect(made.statusCode).toBe(201);
  const workspace = made.json<{ id: string; root: string }>();
  const session = async (): Promise<string> => {
    const created = await world.fixture.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers,
      payload: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(created.statusCode).toBe(201);
    return created.json<{ id: string }>().id;
  };
  return { root: workspace.root, session };
}

/** Prompts an idle session (a fresh one unless given) and returns the text the supervisor got. */
async function promptOn(world: World, message: string, session?: string): Promise<string> {
  const target = session ?? (await createSession(world.fixture.app, world.cookie));
  const before = world.wire.mock.calls.length;
  const response = await postPrompt(
    world.fixture.app,
    target,
    world.cookie,
    JSON.stringify({ message }),
  );
  expect(response.statusCode).toBe(202);
  expect(world.wire.mock.calls.slice(before).map(([id]) => id)).toEqual([target]);
  return String(world.wire.mock.calls.at(-1)?.[1]);
}

function userContents(world: World, session: string): unknown[] {
  return world.fixture.db
    .prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id")
    .all(session)
    .map((row) => row.content);
}

/** `readdirSync` call-through spy; returns how often `<agentDir>/skills` was enumerated so far. */
function spySkillScans(world: World): () => number {
  const spy = vi.spyOn(fs, "readdirSync");
  syncBuiltinESMExports();
  return () => spy.mock.calls.filter(([path]) => String(path) === world.skillsDir).length;
}

describe("prompt route slash escaping (#555)", () => {
  for (const { typed, stored, wire } of INPUTS) {
    it(`E1 ${JSON.stringify(typed)} is stored as typed and reaches the supervisor as ${JSON.stringify(wire)}`, async () => {
      const world = await openWorld();
      installSkill(world, SKILL);

      const sent = await promptOn(world, typed, world.session);

      expect(userContents(world, world.session)).toEqual([stored]);
      expect(sent).toBe(wire);
      expect(world.spawns).toHaveLength(0);
    });
  }

  it("#704 `/todo export <path>` is stored as typed and reaches the supervisor escaped", async () => {
    const world = await openWorld();
    const text = "/todo export /abs/x.md";

    const sent = await promptOn(world, text, world.session);

    expect(userContents(world, world.session)).toEqual([text]);
    expect(sent).toBe(` ${text}`);
    expect(world.spawns).toHaveLength(0);
  });

  it("E2 a fresh session's title is the 18-code-point prefix of the original slash text", async () => {
    const world = await openWorld();
    const text = `/session ${"😀".repeat(10)} delete now`;

    await promptOn(world, text, world.session);

    expect(sessionRow(world.fixture.db, world.session).title).toBe(`/session ${"😀".repeat(9)}`);
    expect(userContents(world, world.session)).toEqual([text]);
  });

  it("E3 text not starting with `/` goes out verbatim without listing the skills directory", async () => {
    const world = await openWorld();
    installSkill(world, SKILL);
    const scans = spySkillScans(world);

    for (const text of ["今天 /skill:weekly-report 帮我", "hello /todo", "plain text"]) {
      expect(await promptOn(world, text)).toBe(text);
    }
    expect(scans()).toBe(0);

    // Positive control: the same spy does see the scan a `/`-prefixed prompt needs.
    expect(await promptOn(world, "/skill:weekly-report 写周报")).toBe(
      "/skill:weekly-report 写周报",
    );
    expect(scans()).toBe(1);
  });

  it("E4 the skill list is not cached: a skill installed later turns the same text into a command", async () => {
    const world = await openWorld();
    const text = "/skill:late x";

    expect(await promptOn(world, text)).toBe(` ${text}`);
    installSkill(world, "late");
    expect(await promptOn(world, text)).toBe(text);
  });
});

describe("prompt route classifies with the session's own skills (#813)", () => {
  const DEPLOY = "/skill:deploy 上线";

  it("sends a project skill of the session's workspace unchanged on the bound session and escaped elsewhere", async () => {
    const world = await openWorld();
    const bound = await openBound(world, "proj");
    const other = await openBound(world, "other");
    installSkill(world, "deploy", projectSkills(bound.root));

    const sessions = [await bound.session(), world.session, await other.session()];

    expect(await promptOn(world, DEPLOY, sessions[0])).toBe(DEPLOY);
    expect(await promptOn(world, DEPLOY, sessions[1])).toBe(` ${DEPLOY}`);
    expect(await promptOn(world, DEPLOY, sessions[2])).toBe(` ${DEPLOY}`);

    for (const session of sessions) {
      expect(userContents(world, session)).toEqual([DEPLOY]);
    }
    expect(world.spawns).toHaveLength(0);
  });

  it("sends an owner-root project skill and a platform skill unchanged on bound and unbound sessions", async () => {
    const world = await openWorld();
    const bound = await openBound(world, "proj");
    installSkill(world, "mine", projectSkills(join(world.sandboxRoot, "u1")));
    installSkill(world, SKILL);

    for (const session of [await bound.session(), world.session]) {
      expect(await promptOn(world, "/skill:mine x", session)).toBe("/skill:mine x");
    }
    expect(await promptOn(world, "/skill:weekly-report 写周报", await bound.session())).toBe(
      "/skill:weekly-report 写周报",
    );
  });

  it("counts no project skill once the workspace root is a symlink, and still the platform ones", async () => {
    const world = await openWorld();
    const bound = await openBound(world, "proj");
    installSkill(world, SKILL);
    installSkill(world, "deploy", projectSkills(join(world.sandboxRoot, "outside")));
    installSkill(world, "mine", projectSkills(join(world.sandboxRoot, "u1")));
    const sessions = [await bound.session(), await bound.session(), await bound.session()];
    rmSync(bound.root, { recursive: true });
    symlinkSync(join(world.sandboxRoot, "outside"), bound.root, "dir");

    expect(await promptOn(world, DEPLOY, sessions[0])).toBe(` ${DEPLOY}`);
    expect(await promptOn(world, "/skill:mine x", sessions[1])).toBe(" /skill:mine x");
    expect(await promptOn(world, "/skill:weekly-report 写周报", sessions[2])).toBe(
      "/skill:weekly-report 写周报",
    );
  });

  it("enumerates no project directory for text not starting with `/`", async () => {
    const world = await openWorld();
    const bound = await openBound(world, "proj");
    installSkill(world, "deploy", projectSkills(bound.root));
    const spy = vi.spyOn(fs, "opendirSync");
    syncBuiltinESMExports();

    expect(await promptOn(world, "今天 /skill:deploy 帮我", await bound.session())).toBe(
      "今天 /skill:deploy 帮我",
    );
    expect(spy.mock.calls).toHaveLength(0);

    // Positive control: the same spy sees the scan a `/`-prefixed prompt needs.
    expect(await promptOn(world, DEPLOY, await bound.session())).toBe(DEPLOY);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });
});
