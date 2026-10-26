/**
 * Issue #813 (#773 task group 1): `listProjectSkills` and `sessionSkills` over real directories.
 * Expected values are the literals of chat-sessions Scenario「Project skills are listed from the
 * session cwd upwards」; nothing here is derived from the module under test. The link, hard-link,
 * FIFO, size and cap cases of a project directory are in slash-commands-skills-hardening.test.ts,
 * next to the call recorder they need.
 * Issue #1692 (s1b-workspace-mounts task group 8; Scenario「A project skill link into a hung
 * mount」): the two project real paths come from the asynchronous `realpath` of `projectSkillFs`,
 * raced against its deadline. The test swaps that `realpath` for a recording one that never
 * settles for the hung path and injects a 1 s deadline; every synchronous `node:fs` call goes
 * through a call-through recorder into the same ordered log, so "no further filesystem call" and
 * "nothing below the mount synchronously" are observations. `远端` is a plain directory standing
 * for a registered mount: nothing in this listing reads the mount registry.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import {
  classifyPrompt,
  listProjectSkills,
  listSkills,
  projectSkillFs,
  sessionSkills,
  toWireText,
} from "../src/sessions/slash-commands.js";
import { createWorkspace, getDirectory, openWorld } from "./commands-rest-helpers.js";
import { loginSessionPair } from "./session-db-helpers.js";

/** Every `*Sync` call made through a named `node:fs` import, and every `projectSkillFs.realpath`. */
const fsCalls = vi.hoisted(() => [] as Array<{ name: string; path: string }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = <T extends object>(name: string, fn: T): T =>
    new Proxy(fn, {
      apply(target, self, args) {
        fsCalls.push({ name, path: String(args[0]) });
        return Reflect.apply(target as (...values: unknown[]) => unknown, self, args);
      },
    });
  const recorded: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (name.endsWith("Sync") && typeof value === "function") {
      recorded[name] = record(name, value);
    }
  }
  const native = record("realpathSync.native", actual.realpathSync.native);
  recorded.realpathSync = new Proxy(recorded.realpathSync as object, {
    get: (target, key, receiver) =>
      key === "native" ? native : Reflect.get(target, key, receiver),
  });
  return recorded;
});

/** 300 code points, half of them astral: a cut by UTF-16 units would keep 100, not 200. */
const LONG = "技😀".repeat(150);
const LONG_CUT = "技😀".repeat(100);

const temps: string[] = [];

const realRealpath = projectSkillFs.realpath;
const realDeadline = projectSkillFs.deadlineMs;

afterEach(() => {
  projectSkillFs.realpath = realRealpath;
  projectSkillFs.deadlineMs = realDeadline;
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeSkill(skillsDir: string, entry: string, description: string): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(
    join(skillsDir, entry, "SKILL.md"),
    `---\nname: ${entry}\ndescription: ${description}\n---\n正文\n`,
  );
}

/**
 * The spec tree. `above/` is the directory above the sandbox root; the owner root is
 * `sandbox/u1`, the workspace root `sandbox/u1/proj`; `agent/skills` is the platform directory.
 */
function plantTree() {
  const above = realpathSync(mkdtempSync(join(tmpdir(), "project-skills-")));
  temps.push(above);
  const sandboxRoot = join(above, "sandbox");
  const ownerRoot = join(sandboxRoot, "u1");
  const workspaceRoot = join(ownerRoot, "proj");
  const agentDir = join(above, "agent");
  writeSkill(join(above, ".omp", "skills"), "above", "above the sandbox root");
  writeSkill(join(sandboxRoot, ".omp", "skills"), "root", "sandbox-wide");
  writeSkill(join(ownerRoot, ".omp", "skills"), "owner-wide", "for every workspace");
  writeSkill(join(ownerRoot, ".omp", "skills"), "near", "far");
  writeSkill(join(workspaceRoot, ".omp", "skills"), "near", "close");
  writeSkill(join(workspaceRoot, ".omp", "skills"), "weekly-report", "项目自己的周报");
  writeSkill(join(workspaceRoot, ".omp", "skills"), "long", LONG);
  writeSkill(join(workspaceRoot, ".claude", "skills"), "cl", "another provider directory");
  writeSkill(join(above, "outside"), "target", "outside the skills directory");
  symlinkSync(
    join(above, "outside", "target"),
    join(workspaceRoot, ".omp", "skills", "escape"),
    "dir",
  );
  writeSkill(join(agentDir, "skills"), "weekly-report", "平台的周报");
  writeSkill(join(agentDir, "skills"), "code-review", "Review a diff");
  return { above, sandboxRoot, ownerRoot, workspaceRoot, agentDir };
}

const WORKSPACE_LEVEL = [
  { name: "long", description: LONG_CUT },
  { name: "near", description: "close" },
  { name: "weekly-report", description: "项目自己的周报" },
];

describe("listProjectSkills", () => {
  it("lists .omp/skills from the cwd up to the sandbox root, nearest name first, descriptions cut to 200 code points", async () => {
    const { sandboxRoot, workspaceRoot } = plantTree();
    // Issue #1587: written directly, `writeSkill` cannot give a name other than its entry.
    mkdirSync(join(workspaceRoot, ".omp", "skills", "back"));
    writeFileSync(
      join(workspaceRoot, ".omp", "skills", "back", "SKILL.md"),
      "---\nname: a\\b\ndescription: w\n---\n正文\n",
    );

    expect(await listProjectSkills(workspaceRoot, sandboxRoot)).toEqual([
      { name: "long", description: LONG_CUT },
      { name: "near", description: "close" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "root", description: "sandbox-wide" },
      { name: "weekly-report", description: "项目自己的周报" },
    ]);
    expect(Array.from(LONG)).toHaveLength(300);
    expect(Array.from(LONG_CUT)).toHaveLength(200);
  });

  it("lists the owner root's and the sandbox root's skills for an owner-root cwd, and only the root's for the root", async () => {
    const { sandboxRoot, ownerRoot } = plantTree();

    expect(await listProjectSkills(ownerRoot, sandboxRoot)).toEqual([
      { name: "near", description: "far" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "root", description: "sandbox-wide" },
    ]);
    expect(await listProjectSkills(sandboxRoot, sandboxRoot)).toEqual([
      { name: "root", description: "sandbox-wide" },
    ]);
  });

  it("stops after the directory holding a .git entry, which is still read", async () => {
    const inWorkspace = plantTree();
    writeFileSync(join(inWorkspace.workspaceRoot, ".git"), "gitdir: elsewhere\n");
    const inOwnerRoot = plantTree();
    mkdirSync(join(inOwnerRoot.ownerRoot, ".git"));

    expect(await listProjectSkills(inWorkspace.workspaceRoot, inWorkspace.sandboxRoot)).toEqual(
      WORKSPACE_LEVEL,
    );
    expect(await listProjectSkills(inOwnerRoot.workspaceRoot, inOwnerRoot.sandboxRoot)).toEqual([
      { name: "long", description: LONG_CUT },
      { name: "near", description: "close" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "weekly-report", description: "项目自己的周报" },
    ]);
  });

  it("is [] and does not throw for a cwd outside the sandbox root, a missing cwd or a missing root", async () => {
    const { above, sandboxRoot, workspaceRoot } = plantTree();

    expect(await listProjectSkills(above, sandboxRoot)).toEqual([]);
    expect(await listProjectSkills(`${sandboxRoot}-sibling`, sandboxRoot)).toEqual([]);
    mkdirSync(`${sandboxRoot}-sibling/.omp/skills`, { recursive: true });
    writeSkill(`${sandboxRoot}-sibling/.omp/skills`, "sibling", "name prefix of the root");
    expect(await listProjectSkills(`${sandboxRoot}-sibling`, sandboxRoot)).toEqual([]);
    expect(await listProjectSkills(join(workspaceRoot, "gone"), sandboxRoot)).toEqual([]);
    expect(await listProjectSkills(workspaceRoot, join(above, "no-sandbox"))).toEqual([]);
  });

  it("is recomputed on every call", async () => {
    const { sandboxRoot, workspaceRoot } = plantTree();
    const before = (await listProjectSkills(workspaceRoot, sandboxRoot)).map((skill) => skill.name);

    writeSkill(join(workspaceRoot, ".omp", "skills"), "added", "later");

    expect(before).not.toContain("added");
    expect(
      (await listProjectSkills(workspaceRoot, sandboxRoot)).map((skill) => skill.name),
    ).toContain("added");
  });
});

describe("sessionSkills", () => {
  it("is the platform skills without the replaced one, then the project skills, the replacing one alone with overrides", async () => {
    const { agentDir, sandboxRoot, workspaceRoot } = plantTree();

    expect(await sessionSkills(agentDir, workspaceRoot, sandboxRoot)).toEqual([
      { name: "code-review", description: "Review a diff", source: "skill", overrides: false },
      { name: "long", description: LONG_CUT, source: "project", overrides: false },
      { name: "near", description: "close", source: "project", overrides: false },
      {
        name: "owner-wide",
        description: "for every workspace",
        source: "project",
        overrides: false,
      },
      { name: "root", description: "sandbox-wide", source: "project", overrides: false },
      { name: "weekly-report", description: "项目自己的周报", source: "project", overrides: true },
    ]);
  });

  it("is the platform skills alone for an unresolvable cwd, and leaves listSkills as it was", async () => {
    const { agentDir, sandboxRoot } = plantTree();
    const platform = [
      { name: "code-review", description: "Review a diff" },
      { name: "weekly-report", description: "平台的周报" },
    ];

    expect(await sessionSkills(agentDir, null, sandboxRoot)).toEqual(
      platform.map((skill) => ({ ...skill, source: "skill", overrides: false })),
    );
    expect(listSkills(agentDir)).toEqual(platform);
  });

  it("makes a project skill a command for classifyPrompt and toWireText", async () => {
    const { agentDir, sandboxRoot, ownerRoot, workspaceRoot } = plantTree();
    writeSkill(join(workspaceRoot, ".omp", "skills"), "deploy", "上线");
    const text = "/skill:deploy 上线";

    const bound = await sessionSkills(agentDir, workspaceRoot, sandboxRoot);
    const unbound = await sessionSkills(agentDir, ownerRoot, sandboxRoot);

    expect(classifyPrompt(text, bound)).toEqual({ kind: "skill", name: "deploy" });
    expect(toWireText(text, bound)).toBe(text);
    expect(classifyPrompt(text, unbound)).toEqual({ kind: "text" });
    expect(toWireText(text, unbound)).toBe(` ${text}`);
  });
});

const HUNG_DEADLINE_MS = 1000;
const BUILTINS = ["compact", "todo"];
/** Node may fire a timer a few ms early against `Date.now()`. */
const TIMER_SLACK_MS = 50;

/**
 * `projectSkillFs.realpath` replaced by one that records each call into the shared log and never
 * settles for a path ending in `hungSuffix` (resolving `hung` once that call is made); every other
 * call is the real one. The deadline is `HUNG_DEADLINE_MS`.
 */
function hangRealpath(hungSuffix: string): Promise<void> {
  let reached!: () => void;
  const hung = new Promise<void>((resolve) => {
    reached = resolve;
  });
  projectSkillFs.deadlineMs = HUNG_DEADLINE_MS;
  projectSkillFs.realpath = ((path: Buffer, options: { encoding: "buffer" }) => {
    fsCalls.push({ name: "realpath", path: String(path) });
    if (String(path).endsWith(hungSuffix)) {
      reached();
      return new Promise<never>(() => {});
    }
    return realRealpath(path, options);
  }) as typeof projectSkillFs.realpath;
  return hung;
}

/**
 * The spec world over the production createApp: a workspace of `u1` whose root holds the mount
 * directory `远端`, the owner root's `owner-wide` project skill and the platform skill
 * `code-review`. The host-created `.git` marker is removed so that, without a timeout, the walk
 * would go on to the owner root: `owner-wide` absent is then the observation that the listing
 * stopped.
 */
async function hungMountWorld() {
  const world = openWorld("hung-mount-skills-");
  const cookie = await loginSessionPair(world.app);
  const workspace = await createWorkspace(world.app, cookie, world.sandboxRoot);
  rmdirSync(join(workspace.root, ".git"));
  const mount = join(workspace.root, "远端");
  writeSkill(join(dirname(workspace.root), ".omp", "skills"), "owner-wide", "for every workspace");
  writeSkill(join(ompAgentDir(world.stateDir), "skills"), "code-review", "Review a diff");
  return { ...world, cookie, workspace, mount };
}

function commandNames(response: { json<T>(): T }): string[] {
  return response.json<{ commands: Array<{ name: string }> }>().commands.map((c) => c.name);
}

/** The recorded synchronous calls whose path is at or below one of `prefixes`. */
function syncCallsBelow(prefixes: readonly string[]) {
  return fsCalls.filter(
    (call) =>
      call.name !== "realpath" &&
      prefixes.some((prefix) => call.path === prefix || call.path.startsWith(`${prefix}/`)),
  );
}

describe("Scenario: A project skill link into a hung mount", () => {
  it("the deadline is 10 s by default", () => {
    expect(realDeadline).toBe(10_000);
  });

  it("lists near and neither remote nor owner-wide once the deadline passes; /api/workspaces is answered meanwhile", async () => {
    const { app, cookie, workspace, mount } = await hungMountWorld();
    const skills = join(workspace.root, ".omp", "skills");
    writeSkill(skills, "near", "close");
    writeSkill(join(mount, "shared"), "remote", "behind the mount");
    symlinkSync(join(mount, "shared", "remote"), join(skills, "remote"), "dir");
    // Positive control: without a hang the walk reaches the owner root.
    expect(commandNames(await getDirectory(app, "/api/commands", cookie, workspace.id))).toEqual([
      ...BUILTINS,
      "skill:code-review",
      "skill:near",
      "skill:owner-wide",
    ]);
    const hung = hangRealpath("/remote/SKILL.md");
    fsCalls.length = 0;

    const started = Date.now();
    let settled = false;
    const commands = getDirectory(app, "/api/commands", cookie, workspace.id).finally(() => {
      settled = true;
    });
    await hung;
    const hungAt = fsCalls.length;
    const workspaces = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie },
    });
    const workspacesAfter = Date.now() - started;
    // What GET /api/workspaces itself touched (the commands listing is parked on the hung call).
    const answeredAt = fsCalls.length;
    expect(workspaces.statusCode).toBe(200);
    expect(settled).toBe(false);
    expect(workspacesAfter).toBeLessThan(HUNG_DEADLINE_MS);

    const response = await commands;
    expect(Date.now() - started).toBeGreaterThanOrEqual(HUNG_DEADLINE_MS - TIMER_SLACK_MS);
    expect(response.statusCode).toBe(200);
    expect(commandNames(response)).toEqual([...BUILTINS, "skill:code-review", "skill:near"]);
    // The hung real path is the listing's last filesystem call: no entry or farther directory
    // after it, neither while GET /api/workspaces ran nor once the deadline passed.
    expect(fsCalls[hungAt - 1]).toEqual({
      name: "realpath",
      path: join(skills, "remote", "SKILL.md"),
    });
    expect(fsCalls.slice(hungAt, answeredAt).filter((call) => call.path.includes("/.omp"))).toEqual(
      [],
    );
    expect(fsCalls.slice(answeredAt)).toEqual([]);
    expect(syncCallsBelow([mount, join(skills, "remote")])).toEqual([]);
  });

  it("yields nothing for the workspace root nor the owner root when <root>/.omp is a link into the mount", async () => {
    const { app, cookie, workspace, mount } = await hungMountWorld();
    writeSkill(join(mount, "omp", "skills"), "inside-mount", "behind the mount");
    symlinkSync(join(mount, "omp"), join(workspace.root, ".omp"), "dir");
    const hung = hangRealpath(`${workspace.root}/.omp/skills`);
    fsCalls.length = 0;

    const started = Date.now();
    const commands = getDirectory(app, "/api/commands", cookie, workspace.id);
    await hung;
    const hungAt = fsCalls.length;
    const response = await commands;

    expect(Date.now() - started).toBeGreaterThanOrEqual(HUNG_DEADLINE_MS - TIMER_SLACK_MS);
    expect(response.statusCode).toBe(200);
    expect(commandNames(response)).toEqual([...BUILTINS, "skill:code-review"]);
    expect(fsCalls.slice(hungAt)).toEqual([]);
    expect(syncCallsBelow([mount, join(workspace.root, ".omp")])).toEqual([]);
  });
});
