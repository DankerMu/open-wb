/**
 * Issue #815 (#773 task 3.1): the location table of chat-sessions Requirement「项目配置文件列表」
 * pinned against the official omp v18.0.10 binary, in the world of support/omp-official.ts (cwd
 * `u1/proj`, depth 1 `u1`, the sandbox root at depth 2 holding the `.git` test device). Each case
 * plants only the files it names, each with a unique marker, and asks the freshly started process
 * for `get_state`: an instruction or system file is read when its marker is in `systemPrompt`, an
 * agent definition when its `description` marker is in the `task` tool's description (`dumpTools`;
 * an agent body appears in neither). The host's `listProjectConfig` is checked on the same tree
 * against literals, so the table and the route cannot drift apart unnoticed. No case puts two
 * instruction files in one directory: omp keeps one per level. Opt-in: skipped
 * unless `WORKBUDDY_OMP_TEST=1`. When an omp upgrade turns a case red, the spec changes first.
 *
 * #1567: `spawnOmp` plants a `.git` marker in the cwd, which ends omp's walk there. The rows that
 * describe omp's own walk above the cwd run with that marker removed by a test-only spawn wrapper
 * (`unmarked`); rows that plant their own `${CWD}/.git/` and the depth-0 rows run as the product
 * does; the agents rows, which no `.git` bounds, run both ways; the「with the host marker」rows are
 * the product's outcome for the same files one level up (omp-runtime「祖先的系统提示不再进入会话
 * （真实 omp）」, the part v18.0.10 can show). `.clinerules` is not bounded by `.git` (omp's cline
 * provider walks to the filesystem root), pinned here as the residual ADR-0012 part 三 registers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProjectConfig } from "../src/sessions/rest-project-config.js";
import { OMP_TEST_OFF, OMP_VERSION, openOfficialWorld } from "./support/omp-official.js";

const TURN = { timeout: 90_000 };
/** The three directories a case plants in, as paths relative to the sandbox root. */
const CWD = "u1/proj";
const UP = "u1";
const ROOT = ".";

interface Listed {
  path: string;
  kind: "instructions" | "system" | "agent";
  depth: number;
}

interface Case {
  name: string;
  /** Marker → file path relative to the sandbox root; the marker is the file's whole body. */
  files: Record<string, string>;
  /** Other paths relative to the sandbox root: a trailing `/` makes a directory, else a file. */
  extra?: string[];
  /** Markers omp must have read, and markers it must not have. */
  read: string[];
  unread?: string[];
  host: Listed[];
  /** `unmarked`: started with the host's fresh `.git` marker removed; `both`: once each way. */
  via?: "unmarked" | "both";
}

const instructions = (path: string, depth: number): Listed => ({
  path,
  kind: "instructions",
  depth,
});
const agent = (path: string, depth: number): Listed => ({ path, kind: "agent", depth });

/** One table row: the file alone at depth 0 and alone at depth 1, with no `.git` in between. */
function row(path: string, kind: Listed["kind"], everyLevel: boolean): Case[] {
  return [
    {
      name: `${path} in the cwd is read`,
      files: { "MARK-D0": `${CWD}/${path}` },
      read: ["MARK-D0"],
      host: [{ path, kind, depth: 0 }],
    },
    {
      name: `${path} one level up is ${everyLevel ? "read" : "not read"}`,
      files: { "MARK-D1": `${UP}/${path}` },
      read: everyLevel ? ["MARK-D1"] : [],
      unread: everyLevel ? [] : ["MARK-D1"],
      host: everyLevel ? [{ path, kind, depth: 1 }] : [],
      via: kind === "agent" ? "both" : "unmarked",
    },
  ];
}

/** The product's outcome: with the host's marker in the cwd, the file one level up is not read. */
function marked(path: string): Case {
  return {
    name: `with the host marker, ${path} one level up is not read`,
    files: { "MARK-D1": `${UP}/${path}` },
    read: [],
    unread: ["MARK-D1"],
    host: [],
  };
}

const CASES: Case[] = [
  ...row("AGENTS.md", "instructions", true),
  ...row(".agents/AGENTS.md", "instructions", true),
  ...row(".claude/CLAUDE.md", "instructions", false),
  ...row(".omp/AGENTS.md", "instructions", true),
  ...row(".omp/RULES.md", "instructions", true),
  ...row(".omp/SYSTEM.md", "system", false),
  ...row(".omp/agents/reviewer.md", "agent", true),
  {
    name: "a cwd .omp holding only an unrelated entry hides the parent's .omp/AGENTS.md and .omp/RULES.md",
    files: { "MARK-A": `${UP}/.omp/AGENTS.md`, "MARK-R": `${UP}/.omp/RULES.md` },
    extra: [`${CWD}/.omp/notes.txt`],
    read: [],
    unread: ["MARK-A", "MARK-R"],
    host: [],
    via: "unmarked",
  },
  {
    name: "an empty cwd .omp does not hide the parent's .omp/AGENTS.md and .omp/RULES.md",
    files: { "MARK-A": `${UP}/.omp/AGENTS.md`, "MARK-R": `${UP}/.omp/RULES.md` },
    extra: [`${CWD}/.omp/`],
    read: ["MARK-A", "MARK-R"],
    host: [instructions(".omp/AGENTS.md", 1), instructions(".omp/RULES.md", 1)],
    via: "unmarked",
  },
  {
    name: ".omp/AGENTS.md and .omp/RULES.md above the .git level are not read",
    files: { "MARK-A": `${UP}/.omp/AGENTS.md`, "MARK-R": `${UP}/.omp/RULES.md` },
    extra: [`${CWD}/.git/`],
    read: [],
    unread: ["MARK-A", "MARK-R"],
    host: [],
  },
  {
    name: "the nearest .omp/agents is found past a nearer .omp without agents",
    files: { "MARK-FAR": `${UP}/.omp/agents/far.md` },
    extra: [`${CWD}/.omp/notes.txt`],
    read: ["MARK-FAR"],
    host: [agent(".omp/agents/far.md", 1)],
    via: "both",
  },
  {
    name: "the nearest .omp/agents is found past a .git level",
    files: { "MARK-FAR": `${UP}/.omp/agents/far.md` },
    extra: [`${CWD}/.git/`],
    read: ["MARK-FAR"],
    host: [agent(".omp/agents/far.md", 1)],
  },
  {
    name: "a nearer .omp/agents hides a farther one",
    files: { "MARK-FAR": `${ROOT}/.omp/agents/far.md`, "MARK-NEAR": `${UP}/.omp/agents/near.md` },
    read: ["MARK-NEAR"],
    unread: ["MARK-FAR"],
    host: [agent(".omp/agents/near.md", 1)],
    via: "both",
  },
  {
    name: "an empty nearer .omp/agents hides a farther one",
    files: { "MARK-FAR": `${UP}/.omp/agents/far.md` },
    extra: [`${CWD}/.omp/agents/`],
    read: [],
    unread: ["MARK-FAR"],
    host: [],
    via: "both",
  },
  ...["AGENTS.md", ".agents/AGENTS.md"].map(
    (path): Case => ({
      name: `${path} stops at the .git level: read there, not above it`,
      files: { "MARK-AT": `${UP}/${path}`, "MARK-ABOVE": `${ROOT}/${path}` },
      extra: [`${UP}/.git/`],
      read: ["MARK-AT"],
      unread: ["MARK-ABOVE"],
      host: [instructions(path, 1)],
      via: "unmarked",
    }),
  ),
  {
    name: "AGENTS.md two levels up, with no .git below it, is read",
    files: { "MARK-D2": `${ROOT}/AGENTS.md` },
    read: ["MARK-D2"],
    host: [instructions("AGENTS.md", 2)],
    via: "unmarked",
  },
  ...["AGENTS.md", ".agents/AGENTS.md", ".omp/AGENTS.md", ".omp/RULES.md"].map(marked),
  {
    name: "with the host marker, AGENTS.md one level up is not read while .omp/agents there is",
    files: { "MARK-D1": `${UP}/AGENTS.md`, "MARK-FAR": `${UP}/.omp/agents/far.md` },
    read: ["MARK-FAR"],
    unread: ["MARK-D1"],
    host: [agent(".omp/agents/far.md", 1)],
  },
  {
    name: "with the host marker, an alwaysApply .clinerules one level up is read",
    files: { "MARK-D1": `${UP}/.clinerules` },
    read: ["MARK-D1"],
    host: [],
  },
];

/** Every case once per way it starts omp. */
const RUNS = CASES.flatMap(
  (testCase): Array<Case & { unmarked: boolean }> =>
    testCase.via === "both"
      ? [
          { ...testCase, name: `(host marker) ${testCase.name}`, unmarked: false },
          { ...testCase, name: `(marker removed) ${testCase.name}`, unmarked: true },
        ]
      : [{ ...testCase, unmarked: testCase.via === "unmarked" }],
);

/**
 * An agent definition whose `description` is the marker; a `.clinerules` whose frontmatter makes
 * omp inject it whole (`alwaysApply: true`) around the marker; any other file is the marker alone.
 */
function bodyOf(path: string, marker: string): string {
  if (path.includes("/agents/")) {
    return `---\nname: ${marker.toLowerCase()}\ndescription: ${marker}\n---\n正文\n`;
  }
  return path.endsWith(".clinerules") ? `---\nalwaysApply: true\n---\n${marker}\n` : `${marker}\n`;
}

function plant(sandboxRoot: string, testCase: Case): void {
  for (const [marker, path] of Object.entries(testCase.files)) {
    mkdirSync(dirname(join(sandboxRoot, path)), { recursive: true });
    writeFileSync(join(sandboxRoot, path), bodyOf(path, marker));
  }
  for (const path of testCase.extra ?? []) {
    mkdirSync(join(sandboxRoot, path.endsWith("/") ? path : dirname(path)), { recursive: true });
    if (!path.endsWith("/")) {
      writeFileSync(join(sandboxRoot, path), "x\n");
    }
  }
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: project config locations`, () => {
  it.each(RUNS)("$name", TURN, async (testCase) => {
    const world = await openOfficialWorld(({ sandboxRoot }) => plant(sandboxRoot, testCase), {
      hostMarker: !testCase.unmarked,
    });

    const state = (await world.runtime.command({ type: "get_state" })) as {
      systemPrompt: string[];
      dumpTools: Array<{ name: string; description: string }>;
    };
    const systemPrompt = state.systemPrompt.join("\n");
    const taskTool = state.dumpTools.find((tool) => tool.name === "task")?.description ?? "";
    /** Where omp shows the file a marker was written to. */
    const seen = (marker: string): boolean =>
      (testCase.files[marker]?.includes("/agents/") === true ? taskTool : systemPrompt).includes(
        marker,
      );

    expect(systemPrompt).not.toBe("");
    expect(taskTool).toContain("# Available Agents");
    expect(Object.fromEntries(Object.keys(testCase.files).map((m) => [m, seen(m)]))).toEqual(
      Object.fromEntries([
        ...testCase.read.map((marker) => [marker, true]),
        ...(testCase.unread ?? []).map((marker) => [marker, false]),
      ]),
    );
    expect(listProjectConfig(world.workspaceRoot, world.sandboxRoot)).toEqual(testCase.host);
  });
});
