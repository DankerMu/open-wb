/**
 * Issue #813 (#773 task group 1): `listProjectSkills` and `sessionSkills` over real directories.
 * Expected values are the literals of chat-sessions Scenario「Project skills are listed from the
 * session cwd upwards」; nothing here is derived from the module under test. The link, hard-link,
 * FIFO, size and cap cases of a project directory are in slash-commands-skills-hardening.test.ts,
 * next to the call recorder they need.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPrompt,
  listProjectSkills,
  listSkills,
  sessionSkills,
  toWireText,
} from "../src/sessions/slash-commands.js";

/** 300 code points, half of them astral: a cut by UTF-16 units would keep 100, not 200. */
const LONG = "技😀".repeat(150);
const LONG_CUT = "技😀".repeat(100);

const temps: string[] = [];

afterEach(() => {
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
  it("lists .omp/skills from the cwd up to the sandbox root, nearest name first, descriptions cut to 200 code points", () => {
    const { sandboxRoot, workspaceRoot } = plantTree();

    expect(listProjectSkills(workspaceRoot, sandboxRoot)).toEqual([
      { name: "long", description: LONG_CUT },
      { name: "near", description: "close" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "root", description: "sandbox-wide" },
      { name: "weekly-report", description: "项目自己的周报" },
    ]);
    expect(Array.from(LONG)).toHaveLength(300);
    expect(Array.from(LONG_CUT)).toHaveLength(200);
  });

  it("lists the owner root's and the sandbox root's skills for an owner-root cwd, and only the root's for the root", () => {
    const { sandboxRoot, ownerRoot } = plantTree();

    expect(listProjectSkills(ownerRoot, sandboxRoot)).toEqual([
      { name: "near", description: "far" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "root", description: "sandbox-wide" },
    ]);
    expect(listProjectSkills(sandboxRoot, sandboxRoot)).toEqual([
      { name: "root", description: "sandbox-wide" },
    ]);
  });

  it("stops after the directory holding a .git entry, which is still read", () => {
    const inWorkspace = plantTree();
    writeFileSync(join(inWorkspace.workspaceRoot, ".git"), "gitdir: elsewhere\n");
    const inOwnerRoot = plantTree();
    mkdirSync(join(inOwnerRoot.ownerRoot, ".git"));

    expect(listProjectSkills(inWorkspace.workspaceRoot, inWorkspace.sandboxRoot)).toEqual(
      WORKSPACE_LEVEL,
    );
    expect(listProjectSkills(inOwnerRoot.workspaceRoot, inOwnerRoot.sandboxRoot)).toEqual([
      { name: "long", description: LONG_CUT },
      { name: "near", description: "close" },
      { name: "owner-wide", description: "for every workspace" },
      { name: "weekly-report", description: "项目自己的周报" },
    ]);
  });

  it("is [] and does not throw for a cwd outside the sandbox root, a missing cwd or a missing root", () => {
    const { above, sandboxRoot, workspaceRoot } = plantTree();

    expect(listProjectSkills(above, sandboxRoot)).toEqual([]);
    expect(listProjectSkills(`${sandboxRoot}-sibling`, sandboxRoot)).toEqual([]);
    mkdirSync(`${sandboxRoot}-sibling/.omp/skills`, { recursive: true });
    writeSkill(`${sandboxRoot}-sibling/.omp/skills`, "sibling", "name prefix of the root");
    expect(listProjectSkills(`${sandboxRoot}-sibling`, sandboxRoot)).toEqual([]);
    expect(listProjectSkills(join(workspaceRoot, "gone"), sandboxRoot)).toEqual([]);
    expect(listProjectSkills(workspaceRoot, join(above, "no-sandbox"))).toEqual([]);
  });

  it("is recomputed on every call", () => {
    const { sandboxRoot, workspaceRoot } = plantTree();
    const before = listProjectSkills(workspaceRoot, sandboxRoot).map((skill) => skill.name);

    writeSkill(join(workspaceRoot, ".omp", "skills"), "added", "later");

    expect(before).not.toContain("added");
    expect(listProjectSkills(workspaceRoot, sandboxRoot).map((skill) => skill.name)).toContain(
      "added",
    );
  });
});

describe("sessionSkills", () => {
  it("is the platform skills without the replaced one, then the project skills, the replacing one alone with overrides", () => {
    const { agentDir, sandboxRoot, workspaceRoot } = plantTree();

    expect(sessionSkills(agentDir, workspaceRoot, sandboxRoot)).toEqual([
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

  it("is the platform skills alone for an unresolvable cwd, and leaves listSkills as it was", () => {
    const { agentDir, sandboxRoot } = plantTree();
    const platform = [
      { name: "code-review", description: "Review a diff" },
      { name: "weekly-report", description: "平台的周报" },
    ];

    expect(sessionSkills(agentDir, null, sandboxRoot)).toEqual(
      platform.map((skill) => ({ ...skill, source: "skill", overrides: false })),
    );
    expect(listSkills(agentDir)).toEqual(platform);
  });

  it("makes a project skill a command for classifyPrompt and toWireText", () => {
    const { agentDir, sandboxRoot, ownerRoot, workspaceRoot } = plantTree();
    writeSkill(join(workspaceRoot, ".omp", "skills"), "deploy", "上线");
    const text = "/skill:deploy 上线";

    const bound = sessionSkills(agentDir, workspaceRoot, sandboxRoot);
    const unbound = sessionSkills(agentDir, ownerRoot, sandboxRoot);

    expect(classifyPrompt(text, bound)).toEqual({ kind: "skill", name: "deploy" });
    expect(toWireText(text, bound)).toBe(text);
    expect(classifyPrompt(text, unbound)).toEqual({ kind: "text" });
    expect(toWireText(text, unbound)).toBe(` ${text}`);
  });
});
