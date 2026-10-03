/**
 * Issue #813 (#773 task 1.5): the host's skill directory and whitelist checked against the
 * official omp v18.0.10 binary — chat-sessions Scenario「A project skill is a command for the
 * prompt route, regenerate and fork」, real-binary part. A real `SessionRuntime` spawns the binary
 * in a workspace cwd of a managed state layout; the model endpoint is the fake upstream
 * (`models.yml` points straight at it and the token book issues its key; its bash tool call is
 * denied). Oracles are omp's own RPC answers: `get_available_commands` and `get_branch_messages`.
 * Opt-in: skipped unless `WORKBUDDY_OMP_TEST=1`; opted in, `OMP_BIN` must be the official binary
 * (`make omp-fetch`) — a missing or different one fails, it is never skipped. These pins bind the
 * host's scan rules to that omp version: when an omp upgrade turns one red, the spec changes first.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { writeHostOverlay } from "../src/sessions/omp/host-overlay.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { classifyPrompt, sessionSkills, toWireText } from "../src/sessions/slash-commands.js";
import { type FakeUpstreamServer, start } from "./support/fake-upstream.mjs";
import { collectPrompt } from "./support/omp-runtime.js";

const OMP_VERSION = "18.0.10";
const MODEL_ID = "deepseek-v4.1-flash";
const UPSTREAM_KEY = "fake";
const OWNER_ID = "u1";
const TURN = { timeout: 90_000 };
/** 300 code points, half of them astral: the host lists the first 200. */
const LONG = "长😀".repeat(150);

interface OmpCommand {
  name: string;
  description?: string;
}

interface World {
  runtime: SessionRuntime;
  agentDir: string;
  sandboxRoot: string;
  workspaceRoot: string;
}

/** Teardown steps of the running case, executed last-registered first. */
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function officialBin(): string {
  const bin = process.env.OMP_BIN;
  if (bin === undefined || bin === "") {
    throw new Error("WORKBUDDY_OMP_TEST=1 requires OMP_BIN (run `make omp-fetch`)");
  }
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (version !== `omp/${OMP_VERSION}`) {
    throw new Error(`OMP_BIN is ${version}, the pinned official binary is omp/${OMP_VERSION}`);
  }
  return bin;
}

function writeSkill(skillsDir: string, entry: string, description: string, body = "正文"): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(
    join(skillsDir, entry, "SKILL.md"),
    `---\nname: ${entry}\ndescription: ${description}\n---\n${body}\n`,
  );
}

/**
 * A managed state layout, a sandbox with the workspace `u1/proj`, the fake upstream and a
 * `SessionRuntime` on the official binary whose cwd is that workspace. `plant` writes the skills
 * before anything is spawned (the process starts with the first command or prompt).
 */
async function openWorld(
  plant: (dirs: { agentDir: string; ownerRoot: string; workspaceRoot: string }) => void,
): Promise<World> {
  const bin = officialBin();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-official-skills-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const sandboxRoot = join(root, "sandbox");
  const ownerRoot = join(sandboxRoot, OWNER_ID);
  const workspaceRoot = join(ownerRoot, "proj");
  mkdirSync(workspaceRoot, { recursive: true });
  // Test device: ends omp's own upward walk at the sandbox root, so nothing above the temporary
  // directory can be loaded (design D1 assumes no `.omp` above the sandbox root).
  mkdirSync(join(sandboxRoot, ".git"));
  const agentDir = ompAgentDir(stateDir);
  ensureOmpStateLayout(stateDir);
  const upstream: FakeUpstreamServer = await start({ apiKey: UPSTREAM_KEY });
  cleanups.push(() => upstream.close());
  await writeManagedModelsYml(agentDir, {
    proxyBaseUrl: `http://127.0.0.1:${String(upstream.port)}/v1`,
    modelId: MODEL_ID,
  });
  await writeHostOverlay(stateDir);
  plant({ agentDir, ownerRoot, workspaceRoot });
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-skills",
    bin,
    sandboxRoot,
    stateDir,
    ownerId: OWNER_ID,
    cwd: workspaceRoot,
    modelId: MODEL_ID,
    tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
    // The fake upstream opens every turn with a bash tool call: denied, so nothing is executed.
    onApproval: (request) => runtime.respondApproval(request.id, "deny"),
  });
  cleanups.push(() => runtime.shutdown());
  return { runtime, agentDir, sandboxRoot, workspaceRoot };
}

/** omp's `get_available_commands`; the runtime's `command` types only the frames the host sends. */
async function availableCommands(runtime: SessionRuntime): Promise<OmpCommand[]> {
  const data = await runtime.command({ type: "get_available_commands" } as never);
  return (data as { commands: OmpCommand[] }).commands;
}

async function branchTexts(runtime: SessionRuntime): Promise<string[]> {
  const data = await runtime.command({ type: "get_branch_messages" });
  return (data as { messages: Array<{ text: string }> }).messages.map((entry) => entry.text);
}

function hostSkills(world: World) {
  return sessionSkills(world.agentDir, world.workspaceRoot, world.sandboxRoot);
}

function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

describe.skipIf(process.env.WORKBUDDY_OMP_TEST !== "1")(
  `official omp v${OMP_VERSION}: project skills`,
  () => {
    it(
      "(a) lists every host-listed skill in get_available_commands with its description or its first 200 code points",
      TURN,
      async () => {
        const world = await openWorld(({ agentDir, ownerRoot, workspaceRoot }) => {
          writeSkill(join(agentDir, "skills"), "platform-only", "平台技能");
          writeSkill(join(ownerRoot, ".omp", "skills"), "owner-wide", "上层目录的技能");
          writeSkill(join(workspaceRoot, ".omp", "skills"), "deploy", "上线到生产");
          writeSkill(join(workspaceRoot, ".omp", "skills"), "long", LONG);
        });

        const omp = await availableCommands(world.runtime);
        const listed = hostSkills(world);

        expect(listed.map((skill) => [skill.name, skill.source])).toEqual([
          ["platform-only", "skill"],
          ["deploy", "project"],
          ["long", "project"],
          ["owner-wide", "project"],
        ]);
        for (const skill of listed) {
          const matches = omp.filter((command) => command.name === `skill:${skill.name}`);
          expect(matches, skill.name).toHaveLength(1);
          const description = matches[0]?.description ?? "";
          expect([description, firstCodePoints(description, 200)], skill.name).toContain(
            skill.description,
          );
        }
        expect(listed.find((skill) => skill.name === "long")?.description).toBe(
          firstCodePoints(LONG, 200),
        );
        expect(omp.find((command) => command.name === "skill:long")?.description).toBe(LONG);
      },
    );

    it(
      "(b) runs the .omp project skill over a platform skill and over .claude/.codex/.agents project skills of the same name",
      TURN,
      async () => {
        const world = await openWorld(({ agentDir, ownerRoot, workspaceRoot }) => {
          writeSkill(join(agentDir, "skills"), "weekly-report", "平台的周报");
          writeSkill(join(workspaceRoot, ".omp", "skills"), "weekly-report", "项目的周报");
          writeSkill(join(workspaceRoot, ".omp", "skills"), "deploy", "omp 目录的上线");
          for (const provider of [".claude", ".codex", ".agents"]) {
            writeSkill(join(workspaceRoot, provider, "skills"), "deploy", `${provider} 目录的上线`);
          }
          writeSkill(join(ownerRoot, ".omp", "skills"), "deploy", "上层目录的上线");
        });

        const omp = await availableCommands(world.runtime);
        const descriptionsOf = (name: string) =>
          omp.filter((command) => command.name === name).map((command) => command.description);

        expect(descriptionsOf("skill:weekly-report")).toEqual(["项目的周报"]);
        expect(descriptionsOf("skill:deploy")).toEqual(["omp 目录的上线"]);
        expect(hostSkills(world)).toEqual([
          { name: "deploy", description: "omp 目录的上线", source: "project", overrides: false },
          { name: "weekly-report", description: "项目的周报", source: "project", overrides: true },
        ]);
      },
    );

    it(
      "(c) leaves no user entry in the branch list for a prompt the host classifies skill",
      TURN,
      async () => {
        const world = await openWorld(({ workspaceRoot }) => {
          writeSkill(
            join(workspaceRoot, ".omp", "skills"),
            "deploy",
            "上线到生产",
            "DEPLOY-SKILL-BODY-813",
          );
        });
        const text = "/skill:deploy 上线";
        const skills = hostSkills(world);
        expect(classifyPrompt(text, skills)).toEqual({ kind: "skill", name: "deploy" });

        await collectPrompt(world.runtime.prompt(toWireText(text, skills)));
        const afterSkill = await branchTexts(world.runtime);
        // Control on the same process: ordinary text does leave a `user` entry.
        await collectPrompt(world.runtime.prompt("普通消息"));
        const afterText = await branchTexts(world.runtime);

        expect(afterSkill).toEqual([]);
        expect(afterText).toEqual(["普通消息"]);
      },
    );

    it(
      "(d) does not load a SKILL.md created after the process started: the host says skill, omp stores a user message",
      TURN,
      async () => {
        const world = await openWorld(({ workspaceRoot }) => {
          writeSkill(join(workspaceRoot, ".omp", "skills"), "deploy", "上线到生产");
        });
        const started = await availableCommands(world.runtime);
        writeSkill(join(world.workspaceRoot, ".omp", "skills"), "late", "进程启动后才创建");
        const text = "/skill:late x";
        const skills = hostSkills(world);

        expect(started.map((command) => command.name)).toContain("skill:deploy");
        expect(classifyPrompt(text, skills)).toEqual({ kind: "skill", name: "late" });
        expect(toWireText(text, skills)).toBe(text);
        await collectPrompt(world.runtime.prompt(toWireText(text, skills)));

        const names = (await availableCommands(world.runtime)).map((command) => command.name);
        expect(names).toContain("skill:deploy");
        expect(names).not.toContain("skill:late");
        expect(await branchTexts(world.runtime)).toEqual([text]);
      },
    );
  },
);
