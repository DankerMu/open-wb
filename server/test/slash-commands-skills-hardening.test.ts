/**
 * Issue #706 cut 1 (agent-dir-host-hardening): `listSkills` follows a link only inside
 * `<agentDir>/skills`, reads at most the first 256 entries and opens SKILL.md with
 * `O_NOCTTY | O_NOFOLLOW`. `node:fs` is passed through a call recorder (behaviour untouched) so
 * "not opened, not resolved" and the open flags are observations, not inferences. Expected values
 * are the literals of chat-sessions Scenario「Skill links leaving the skills directory and the
 * entry cap」; nothing here is derived from the module under test.
 */
import {
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import { listSkills } from "../src/sessions/slash-commands.js";
import { loginSessionPair } from "./session-db-helpers.js";

/** Every `openSync`/`realpathSync` call made through a named `node:fs` import, in call order. */
const fsCalls = vi.hoisted(() => [] as Array<{ name: string; args: unknown[] }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = <T extends object>(name: string, fn: T): T =>
    new Proxy(fn, {
      apply(target, self, args) {
        fsCalls.push({ name, args });
        return Reflect.apply(target as (...values: unknown[]) => unknown, self, args);
      },
    });
  return {
    ...actual,
    openSync: record("openSync", actual.openSync),
    realpathSync: record("realpathSync", actual.realpathSync),
  };
});

const OUTSIDE_DIR_DESCRIPTION = "outside directory description";
const OUTSIDE_FILE_DESCRIPTION = "outside file description";
const CAP = 256;
const TOTAL = 300;

/** Teardown steps of the running case, executed last-registered first. */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A canonical temporary directory (no symlinked component), removed after the case. */
function canonicalTemp(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A fresh root holding `agent/` (the agentDir) and room for paths outside of it. */
function makeRoot(): { root: string; agentDir: string; skillsDir: string } {
  const root = canonicalTemp("skills-hardening-");
  const agentDir = join(root, "agent");
  return { root, agentDir, skillsDir: join(agentDir, "skills") };
}

function skillFile(lines: readonly string[]): string {
  return `---\n${lines.join("\n")}\n---\n正文\n`;
}

function writeSkill(dir: string, entry: string, lines: readonly string[]): void {
  mkdirSync(join(dir, entry), { recursive: true });
  writeFileSync(join(dir, entry, "SKILL.md"), skillFile(lines));
}

/** The spec tree: `inside`, `alias` → `inside`, `escape` → a directory outside, `leak/SKILL.md` → a file outside. */
function plantLinks(root: string, skillsDir: string): void {
  writeSkill(skillsDir, "inside", ["name: inside", "description: 内部技能"]);
  symlinkSync(join(skillsDir, "inside"), join(skillsDir, "alias"), "dir");
  writeSkill(join(root, "outside"), "target", [`description: ${OUTSIDE_DIR_DESCRIPTION}`]);
  symlinkSync(join(root, "outside", "target"), join(skillsDir, "escape"), "dir");
  writeFileSync(
    join(root, "outside.md"),
    skillFile(["name: leaked", `description: ${OUTSIDE_FILE_DESCRIPTION}`]),
  );
  mkdirSync(join(skillsDir, "leak"));
  symlinkSync(join(root, "outside.md"), join(skillsDir, "leak", "SKILL.md"));
}

/** `listSkills` with the recorder reset first, and the calls it made. */
function recordedList(agentDir: string): {
  skills: Array<{ name: string; description: string }>;
  opened: Array<{ path: unknown; flags: unknown }>;
  resolved: unknown[];
} {
  fsCalls.length = 0;
  const skills = listSkills(agentDir);
  const calls = fsCalls.splice(0);
  return {
    skills,
    opened: calls
      .filter((call) => call.name === "openSync")
      .map((call) => ({ path: call.args[0], flags: call.args[1] })),
    resolved: calls.filter((call) => call.name === "realpathSync").map((call) => call.args[0]),
  };
}

function entryName(index: number): string {
  return `skill-${String(index).padStart(3, "0")}`;
}

describe("listSkills: links leaving the skills directory", () => {
  it("lists inside once and nothing from a directory link or a file link that leaves skills", () => {
    const { root, agentDir, skillsDir } = makeRoot();
    plantLinks(root, skillsDir);

    const { skills, opened } = recordedList(agentDir);

    expect(skills).toEqual([{ name: "inside", description: "内部技能" }]);
    // `alias` is opened through its resolved path; `escape` and `leak` are never opened.
    expect(opened.map((call) => call.path)).toEqual([
      join(skillsDir, "inside", "SKILL.md"),
      join(skillsDir, "inside", "SKILL.md"),
    ]);
  });

  it("still follows a link that stays inside skills", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "real", ["description: 目录链接的目标"]);
    symlinkSync(join(skillsDir, "real"), join(skillsDir, "dir-link"), "dir");
    writeSkill(skillsDir, "shared", ["description: 文件链接的目标"]);
    mkdirSync(join(skillsDir, "file-link"));
    symlinkSync(join(skillsDir, "shared", "SKILL.md"), join(skillsDir, "file-link", "SKILL.md"));

    expect(listSkills(agentDir)).toEqual([
      { name: "dir-link", description: "目录链接的目标" },
      { name: "file-link", description: "文件链接的目标" },
      { name: "real", description: "目录链接的目标" },
      { name: "shared", description: "文件链接的目标" },
    ]);
  });

  it("does not take a sibling directory whose name starts with `skills` for the inside", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", ["description: kept"]);
    writeSkill(join(agentDir, "skills-evil"), "target", [
      `description: ${OUTSIDE_DIR_DESCRIPTION}`,
    ]);
    symlinkSync(join(agentDir, "skills-evil", "target"), join(skillsDir, "evil"), "dir");

    const { skills, opened } = recordedList(agentDir);

    expect(skills).toEqual([{ name: "kept", description: "kept" }]);
    expect(opened.map((call) => call.path)).toEqual([join(skillsDir, "kept", "SKILL.md")]);
  });

  it("opens SKILL.md with O_RDONLY | O_NONBLOCK | O_NOCTTY | O_NOFOLLOW", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", ["description: kept"]);

    const { skills, opened } = recordedList(agentDir);

    expect(skills).toEqual([{ name: "kept", description: "kept" }]);
    expect(opened).toHaveLength(1);
    const flags = opened[0]?.flags;
    expect(typeof flags).toBe("number");
    for (const flag of [constants.O_NOCTTY, constants.O_NOFOLLOW, constants.O_NONBLOCK]) {
      expect(flag).not.toBe(0);
      expect((flags as number) & flag).toBe(flag);
    }
    expect((flags as number) & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
  });
});

describe("listSkills: entry cap", () => {
  it("lists exactly the first 256 of 300 entries and neither opens nor resolves the other 44", () => {
    const { agentDir, skillsDir } = makeRoot();
    for (let index = 0; index < TOTAL; index += 1) {
      writeSkill(skillsDir, entryName(index), [`description: d-${index}`]);
    }
    const kept = Array.from({ length: CAP }, (_, index) => index);
    const dropped = Array.from({ length: TOTAL - CAP }, (_, index) => entryName(CAP + index));
    expect(dropped).toHaveLength(44);

    const { skills, opened, resolved } = recordedList(agentDir);

    expect(skills).toEqual(
      kept.map((index) => ({ name: entryName(index), description: `d-${index}` })),
    );
    expect(opened.map((call) => call.path)).toEqual(
      kept.map((index) => join(skillsDir, entryName(index), "SKILL.md")),
    );
    // One resolution of `skills` itself per call, then one per kept entry.
    expect(resolved).toEqual([
      skillsDir,
      ...kept.map((index) => join(skillsDir, entryName(index), "SKILL.md")),
    ]);
    const touched = [...opened.map((call) => call.path), ...resolved].map(String);
    for (const entry of dropped) {
      expect(touched.filter((path) => path.includes(entry))).toEqual([]);
    }
  });
});

describe("GET /api/commands: links leaving the skills directory", () => {
  it("carries the inside skill and neither outside description", async () => {
    const root = canonicalTemp("skills-hardening-rest-");
    const stateDir = join(root, "state");
    const runtime = {
      bin: join(root, "omp-bin"),
      sandboxRoot: join(root, "sandbox"),
      stateDir,
      modelId: "deepseek-v4.1-flash",
    };
    const db = openDb(":memory:");
    cleanups.push(() => db.close());
    const app = createApp({ db, assembly: { runtime } });
    cleanups.push(() => app.close());
    plantLinks(root, join(ompAgentDir(stateDir), "skills"));
    const cookie = await loginSessionPair(app);

    const response = await app.inject({ method: "GET", url: "/api/commands", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ commands: Array<{ name: string; description: string }> }>();
    expect(body.commands.map((command) => command.name)).toEqual([
      "compact",
      "todo",
      "skill:inside",
    ]);
    expect(body.commands[2]?.description).toBe("内部技能");
    expect(response.payload).not.toContain(OUTSIDE_DIR_DESCRIPTION);
    expect(response.payload).not.toContain(OUTSIDE_FILE_DESCRIPTION);
    expect(response.payload).not.toContain("leaked");
  });
});
