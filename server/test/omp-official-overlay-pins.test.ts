/**
 * Issue #1583 (change omp-pin-probes): the overlay fixed block's `advisor:\n  enabled: false` and
 * `ida:\n  enabled: false` pins, checked against the official omp binary in the world of
 * support/omp-official.ts — omp-runtime「overlay 固定块 advisor / ida 钉的真实 omp 回归」, scenario
 * 「advisor / ida 钉的回归与负对照」. Every world's project layer (`<cwd>/.omp/config.yml`) turns both
 * features on: `ida.enabled: true` + `ida.installDir: <cwd>/fake-ida` (one empty idalib file named
 * the way v18.12.3 `ida/install.ts:15-16` looks for it), `advisor.enabled: true` +
 * `modelRoles.advisor: workbuddy/<the world's model>`.
 *
 * Observables (v18.12.3 baseline; #1570 probe, ADR-0012 part four):
 * - `ida` is a discoverable tool, never in `get_state.dumpTools`; when an install is found it is an
 *   `xd://ida` device in `get_state.systemPrompt`'s `# xd:// Tool Devices` section.
 * - `advisor` has no RPC read-back: one bash turn (write tier, approval allowed) reaches the fake
 *   upstream twice when the advisor is off; when it runs it adds review requests and omp writes an
 *   `advisor_yielded` frame. That frame comes from the advisor drain's `finally`
 *   (`session/session-advisors.ts:1627`), possibly after `agent_end`, so every stdout frame of the
 *   child is kept here (not only the turn's) and the child stays up until the upstream request
 *   count settles: polled every 500 ms after `agent_end`, settled once unchanged for 2 s, a failure
 *   when not settled within 30 s.
 *
 * Negative controls: the product overlay without one block — asserted to occur exactly once first —
 * swapped in through **both** argv `--config` and env `PI_CONFIG_FILES` (omp reads both; replacing
 * one keeps the pin), as omp-official-rpc-ui.test.ts does for `ask`. They assert presence (the `ida`
 * device, `advisor_yielded`), so the regressions above are not empty assertions.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-overlay-pins.test.ts --coverage=false
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { ompHostOverlayPath } from "../src/sessions/omp/state-layout.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import {
  type OfficialDirs,
  type OfficialWorld,
  OMP_TEST_OFF,
  OMP_VERSION,
  officialBin,
  onTeardown,
  openOfficialWorld,
} from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

const STATE_CASE = { timeout: 90_000 };
const TURN_CASE = { timeout: 180_000 };
/** The world's model and upstream key (support/omp-official.ts). */
const MODEL_ID = "deepseek-v4.1-flash";
const UPSTREAM_KEY = "fake";
/** Any prompt: the fake upstream's first tool round defaults to one bash call. */
const BASH_PROMPT = "跑一个命令";
/** The two pins, as the overlay's fixed block writes them (omp-runtime「overlay 写入」). */
const IDA_BLOCK = "ida:\n  enabled: false\n";
const ADVISOR_BLOCK = "advisor:\n  enabled: false\n";
/** The library `locateIdaInstall` checks for in an install dir (v18.12.3 `ida/install.ts:15-16`). */
const IDALIB =
  process.platform === "darwin"
    ? "libidalib.dylib"
    : process.platform === "win32"
      ? "idalib.dll"
      : "libidalib.so";
const POLL_MS = 500;
const STABLE_MS = 2_000;
const SETTLE_LIMIT_MS = 30_000;
const YIELD_LIMIT_MS = 60_000;

/** One runtime: what it spawned, every stdout frame of its child and the approvals it answered. */
interface Launch {
  runtime: SessionRuntime;
  argv: string[][];
  out: OmpFrame[];
  approvals: ApprovalRequest[];
}

/** The project layer turning both features on, and the fake IDA install it points at. */
function plantPins({ workspaceRoot }: OfficialDirs): void {
  const installDir = join(workspaceRoot, "fake-ida");
  mkdirSync(join(workspaceRoot, ".omp"));
  mkdirSync(installDir);
  writeFileSync(join(installDir, IDALIB), "");
  expect(existsSync(join(installDir, IDALIB))).toBe(true);
  writeFileSync(
    join(workspaceRoot, ".omp", "config.yml"),
    [
      "advisor:",
      "  enabled: true",
      "modelRoles:",
      `  advisor: ${JSON.stringify(`workbuddy/${MODEL_ID}`)}`,
      "ida:",
      "  enabled: true",
      `  installDir: ${JSON.stringify(installDir)}`,
      "",
    ].join("\n"),
  );
}

/** Keeps every stdout frame of the child for its whole lifetime; the runtime still reads every byte. */
function teeFrames(child: ChildProcessWithoutNullStreams, sink: OmpFrame[]): void {
  let rest = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.filter((part) => part.trim().length > 0)) {
      sink.push(JSON.parse(line) as OmpFrame);
    }
  });
}

/**
 * A `write`-tier runtime on the world's managed state that allows every approval. With `overlay`,
 * both overlay sources point at that file (test-only, like rpc-ui's `overlayAt`). The runtime is
 * shut down only at teardown, after the case body, so its child and the tee outlive the settle.
 */
function launch(world: OfficialWorld, overlay?: string): Launch {
  const argv: string[][] = [];
  const out: OmpFrame[] = [];
  const approvals: ApprovalRequest[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const nextArgv = [...args];
    const env = { ...options.env };
    if (overlay !== undefined) {
      nextArgv[nextArgv.indexOf("--config") + 1] = overlay;
      env.PI_CONFIG_FILES = overlay;
    }
    argv.push(nextArgv);
    const child = (spawn as SpawnImpl)(command, nextArgv, { ...options, env });
    teeFrames(child, out);
    return child;
  };
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-overlay-pins",
    bin: officialBin(),
    sandboxRoot: world.sandboxRoot,
    stateDir: world.stateDir,
    ownerId: "u1",
    cwd: world.workspaceRoot,
    modelId: MODEL_ID,
    approvalMode: "write",
    tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
    resumePath: null,
    spawnImpl,
    onApproval: (request) => {
      approvals.push(request);
      runtime.respondApproval(request.id, "allow");
    },
  });
  onTeardown(() => runtime.shutdown());
  return { runtime, argv, out, approvals };
}

/** The product overlay without `block`, written next to it; the block must occur exactly once. */
function overlayWithout(world: OfficialWorld, block: string, name: string): string {
  const product = readFileSync(ompHostOverlayPath(world.stateDir), "utf8");
  expect(product.split(block)).toHaveLength(2);
  const path = join(world.stateDir, `overlay-without-${name}.yml`);
  writeFileSync(path, product.replace(block, ""), { mode: 0o640 });
  return path;
}

interface PromptState {
  systemPrompt: string[];
  dumpTools: Array<{ name: string }>;
}

async function readState(run: Launch): Promise<PromptState> {
  return (await run.runtime.command({ type: "get_state" })) as unknown as PromptState;
}

/** The device names of the system prompt's `# xd:// Tool Devices` section, sorted (empty without one). */
function xdDevices(state: PromptState): string[] {
  const prompt = state.systemPrompt.join("\n");
  const start = prompt.indexOf("# xd:// Tool Devices");
  if (start === -1) {
    return [];
  }
  const tail = prompt.slice(start + 1);
  const end = tail.search(/\n(?:# |§ )/u);
  const section = end === -1 ? tail : tail.slice(0, end);
  return [
    ...new Set([...section.matchAll(/xd:\/\/([a-z_]+)/gu)].map((match) => String(match[1]))),
  ].sort();
}

function yielded(out: OmpFrame[]): number {
  return out.filter((frame) => frame.type === "advisor_yielded").length;
}

/** Waits, bounded, until the child wrote its first `advisor_yielded` frame. */
async function firstYield(out: OmpFrame[]): Promise<void> {
  const deadline = Date.now() + YIELD_LIMIT_MS;
  while (yielded(out) === 0) {
    if (Date.now() > deadline) {
      throw new Error(`no advisor_yielded frame within ${String(YIELD_LIMIT_MS)} ms`);
    }
    await delay(POLL_MS);
  }
}

/**
 * The fake upstream's request count once it settles: read every 500 ms, settled when unchanged for
 * 2 s; not settled within 30 s fails.
 */
async function settledRequests(world: OfficialWorld): Promise<number> {
  const started = Date.now();
  let count = world.upstream.requests().length;
  let since = Date.now();
  for (;;) {
    await delay(POLL_MS);
    const next = world.upstream.requests().length;
    if (next !== count) {
      count = next;
      since = Date.now();
    } else if (Date.now() - since >= STABLE_MS) {
      return count;
    }
    if (Date.now() - started > SETTLE_LIMIT_MS) {
      throw new Error(`upstream request count not settled within ${String(SETTLE_LIMIT_MS)} ms`);
    }
  }
}

/** One bash turn to `agent_end`, then the settled request count and the frames read until then. */
async function bashTurn(world: OfficialWorld, run: Launch, waitYield: boolean): Promise<number> {
  const frames = await collectPrompt(run.runtime.prompt(BASH_PROMPT));
  expect(frames.some((frame) => frame.type === "agent_end")).toBe(true);
  expect(run.approvals.map((request) => request.tool)).toEqual(["bash"]);
  const bash = frames.find((frame) => frame.type === "tool_execution_end");
  expect([bash?.toolName, bash?.isError]).toEqual(["bash", false]);
  if (waitYield) {
    await firstYield(run.out);
  }
  return settledRequests(world);
}

function log(reading: Record<string, unknown>): void {
  console.log(`[overlay-pins] ${JSON.stringify(reading)}`);
}

function expectOverlayAt(run: Launch, path: string): void {
  expect(run.argv[0]?.[run.argv[0].indexOf("--config") + 1]).toBe(path);
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: overlay advisor / ida pins`, () => {
  it(
    "ida pin: with a project IDA install the product overlay's xd:// device list has ast_edit and no ida",
    STATE_CASE,
    async () => {
      const world = await openOfficialWorld(plantPins);
      const run = launch(world);

      const state = await readState(run);
      const devices = xdDevices(state);
      // `dumpTools` never has `ida` (a discoverable tool): logged, not evidence.
      const tools = state.dumpTools.map((tool) => tool.name);
      log({ case: "ida/product", devices, dumpToolsHasIda: tools.includes("ida") });

      expect(devices).toContain("ast_edit");
      expect(devices).not.toContain("ida");
    },
  );

  it(
    "negative control: the overlay without its ida block, through --config and PI_CONFIG_FILES, lists the ida device",
    STATE_CASE,
    async () => {
      const world = await openOfficialWorld(plantPins);
      const bare = overlayWithout(world, IDA_BLOCK, "ida");
      const run = launch(world, bare);

      const state = await readState(run);
      const devices = xdDevices(state);
      log({ case: "ida/without-block", devices });

      expectOverlayAt(run, bare);
      expect(devices).toContain("ida");
    },
  );

  it(
    "advisor pin: a write-tier bash turn under the product overlay reaches the upstream exactly twice, no advisor_yielded",
    TURN_CASE,
    async () => {
      const world = await openOfficialWorld(plantPins);
      const run = launch(world);

      const requests = await bashTurn(world, run, false);
      const advisorYielded = yielded(run.out);
      log({ case: "advisor/product", requests, advisorYielded, frames: run.out.length });

      expect(requests).toBe(2);
      expect(advisorYielded).toBe(0);
    },
  );

  it(
    "negative control: the overlay without its advisor block, through --config and PI_CONFIG_FILES, runs the advisor",
    TURN_CASE,
    async () => {
      const world = await openOfficialWorld(plantPins);
      const bare = overlayWithout(world, ADVISOR_BLOCK, "advisor");
      const run = launch(world, bare);

      const requests = await bashTurn(world, run, true);
      const advisorYielded = yielded(run.out);
      log({ case: "advisor/without-block", requests, advisorYielded, frames: run.out.length });

      expectOverlayAt(run, bare);
      expect(requests).toBeGreaterThan(2);
      expect(advisorYielded).toBeGreaterThan(0);
    },
  );
});
