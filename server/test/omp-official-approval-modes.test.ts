/**
 * Issue #984 (s1g tasks 1.1–1.3): the three approval tiers checked against the official omp
 * v18.0.10 binary — session-permission-tier Requirement「档位与 omp 审批模式」, the three real-omp
 * scenarios, and design D2 checks (a)–(d), in the world of support/omp-official.ts. The host
 * overlay is the unchanged product file (it still says `tools.approvalMode: write`); only the argv
 * `--approval-mode` differs between cases. The oracles are omp's own approval requests as the
 * runtime hands them to the host, the frames of the turn and the workspace on disk. The world has
 * no database: "no `chat_approvals` row" is "no approval request reached the host".
 *
 * The fake upstream opens a turn with one tool call (`write` for `WORKBUDDY_WRITE`, else bash) only
 * while the request holds no tool result, so every tool round runs in a fresh session; case (d),
 * whose second tool round follows a resume, opens its world with `freshToolRounds` (the upstream is
 * then shown the running turn only — see `startTurnForwarder` in support/omp-official.ts).
 *
 * Run locally: `make omp-fetch` (fetches the official v18.0.10 binary), then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN=../var/omp/omp \
 *     npx vitest run test/omp-official-approval-modes.test.ts --coverage=false
 * (`OMP_BIN` is the binary's path, `var/omp/omp` under the repository root by default.) Without
 * `WORKBUDDY_OMP_TEST=1` the whole file is skipped — also under `make test` — so a green local
 * `make check` does not mean these checks ran: the output of the CI uid-isolation job is the
 * authority. When an omp upgrade turns a case red, the spec changes first.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  type OfficialWorld,
  OMP_TEST_OFF,
  OMP_VERSION,
  openOfficialWorld,
} from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

const TURN = { timeout: 90_000 };
const REPORT = "workbuddy-report.html";
const REPORT_BODY = "<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n";

type Tool = "bash" | "write";
type Mode = "always-ask" | "write" | "yolo";

/** The prompt that makes the fake upstream call the tool. */
const PROMPT: Record<Tool, string> = {
  bash: "跑一个命令",
  write: "WORKBUDDY_WRITE 写一份报告",
};

/** The three scenarios as a table: which tool rounds ask the host under which tier. */
const TIERS: Array<{ mode: Mode; tool: Tool; asks: boolean }> = [
  { mode: "always-ask", tool: "write", asks: true },
  { mode: "always-ask", tool: "bash", asks: true },
  { mode: "write", tool: "write", asks: false },
  { mode: "write", tool: "bash", asks: true },
  { mode: "yolo", tool: "bash", asks: false },
  { mode: "yolo", tool: "write", asks: false },
];

/** Each approval request as `[tool, first title line]`. */
function asked(world: OfficialWorld): string[][] {
  return world.approvals.map((request) => [request.tool, request.title.split("\n")[0] ?? ""]);
}

/** `[tool, failed, output]` of every tool call the turn finished. */
function executions(frames: OmpFrame[]): Array<[unknown, unknown, string]> {
  return frames
    .filter((frame) => frame.type === "tool_execution_end")
    .map((frame) => {
      const result = frame.result as { content: Array<{ text?: string }> };
      return [frame.toolName, frame.isError, result.content.map((part) => part.text).join("")];
    });
}

function report(world: OfficialWorld): string | undefined {
  const path = join(world.workspaceRoot, REPORT);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The turn ran its one tool call to a successful result and ended normally. */
function expectExecuted(world: OfficialWorld, frames: OmpFrame[], tool: Tool): void {
  const done = executions(frames);
  expect(done.map(([name, failed]) => [name, failed])).toEqual([[tool, false]]);
  if (tool === "bash") {
    expect(done[0]?.[2]).toContain("workbuddy-smoke");
    expect(report(world)).toBeUndefined();
  } else {
    expect(report(world)).toBe(REPORT_BODY);
  }
  expect(frames.at(-1)?.type).toBe("agent_end");
}

/** A project layer that tries to allow `write` without asking. */
function plantWriteAllow({ workspaceRoot }: { workspaceRoot: string }): void {
  mkdirSync(join(workspaceRoot, ".omp"));
  writeFileSync(
    join(workspaceRoot, ".omp", "config.yml"),
    "tools:\n  approval:\n    write: allow\n",
  );
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: approval tiers`, () => {
  it.each(TIERS)(
    "--approval-mode $mode with the host overlay: a $tool round asks the host = $asks, and the tool runs",
    TURN,
    async ({ mode, tool, asks }) => {
      const world = await openOfficialWorld(() => {}, {
        spawnArgs: { approvalMode: mode },
        onApproval: () => "allow",
      });

      const frames = await collectPrompt(world.runtime.prompt(PROMPT[tool]));

      expect(asked(world)).toEqual(asks ? [[tool, `Allow tool: ${tool}`]] : []);
      expectExecuted(world, frames, tool);
    },
  );

  it(
    "(c) always-ask still asks for write when the project layer says tools.approval: {write: allow}",
    TURN,
    async () => {
      const world = await openOfficialWorld(plantWriteAllow, {
        spawnArgs: { approvalMode: "always-ask" },
        onApproval: () => "allow",
      });

      const frames = await collectPrompt(world.runtime.prompt(PROMPT.write));

      expect(asked(world)).toEqual([["write", "Allow tool: write"]]);
      expectExecuted(world, frames, "write");
    },
  );

  it(
    "(c) negative control: without the host overlay (argv --config and env PI_CONFIG_FILES both gone) the project layer's allow wins and write is not asked",
    TURN,
    async () => {
      const world = await openOfficialWorld(plantWriteAllow, {
        spawnArgs: { approvalMode: "always-ask", hostOverlay: false },
        onApproval: () => "allow",
      });

      const frames = await collectPrompt(world.runtime.prompt(PROMPT.write));

      expect(asked(world)).toEqual([]);
      expectExecuted(world, frames, "write");
    },
  );

  it(
    "(d) a session started under write and resumed under always-ask keeps its history and asks for write",
    TURN,
    async () => {
      const first = await openOfficialWorld(() => {}, {
        spawnArgs: { approvalMode: "write" },
        freshToolRounds: true,
      });
      const opening = await collectPrompt(first.runtime.prompt("第一回合"));
      expect(opening.at(-1)?.type).toBe("agent_end");
      const sessionFile = first.runtime.sessionFile;

      const resumed = await first.reopen({
        spawnArgs: { approvalMode: "always-ask" },
        onApproval: () => "allow",
      });
      const branch = (await resumed.runtime.command({ type: "get_branch_messages" })) as {
        messages: Array<{ text: string }>;
      };
      const before = resumed.approvals.length;
      const frames = await collectPrompt(resumed.runtime.prompt(PROMPT.write));

      expect(resumed.runtime.sessionFile).toBe(sessionFile);
      expect(branch.messages.map((entry) => entry.text)).toEqual(["第一回合"]);
      // Fixture check first, so a red run names its cause: the resumed turn must carry a tool call.
      expect(
        executions(frames).map(([name]) => name),
        "the fake upstream issued no tool call in the resumed turn (the freshToolRounds forwarder did not hide the first turn's tool result), so omp had nothing to ask about",
      ).toEqual(["write"]);
      expect(asked(resumed).slice(before)).toEqual([["write", "Allow tool: write"]]);
      expectExecuted(resumed, frames, "write");
    },
  );
});
