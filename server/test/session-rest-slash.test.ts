/**
 * Issue #555 prompt-route escaping (parent s1c-session-metadata-presentation tasks 10.4b, design
 * D15; chat-sessions Scenario「Slash text reaches storage as typed and omp as decided」). Every
 * world is the production createApp → registerSessions assembly over a real in-memory SQLite,
 * driven through `app.inject()`. `app.sessions.supervisor.prompt` is a resolving spy: the wire text
 * is the argument the route hands the supervisor, and no omp process is ever spawned. Skills are
 * real `SKILL.md` files under `ompAgentDir(stateDir)/skills`. Oracles: response status, the spy's
 * arguments, SQLite rows, the spawn log and the `readdirSync` calls naming `<agentDir>/skills`.
 */
import fs, { mkdirSync, writeFileSync } from "node:fs";
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
  };
}

type World = Awaited<ReturnType<typeof openWorld>>;

function installSkill(world: World, name: string): void {
  mkdirSync(join(world.skillsDir, name), { recursive: true });
  writeFileSync(
    join(world.skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: 测试用的 ${name}\n---\n正文\n`,
  );
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
