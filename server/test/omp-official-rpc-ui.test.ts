/**
 * Issue #1566 (omp-pin-18-12 task 2.3, design D2): the omp child under `--mode rpc-ui`, checked
 * against the official omp binary in the world of support/omp-official.ts.
 *
 * - omp-runtime「子进程 spawn 契约」 scenario「rpc-ui 下三档回合与 rpc 相同（真实 omp）」: under each tier
 *   a bash turn shakes hands, asks the host exactly as the tier says, ends `done`, and `get_state`
 *   answers with `sessionFile`, `model` and `thinkingLevel`; any other extension UI request is
 *   cancelled by the host and the turn does not fail.
 * - omp-runtime「宿主 overlay」 scenario「rpc-ui 下模型拿不到 ask 工具（真实 omp）」: the fake upstream's
 *   `WORKBUDDY_ASK` round calls `ask`; with the product overlay (`ask.enabled: false`) omp has no such
 *   tool, answers the model with an error result and the turn ends `done` with no UI request; the
 *   negative control swaps in the same overlay without its `ask:` block — through **both** argv
 *   `--config` and env `PI_CONFIG_FILES`, because omp reads `PI_CONFIG_FILES` first and appends
 *   `--config` (v18.12.3 `config/settings.ts:676-677`), so replacing only one keeps the pin — and the
 *   cancelled `ask` UI request aborts the turn (`stopped`): v18.12.3 creates `ask` only under
 *   `canPromptUser ?? hasUI` (`tools/ask.ts:581`) and aborts the turn on a cancel (`:785-786`).
 * - The same scenario's request-count clause: one bash turn as the product spawns it and one with
 *   the argv rewritten to `--mode rpc` reach the fake upstream with the same number of requests,
 *   each naming the same model (`hasUI` must not add model calls).
 *
 * `done` / `stopped` are the host's turn status: the turn's frames folded through the production
 * reducer (`applyFrame`). The spawn wrappers below are test-only (precedent: `rewritingSpawn` in
 * support/omp-official.ts); the product has no spawn other than `spawnOmp`'s. A wrapped runtime is
 * built here on the world's managed state, so the world's own runtime is never started. The second
 * upstream request is read from a loopback forwarder placed between omp and the fake upstream: the
 * fake upstream's own record keeps no message content (omp-test-harness「受控上游请求记录」).
 *
 * Run locally (`OMP_BIN` absolute; see omp-official-approval-modes.test.ts):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-rpc-ui.test.ts --coverage=false
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { applyFrame, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { ompHostOverlayPath } from "../src/sessions/omp/state-layout.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import {
  type OfficialWorld,
  OMP_TEST_OFF,
  OMP_VERSION,
  officialBin,
  onTeardown,
  openOfficialWorld,
  teeStdoutFrames,
} from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

const TURN = { timeout: 90_000 };
/** The world's model and upstream key (support/omp-official.ts). */
const MODEL_ID = "deepseek-v4.1-flash";
const UPSTREAM_KEY = "fake";
const BASH_PROMPT = "跑一个命令";
const ASK_PROMPT = "问我 WORKBUDDY_ASK 再说";
/** The overlay's `ask` block, two lines of its fixed block (omp-runtime「overlay 写入」). */
const ASK_BLOCK = "\nask:\n  enabled: false\n";
/**
 * The extension UI methods omp waits on for an answer. The others (`setWidget`, `setStatus`,
 * `notify`, `setTitle`, …) are fire-and-forget display frames (v18.12.3
 * `modes/rpc/rpc-mode.ts:1482-1520`): the host cancels them like any non-approval request, and omp
 * reads no answer.
 */
const ANSWERED = new Set(["select", "confirm", "input", "editor"]);
/** omp's whole tool result for a tool it does not have (#1566 first run, unchanged on v18.12.3). */
const NO_ASK = "Tool ask not found";

type Mode = "always-ask" | "write" | "yolo";

/**
 * One wrapped runtime: what it spawned, every extension UI request its child wrote (whole
 * lifetime, also outside a turn) and every frame its child read on stdin.
 */
interface Launch {
  runtime: SessionRuntime;
  argv: string[][];
  ui: OmpFrame[];
  stdin: OmpFrame[];
  approvals: ApprovalRequest[];
}

/** Rewrites the argv and env `spawnOmp` built, in place, before the child is started. */
type Rewrite = (argv: string[], env: NodeJS.ProcessEnv) => void;

function teeStdin(child: ChildProcessWithoutNullStreams, sink: OmpFrame[]): void {
  const write = child.stdin.write.bind(child.stdin) as (...args: unknown[]) => boolean;
  child.stdin.write = ((...args: unknown[]) => {
    const chunk = args[0];
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split("\n").filter((part) => part.length > 0)) {
      sink.push(JSON.parse(line) as OmpFrame);
    }
    return write(...args);
  }) as typeof child.stdin.write;
}

/** Keeps the child's extension UI requests (support/omp-official.ts `teeStdoutFrames`). */
function teeUiRequests(child: ChildProcessWithoutNullStreams, sink: OmpFrame[]): void {
  teeStdoutFrames(child.stdout, (frame) => {
    if (frame.type === "extension_ui_request") {
      sink.push(frame);
    }
  });
}

/** A runtime on the world's managed state whose spawn is recorded and optionally rewritten. */
function launch(world: OfficialWorld, mode: Mode, rewrite?: Rewrite): Launch {
  const argv: string[][] = [];
  const ui: OmpFrame[] = [];
  const stdin: OmpFrame[] = [];
  const approvals: ApprovalRequest[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const nextArgv = [...args];
    const env = { ...options.env };
    rewrite?.(nextArgv, env);
    argv.push(nextArgv);
    const child = (spawn as SpawnImpl)(command, nextArgv, { ...options, env });
    teeUiRequests(child, ui);
    teeStdin(child, stdin);
    return child;
  };
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-rpc-ui",
    bin: officialBin(),
    sandboxRoot: world.sandboxRoot,
    stateDir: world.stateDir,
    ownerId: "u1",
    cwd: world.workspaceRoot,
    modelId: MODEL_ID,
    approvalMode: mode,
    tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
    resumePath: null,
    spawnImpl,
    onApproval: (request) => {
      approvals.push(request);
      runtime.respondApproval(request.id, "allow");
    },
  });
  onTeardown(() => runtime.shutdown());
  return { runtime, argv, ui, stdin, approvals };
}

/** The test-only `--mode rpc` contrast. */
const plainRpc: Rewrite = (argv) => {
  argv[argv.indexOf("--mode") + 1] = "rpc";
};

/** The negative control: both overlay sources point at `path`. */
function overlayAt(path: string): Rewrite {
  return (argv, env) => {
    argv[argv.indexOf("--config") + 1] = path;
    env.PI_CONFIG_FILES = path;
  };
}

/** The host's turn status: the frames folded through the production reducer. */
function turnStatus(frames: OmpFrame[]): string | undefined {
  let state = createEventState({ messageId: 1, promptRequestId: "unused" });
  let status: string | undefined;
  for (const frame of frames) {
    const applied = applyFrame(state, frame);
    state = applied.state;
    for (const event of applied.events) {
      if (event.type === "turn.end") {
        status = event.data.status;
      }
    }
  }
  return status;
}

function isApprovalSelect(frame: OmpFrame): boolean {
  return frame.method === "select" && String(frame.title).startsWith("Allow tool: ");
}

/** The non-approval extension UI requests among `frames`. */
function others(frames: OmpFrame[]): OmpFrame[] {
  return frames.filter(
    (frame) => frame.type === "extension_ui_request" && !isApprovalSelect(frame),
  );
}

function idsOf(frames: OmpFrame[]): unknown[] {
  return frames.map((frame) => frame.id);
}

function cancelledIds(stdin: OmpFrame[]): unknown[] {
  return stdin
    .filter((frame) => frame.type === "extension_ui_response" && frame.cancelled === true)
    .map((frame) => frame.id);
}

/** A loopback forwarder to the world's fake upstream that keeps every request body. */
async function recordBodies(world: OfficialWorld): Promise<unknown[]> {
  const bodies: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    const parts: Buffer[] = [];
    incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(parts);
      bodies.push(JSON.parse(body.toString("utf8")) as unknown);
      const relay = forward(
        {
          host: "127.0.0.1",
          port: world.upstream.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      relay.on("error", () => outgoing.destroy());
      relay.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTeardown(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  await writeModels(world, port, false);
  return bodies;
}

/**
 * Rewrites the world's single `models.yml` entry before anything is spawned: the entry the world
 * wrote, with the given port and `reasoning`. A reasoning model makes `get_state` carry
 * `thinkingLevel` (omp drops the key while it is undefined).
 */
async function writeModels(world: OfficialWorld, port: number, reasoning: boolean): Promise<void> {
  await writeManagedModelsYml(world.agentDir, {
    proxyBaseUrl: `http://127.0.0.1:${String(port)}/v1`,
    models: [{ id: MODEL_ID, name: MODEL_ID, reasoning, vision: false, maxTokens: 32768 }],
  });
}

/** The text of the tool result answering the call named `name` in an OpenAI chat request body. */
function toolResultText(body: unknown, name: string): string | undefined {
  const messages = (body as { messages?: Array<Record<string, unknown>> }).messages ?? [];
  const calls = messages.flatMap(
    (message) =>
      (message.tool_calls as Array<{ id: string; function: { name: string } }> | undefined) ?? [],
  );
  const call = calls.find((entry) => entry.function.name === name);
  const result = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === call?.id,
  );
  const content = result?.content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content.map((part: { text?: unknown }) => String(part.text ?? "")).join("")
    : undefined;
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: --mode rpc-ui`, () => {
  it.each<{ mode: Mode; asks: boolean }>([
    { mode: "always-ask", asks: true },
    { mode: "write", asks: true },
    { mode: "yolo", asks: false },
  ])(
    "rpc-ui 下三档回合与 rpc 相同: --approval-mode $mode, a bash turn asks the host = $asks, ends done, get_state answers",
    TURN,
    async ({ mode, asks }) => {
      const world = await openOfficialWorld(() => {});
      await writeModels(world, world.upstream.port, true);
      const run = launch(world, mode);

      const frames = await collectPrompt(run.runtime.prompt(BASH_PROMPT));
      const state = (await run.runtime.command({ type: "get_state" })) as Record<string, unknown>;

      expect(run.approvals.map((request) => request.tool)).toEqual(asks ? ["bash"] : []);
      expect(turnStatus(frames)).toBe("done");
      const bash = frames.find((frame) => frame.type === "tool_execution_end");
      expect([bash?.toolName, bash?.isError]).toEqual(["bash", false]);
      // Every other extension UI request of the child was cancelled, and the turn still ended done.
      expect(cancelledIds(run.stdin)).toEqual(idsOf(others(run.ui)));
      expect(Object.keys(state)).toEqual(
        expect.arrayContaining(["sessionFile", "model", "thinkingLevel"]),
      );
      expect(state.sessionFile).toBe(run.runtime.sessionFile);
    },
  );

  it(
    "rpc-ui 下模型拿不到 ask 工具: the ask round ends done with no UI request; the second request carries ask's error result",
    TURN,
    async () => {
      const world = await openOfficialWorld(() => {});
      const bodies = await recordBodies(world);
      const run = launch(world, "write");

      const frames = await collectPrompt(run.runtime.prompt(ASK_PROMPT));

      // No request that waits for an answer: no ask select, nothing interactive was cancelled.
      expect(run.ui.filter((frame) => ANSWERED.has(String(frame.method)))).toEqual([]);
      expect(cancelledIds(run.stdin)).toEqual(idsOf(others(run.ui)));
      expect(run.approvals).toEqual([]);
      expect(turnStatus(frames)).toBe("done");
      expect(bodies).toHaveLength(2);
      expect(toolResultText(bodies[1], "ask")).toBe(NO_ASK);
    },
  );

  it(
    "negative control: the overlay without its ask block, through --config and PI_CONFIG_FILES, lets ask ask; the host cancels and the turn ends stopped",
    TURN,
    async () => {
      const world = await openOfficialWorld(() => {});
      const product = readFileSync(ompHostOverlayPath(world.stateDir), "utf8");
      expect(product.split(ASK_BLOCK)).toHaveLength(2);
      const bare = join(world.stateDir, "overlay-without-ask.yml");
      writeFileSync(bare, product.replace(ASK_BLOCK, "\n"), { mode: 0o640 });
      const run = launch(world, "write", overlayAt(bare));

      const frames = await collectPrompt(run.runtime.prompt(ASK_PROMPT));

      expect(run.argv[0]?.[run.argv[0].indexOf("--config") + 1]).toBe(bare);
      expect(run.argv[0]?.[run.argv[0].indexOf("--mode") + 1]).toBe("rpc-ui");
      const asked = others(run.ui).filter((frame) => ANSWERED.has(String(frame.method)));
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(cancelledIds(run.stdin)).toEqual(idsOf(others(run.ui)));
      expect(run.approvals).toEqual([]);
      expect(turnStatus(frames)).toBe("stopped");
    },
  );

  it(
    "a bash turn reaches the upstream as often under the product's spawn as under --mode rpc, with the same model",
    TURN,
    async () => {
      const counted: Array<Array<string | null>> = [];
      for (const rewrite of [undefined, plainRpc]) {
        const world = await openOfficialWorld(() => {});
        const run = launch(world, "write", rewrite);
        const frames = await collectPrompt(run.runtime.prompt(BASH_PROMPT));
        expect(turnStatus(frames)).toBe("done");
        expect(run.approvals.map((request) => request.tool)).toEqual(["bash"]);
        counted.push(world.upstream.requests().map((request) => request.model));
      }

      expect(counted[0]?.length).toBeGreaterThan(0);
      expect(counted[1]).toEqual(counted[0]);
      expect(new Set(counted.flat())).toEqual(new Set([MODEL_ID]));
    },
  );
});
