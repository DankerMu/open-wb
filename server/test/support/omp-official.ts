/**
 * The real-binary test tier (#813, #815, #984): a managed state layout, a sandbox with the
 * workspace `u1/proj`, the fake upstream as the model endpoint (`models.yml` points straight at it
 * and the token book issues its key; nothing sits between omp and the upstream) and a
 * `SessionRuntime` on the official omp binary whose cwd is that workspace. Every approval request
 * is recorded and answered, with deny unless the case says otherwise. Opt-in through `WORKBUDDY_OMP_TEST=1`; opted in, `OMP_BIN` must be the pinned official
 * binary (`make omp-fetch`) — a missing or different one fails, it is never skipped.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect } from "vitest";
import { writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import type { SpawnImpl } from "../../src/sessions/omp/process.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import {
  ensureOmpStateLayout,
  ompAgentDir,
  ompHostOverlayPath,
} from "../../src/sessions/omp/state-layout.js";
import type { ApprovalDecision, ApprovalRequest } from "../../src/sessions/omp/ui-requests.js";
import { type FakeUpstreamServer, type FakeUpstreamStartOptions, start } from "./fake-upstream.mjs";

export const OMP_VERSION = "18.12.3";
export const OMP_TEST_OFF = process.env.WORKBUDDY_OMP_TEST !== "1";
const MODEL_ID = "deepseek-v4.1-flash";
const UPSTREAM_KEY = "fake";
const OWNER_ID = "u1";

export interface OfficialDirs {
  /** The managed `OMP_STATE_DIR` of the world (#1527: its cache and log directories are checked). */
  stateDir: string;
  agentDir: string;
  sandboxRoot: string;
  ownerRoot: string;
  workspaceRoot: string;
}

/** What one runtime of the world is started with; every key defaults to what production does. */
interface OfficialRuntimeOptions {
  /**
   * `approvalMode` is the runtime's own (`write` when absent); with `hostOverlay: false` the
   * overlay is dropped from both of its sources (argv `--config` and env `PI_CONFIG_FILES`).
   */
  spawnArgs?: { approvalMode?: "always-ask" | "write" | "yolo"; hostOverlay?: boolean };
  /**
   * `false` drops the relay/cmux pins (`PI_BROWSER_RELAY`, `PI_BROWSER_CMUX`) from the env
   * `spawnOmp` built (#1529's negative contrast; the product always sets them). The two
   * `PUPPETEER_PROXY*` pins stay.
   */
  browserPins?: boolean;
  /**
   * `false` removes the cwd's `.git` marker `spawnOmp` just made, before the process starts (#1567's
   * negative contrast; the product always plants it). A cwd that held a `.git` before the first
   * spawn keeps it. The three spawn wrappers are exclusive: no case combines two of them.
   */
  hostMarker?: boolean;
  /** The answer to an approval request; deny when absent, so nothing is executed. */
  onApproval?: (request: ApprovalRequest) => ApprovalDecision;
}

interface OfficialWorldOptions extends OfficialRuntimeOptions {
  /** The managed `models.yml` as text, given the model endpoint's base URL (its port is dynamic). */
  modelsYml?: (proxyBaseUrl: string) => string;
  /**
   * Handed to the fake upstream's `start()` as it is. `"turn"` lets a session that already holds a
   * tool result open another tool round; absent, only the first turn of a session has one.
   */
  toolRoundScope?: FakeUpstreamStartOptions["toolRoundScope"];
  /** The `maxTokens` of the writer's single entry (production's default, 32768, when absent). */
  maxTokens?: number;
  /** The overlay's browser block `enabled` (production: whether `BROWSER_BIN` is set); `false` when absent. */
  browserEnabled?: boolean;
  /** Handed to every runtime as `browserBin`, the product's `BROWSER_BIN` wiring (#1529). */
  browserBin?: string;
}

export interface OfficialWorld extends OfficialDirs {
  runtime: SessionRuntime;
  upstream: FakeUpstreamServer;
  /** Every approval request of this world's runtimes, in arrival order. */
  approvals: ApprovalRequest[];
  /**
   * Shuts `runtime` down and starts another on the same managed state, resuming the session file
   * the first one wrote: a runtime cannot be reused after `shutdown()`.
   */
  reopen(options?: OfficialRuntimeOptions): Promise<OfficialWorld>;
}

/** Teardown steps of the running case, executed last-registered first. */
const cleanups: Array<() => unknown> = [];

// A browser world waits for omp's daemon broker to exit (its 3 s idle grace) before removal.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}, 30_000);

/** Registers a teardown step of the running case (also used by the proxied world, #909). */
export function onTeardown(step: () => unknown): void {
  cleanups.push(step);
}

/**
 * Tees a child's stdout JSONL into `onFrame`, in order; the runtime still reads every byte (only a
 * second `data` listener: no `setEncoding` / `pipe` / `read` / `pause`). Like the production parser
 * (`process.ts`), a line that is not JSON or not an object is skipped and counted; blank lines are
 * skipped uncounted. #1592.
 */
export function teeStdoutFrames(
  stream: Readable,
  onFrame: (frame: OmpFrame) => void,
): { malformed(): number } {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let malformed = 0;
  stream.on("data", (chunk: Buffer) => {
    const lines = (partial + decoder.write(chunk)).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines.filter((part) => part.trim().length > 0)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed += 1;
        continue;
      }
      onFrame(parsed as OmpFrame);
    }
  });
  return { malformed: () => malformed };
}

export function officialBin(): string {
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

/**
 * Test-only spawn wrapper for the negative contrast: the product has no spawn without the overlay,
 * so this drops it from the argv `spawnOmp` built and from the env.
 */
const rewritingSpawn: SpawnImpl = (command, args, options) => {
  const argv = [...args];
  const env = { ...options.env };
  argv.splice(argv.indexOf("--config"), 2);
  delete env.PI_CONFIG_FILES;
  return (spawn as SpawnImpl)(command, argv, { ...options, env });
};

/** Test-only spawn wrapper for #1529's negative contrast: drops the relay/cmux pins from the env. */
const unpinnedSpawn: SpawnImpl = (command, args, options) => {
  const env = { ...options.env };
  delete env.PI_BROWSER_RELAY;
  delete env.PI_BROWSER_CMUX;
  return (spawn as SpawnImpl)(command, args, { ...options, env });
};

/**
 * Test-only spawn wrapper for #1567's negative contrast: removes `<cwd>/.git` when the host made it
 * (the cwd had none before the first spawn). An empty directory only; `ENOENT` (a host that plants
 * no marker) is no error.
 */
function unmarkedSpawn(hostMade: boolean): SpawnImpl {
  return (command, args, options) => {
    if (hostMade) {
      try {
        rmdirSync(join(String(options.cwd), ".git"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return (spawn as SpawnImpl)(command, args, options);
  };
}

const BROKER_EXIT_MS = 15_000;

/**
 * A compiled omp runs headless Chromium under a per-project daemon broker that it starts detached
 * and that outlives omp by a 3 s idle grace (`<XDG_STATE_HOME>/omp/run/daemons/<hash>/broker.pid`).
 * Waits until no recorded broker is alive, then requires that no process names the world's root.
 */
async function expectBrokersGone(stateDir: string, root: string): Promise<void> {
  const daemons = join(stateDir, "xdg", "state", "omp", "run", "daemons");
  const deadline = Date.now() + BROKER_EXIT_MS;
  for (let live = liveBrokers(daemons); live.length > 0; live = liveBrokers(daemons)) {
    if (Date.now() > deadline) {
      throw new Error(`omp daemon broker still running: ${live.join(",")}`);
    }
    await delay(100);
  }
  let leftovers = "";
  try {
    leftovers = execFileSync("pgrep", ["-fl", root], { encoding: "utf8" });
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  if (leftovers.trim() !== "") {
    throw new Error(`processes left under ${root}:\n${leftovers}`);
  }
}

function liveBrokers(daemons: string): number[] {
  if (!existsSync(daemons)) {
    return [];
  }
  return readdirSync(daemons).flatMap((scope) => {
    const file = join(daemons, scope, "broker.pid");
    if (!existsSync(file)) {
      return [];
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      // The broker removed its pid file between `existsSync` and here: it has exited.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const { pid } = JSON.parse(text) as { pid: number };
    try {
      process.kill(pid, 0);
      return [pid];
    } catch {
      return [];
    }
  });
}

/**
 * Opens the world. `plant` writes the project files before anything is spawned (the process
 * starts with the first command or prompt); everything is torn down after the running case.
 */
export async function openOfficialWorld(
  plant: (dirs: OfficialDirs) => void,
  options: OfficialWorldOptions = {},
): Promise<OfficialWorld> {
  const bin = officialBin();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-official-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const sandboxRoot = join(root, "sandbox");
  const ownerRoot = join(sandboxRoot, OWNER_ID);
  const workspaceRoot = join(ownerRoot, "proj");
  mkdirSync(workspaceRoot, { recursive: true });
  // Test device: ends omp's own upward walk at the sandbox root, so nothing above the temporary
  // directory can be loaded (design D1 assumes no `.omp` above the sandbox root).
  mkdirSync(join(sandboxRoot, ".git"));
  if (options.browserEnabled === true) {
    cleanups.push(() => expectBrokersGone(stateDir, root));
  }
  const agentDir = ompAgentDir(stateDir);
  ensureOmpStateLayout(stateDir);
  const upstream: FakeUpstreamServer = await start({
    apiKey: UPSTREAM_KEY,
    ...(options.toolRoundScope === undefined ? {} : { toolRoundScope: options.toolRoundScope }),
  });
  cleanups.push(() => upstream.close());
  const proxyBaseUrl = `http://127.0.0.1:${String(upstream.port)}/v1`;
  if (options.modelsYml === undefined) {
    await writeManagedModelsYml(agentDir, {
      proxyBaseUrl,
      models: [
        {
          id: MODEL_ID,
          name: MODEL_ID,
          reasoning: false,
          vision: false,
          maxTokens: options.maxTokens ?? 32768,
        },
      ],
    });
  } else {
    writeFileSync(join(agentDir, "models.yml"), options.modelsYml(proxyBaseUrl), { mode: 0o640 });
  }
  await writeHostOverlay(stateDir, {
    browserEnabled: options.browserEnabled ?? false,
    visionModelId: null,
  });
  const dirs = { stateDir, agentDir, sandboxRoot, ownerRoot, workspaceRoot };
  plant(dirs);
  // Whether a `.git` in the cwd after the first spawn is the host's marker or the case's own.
  const hostMarks = lstatSync(join(workspaceRoot, ".git"), { throwIfNoEntry: false }) === undefined;
  const approvals: ApprovalRequest[] = [];

  function open(runtimeOptions: OfficialRuntimeOptions, resumePath: string | null): OfficialWorld {
    const runtime: SessionRuntime = new SessionRuntime({
      sessionId: "omp-official",
      bin,
      sandboxRoot,
      stateDir,
      ownerId: OWNER_ID,
      cwd: workspaceRoot,
      modelId: MODEL_ID,
      approvalMode: runtimeOptions.spawnArgs?.approvalMode ?? "write",
      tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
      resumePath,
      ...(options.browserBin === undefined ? {} : { browserBin: options.browserBin }),
      ...(runtimeOptions.spawnArgs?.hostOverlay === false ? { spawnImpl: rewritingSpawn } : {}),
      ...(runtimeOptions.browserPins === false ? { spawnImpl: unpinnedSpawn } : {}),
      ...(runtimeOptions.hostMarker === false ? { spawnImpl: unmarkedSpawn(hostMarks) } : {}),
      onApproval: (request) => {
        approvals.push(request);
        runtime.respondApproval(request.id, runtimeOptions.onApproval?.(request) ?? "deny");
      },
    });
    cleanups.push(() => runtime.shutdown());
    return {
      runtime,
      upstream,
      approvals,
      ...dirs,
      reopen: async (next = {}) => {
        const sessionFile = runtime.sessionFile;
        if (sessionFile === undefined) {
          throw new Error("reopen needs a session file: run a turn on the first runtime");
        }
        await runtime.shutdown();
        return open(next, sessionFile);
      },
    };
  }

  return open(options, null);
}

/**
 * One runtime: what it spawned, every stdout frame of its child, the child's stdout lines the tee
 * skipped as malformed (`teeStdoutFrames`) and the approvals it answered. This and the helpers
 * below are shared by omp-official-overlay-pins and omp-official-provider-egress (#1621).
 */
export interface WriteTierLaunch {
  runtime: SessionRuntime;
  argv: string[][];
  /** The env each spawn handed the child (after the wrapper's rewrites), and when it spawned. */
  env: NodeJS.ProcessEnv[];
  spawnedAt: number[];
  out: OmpFrame[];
  malformed(): number;
  approvals: ApprovalRequest[];
}

/**
 * A `write`-tier runtime on the world's managed state that allows every approval. With `overlay`,
 * both overlay sources point at that file (test-only, like rpc-ui's `overlayAt`); with
 * `otelPin: false` the spawn env loses `OTEL_SDK_DISABLED` (#1575's test-only wrapper; the product
 * always sets it); with `proxyPins: false` it loses `no_proxy` and `NO_PROXY` (#1615's). The
 * runtime is shut down only at teardown, after the case body, so its child and the tee outlive the
 * settle.
 */
export function launchWriteTier(
  world: OfficialWorld,
  overlay?: string,
  otelPin = true,
  proxyPins = true,
): WriteTierLaunch {
  const argv: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnedAt: number[] = [];
  const out: OmpFrame[] = [];
  const tees: Array<{ malformed(): number }> = [];
  const approvals: ApprovalRequest[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const nextArgv = [...args];
    const env = { ...options.env };
    if (overlay !== undefined) {
      nextArgv[nextArgv.indexOf("--config") + 1] = overlay;
      env.PI_CONFIG_FILES = overlay;
    }
    if (!otelPin) {
      delete env.OTEL_SDK_DISABLED;
    }
    if (!proxyPins) {
      delete env.no_proxy;
      delete env.NO_PROXY;
    }
    argv.push(nextArgv);
    envs.push(env);
    spawnedAt.push(Date.now());
    const child = (spawn as SpawnImpl)(command, nextArgv, { ...options, env });
    tees.push(teeStdoutFrames(child.stdout, (frame) => out.push(frame)));
    return child;
  };
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-write-tier",
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
  const malformed = (): number => tees.reduce((sum, tee) => sum + tee.malformed(), 0);
  return { runtime, argv, env: envs, spawnedAt, out, malformed, approvals };
}

/**
 * The product overlay with `block` replaced by `replacement`, written next to it as `<name>.yml`;
 * the block must occur exactly once.
 */
export function overlaySwapping(
  world: OfficialWorld,
  block: string,
  replacement: string,
  name: string,
): string {
  const product = readFileSync(ompHostOverlayPath(world.stateDir), "utf8");
  expect(product.split(block)).toHaveLength(2);
  const path = join(world.stateDir, `${name}.yml`);
  writeFileSync(path, product.replace(block, replacement), { mode: 0o640 });
  return path;
}

/** The product overlay without `block`, written next to it; the block must occur exactly once. */
export function overlayWithout(world: OfficialWorld, block: string, name: string): string {
  return overlaySwapping(world, block, "", `overlay-without-${name}`);
}

export function expectOverlayAt(run: WriteTierLaunch, path: string): void {
  expect(run.argv[0]?.[run.argv[0].indexOf("--config") + 1]).toBe(path);
}

/** One request the stand-in proxy saw: its request line and when it arrived. */
export interface ProxyHit {
  line: string;
  at: number;
}

/**
 * A local HTTP listener standing in for an outside proxy: it records each request line (a `CONNECT`
 * too) and its arrival time and answers 502 without forwarding or reading the body. Closed at
 * teardown, after the runtime (call it before the world opens).
 */
export async function proxyListener(): Promise<{ port: number; hits: ProxyHit[] }> {
  const hits: ProxyHit[] = [];
  const server = createServer((req, res) => {
    hits.push({ line: `${String(req.method)} ${String(req.url)}`, at: Date.now() });
    req.resume();
    req.on("end", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy stand-in: not forwarded\n");
    });
  });
  server.on("connect", (req, socket) => {
    hits.push({ line: `CONNECT ${String(req.url)}`, at: Date.now() });
    // A client giving up on the refused tunnel resets the socket: not an error of the case.
    socket.on("error", () => {});
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTeardown(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, hits };
}
