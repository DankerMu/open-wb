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
 * Issue #1575 (change omp-spawn-otel-pin): omp-runtime「子进程 spawn 契约」scenario「工作目录 .env 不能
 * 打开 OTLP 导出（真实 omp）」. Every world's cwd `.env` names a local listener as the OTLP endpoint,
 * turns message-content capture on, writes `OTEL_SDK_DISABLED=false` and shortens the batch delays.
 * Four configurations differ only in the two independent switches: the overlay's
 * `telemetry.otlpExportEnabled: false` (dropped through both overlay sources, as above) and the
 * spawn env's `OTEL_SDK_DISABLED=true` (deleted by this file's spawn wrapper). The host's shutdown
 * never flushes (omp exits on stdin EOF), so each child stays up for one shared window after
 * `agent_end` and the listener is read before shutdown. The listener only counts requests (path and
 * arrival time), it never parses them.
 *
 * Issue #1615 (change omp-spawn-no-proxy): omp-runtime「子进程 spawn 契约」scenario「工作目录 .env 不能
 * 让模型请求走代理（真实 omp）」. A second local listener stands in for an outside proxy: it records
 * each request line and arrival time and answers a fixed error, never forwarding. Five cwd `.env`
 * cases name it as `HTTP_PROXY`, `http_proxy` or `ALL_PROXY` (the last two with an exemption that
 * does not match the loopback upstream, lowercase or uppercase); under the product spawn env
 * (`no_proxy=*`, `NO_PROXY=*`) each turn ends with the fake upstream's reply and the listener sees
 * nothing. The negative control keeps case (1) and deletes both pins in this file's spawn wrapper:
 * it waits, bounded, for an absolute-URI request to the fake upstream at the listener (Bun's fetch
 * proxying loopback) and does not assert the turn's end.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-overlay-pins.test.ts --coverage=false
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  teeStdoutFrames,
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
/** The overlay's telemetry pin, as its fixed block writes it. */
const TELEMETRY_BLOCK = "telemetry:\n  otlpExportEnabled: false\n";
/**
 * The batch delays every `.env` shortens (OpenTelemetry SDK defaults: 5 s, 1 s, 60 s). Only
 * `OTEL_BSP_SCHEDULE_DELAY` takes effect on v18.12.3: the binary holds no `OTEL_BLRP_SCHEDULE_DELAY`
 * or `OTEL_METRIC_EXPORT_INTERVAL` string, and the control's `/v1/traces` moved with it (0.46 s after
 * `agent_end` at 500, 2.9 s at 3000) while `/v1/logs` stayed at 0.9 s (the 1 s default) and
 * `/v1/metrics` never came (#1575 first run).
 */
const OTEL_DELAY_MS = 500;
/**
 * How long each child stays up after `agent_end` before the listener is read: one constant for all
 * four configurations (design D5: at least 5 s and at least twice the control's first request,
 * `/v1/traces`, 0.46 s after `agent_end` on the first run).
 */
const OTLP_WINDOW_MS = 5_000;
/** The fake upstream's reply parts (support/fake-upstream.mjs `REPLY_PARTS`), copied. */
const FAKE_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
/** The control's bounded wait for the proxied model request (design D4: 30 s). */
const PROXY_WAIT_MS = 30_000;
const PROXY_POLL_MS = 250;

/**
 * One runtime: what it spawned, every stdout frame of its child, the child's stdout lines the tee
 * skipped as malformed (support/omp-official.ts `teeStdoutFrames`) and the approvals it answered.
 */
interface Launch {
  runtime: SessionRuntime;
  argv: string[][];
  /** The env each spawn handed the child (after this file's wrappers), and when it spawned. */
  env: NodeJS.ProcessEnv[];
  spawnedAt: number[];
  out: OmpFrame[];
  malformed(): number;
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

/** One request the OTLP listener saw: its path and when it arrived. */
interface OtlpHit {
  path: string;
  at: number;
}

/**
 * A local HTTP listener standing in for an outside OTLP collector: it records each request's path
 * and arrival time and answers 200 empty, without reading the body as OTLP. Closed at teardown,
 * after the runtimes (teardown runs last-registered first, so call this before the world opens).
 */
async function otlpListener(): Promise<{ port: number; hits: OtlpHit[] }> {
  const hits: OtlpHit[] = [];
  const server = createServer((req, res) => {
    hits.push({ path: String(req.url), at: Date.now() });
    req.resume();
    req.on("end", () => res.end());
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

/** The cwd `.env` of every OTLP world: the listener as endpoint, content capture, short delays. */
function plantOtlpEnv(port: number): (dirs: OfficialDirs) => void {
  return ({ workspaceRoot }) => {
    writeFileSync(
      join(workspaceRoot, ".env"),
      [
        `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${String(port)}`,
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
        "OTEL_SDK_DISABLED=false",
        `OTEL_BSP_SCHEDULE_DELAY=${String(OTEL_DELAY_MS)}`,
        `OTEL_BLRP_SCHEDULE_DELAY=${String(OTEL_DELAY_MS)}`,
        `OTEL_METRIC_EXPORT_INTERVAL=${String(OTEL_DELAY_MS)}`,
        "",
      ].join("\n"),
    );
  };
}

/**
 * A `write`-tier runtime on the world's managed state that allows every approval. With `overlay`,
 * both overlay sources point at that file (test-only, like rpc-ui's `overlayAt`); with
 * `otelPin: false` the spawn env loses `OTEL_SDK_DISABLED` (#1575's test-only wrapper; the product
 * always sets it); with `proxyPins: false` it loses `no_proxy` and `NO_PROXY` (#1615's). The
 * runtime is shut down only at teardown, after the case body, so its child and the tee outlive the
 * settle.
 */
function launch(world: OfficialWorld, overlay?: string, otelPin = true, proxyPins = true): Launch {
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
  const malformed = (): number => tees.reduce((sum, tee) => sum + tee.malformed(), 0);
  return { runtime, argv, env: envs, spawnedAt, out, malformed, approvals };
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

/** One reading, with the child's malformed stdout line count (#1592). */
function log(run: Launch, reading: Record<string, unknown>): void {
  console.log(`[overlay-pins] ${JSON.stringify({ ...reading, malformed: run.malformed() })}`);
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
      log(run, { case: "ida/product", devices, dumpToolsHasIda: tools.includes("ida") });

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
      log(run, { case: "ida/without-block", devices });

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
      log(run, { case: "advisor/product", requests, advisorYielded, frames: run.out.length });

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
      log(run, { case: "advisor/without-block", requests, advisorYielded, frames: run.out.length });

      expectOverlayAt(run, bare);
      expect(requests).toBeGreaterThan(2);
      expect(advisorYielded).toBeGreaterThan(0);
    },
  );
});

/** The four configurations of the OTLP scenario: which of the two switches the child keeps. */
const OTLP_CASES = [
  { name: "product overlay and product env", overlayPin: true, envPin: true },
  { name: "env pin alone (overlay without telemetry block)", overlayPin: false, envPin: true },
  { name: "overlay pin alone (env without OTEL_SDK_DISABLED)", overlayPin: true, envPin: false },
] as const;

/**
 * One full turn under the given switches, then `OTLP_WINDOW_MS` with the child alive; returns the
 * listener's hits (read before shutdown), the `OTEL_SDK_DISABLED` the child was handed (checked by
 * the caller after the hits, so a missing product pin fails on the export itself first) and the
 * `agent_end` time.
 */
async function otlpTurn(
  overlayPin: boolean,
  envPin: boolean,
): Promise<{ hits: OtlpHit[]; pin: string | undefined; endedAt: number }> {
  const listener = await otlpListener();
  const world = await openOfficialWorld(plantOtlpEnv(listener.port));
  const overlay = overlayPin ? undefined : overlayWithout(world, TELEMETRY_BLOCK, "telemetry");
  const run = launch(world, overlay, envPin);

  const frames = await collectPrompt(run.runtime.prompt(BASH_PROMPT));
  const endedAt = Date.now();
  expect(frames.some((frame) => frame.type === "agent_end")).toBe(true);
  expect(run.env).toHaveLength(1);
  if (overlay !== undefined) {
    expectOverlayAt(run, overlay);
  }
  await delay(OTLP_WINDOW_MS);
  const hits = [...listener.hits];
  const spawnedAt = run.spawnedAt[0] ?? Number.NaN;
  log(run, {
    case: `otlp/${overlayPin ? "overlay" : "no-overlay"}+${envPin ? "env" : "no-env"}`,
    requests: hits.length,
    paths: [...new Set(hits.map((hit) => hit.path))].sort(),
    sinceSpawnMs: hits.map((hit) => hit.at - spawnedAt),
    sinceAgentEndMs: hits.map((hit) => hit.at - endedAt),
    turnMs: endedAt - spawnedAt,
    windowMs: OTLP_WINDOW_MS,
  });
  return { hits, pin: run.env[0]?.OTEL_SDK_DISABLED, endedAt };
}

describe.skipIf(OMP_TEST_OFF)(
  `official omp v${OMP_VERSION}: cwd .env cannot open OTLP export`,
  () => {
    it.each(OTLP_CASES)(
      "$name: the listener gets no request within the window after agent_end",
      TURN_CASE,
      async ({ overlayPin, envPin }) => {
        const { hits, pin } = await otlpTurn(overlayPin, envPin);

        expect(hits).toEqual([]);
        expect(pin).toBe(envPin ? "true" : undefined);
      },
    );

    it(
      "negative control: overlay without telemetry block and env without OTEL_SDK_DISABLED, the listener gets OTLP requests",
      TURN_CASE,
      async () => {
        const { hits, pin, endedAt } = await otlpTurn(false, false);

        expect(pin).toBeUndefined();
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((hit) => hit.path.startsWith("/v1/"))).toBe(true);
        // The window covers the control's first request at least twice over (design D5).
        expect(OTLP_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
        expect(OTLP_WINDOW_MS).toBeGreaterThanOrEqual(
          2 * Math.max(0, (hits[0]?.at ?? 0) - endedAt),
        );
      },
    );
  },
);

/** One request the stand-in proxy saw: its request line and when it arrived. */
interface ProxyHit {
  line: string;
  at: number;
}

/**
 * A local HTTP listener standing in for an outside proxy: it records each request line (a `CONNECT`
 * too) and its arrival time and answers 502 without forwarding or reading the body. Closed at
 * teardown, after the runtime (call it before the world opens, as `otlpListener`).
 */
async function proxyListener(): Promise<{ port: number; hits: ProxyHit[] }> {
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

/** The five `.env` cases of the scenario, given the listener's URL. */
const PROXY_CASES = [
  { name: "(1) HTTP_PROXY", lines: (url: string) => [`HTTP_PROXY=${url}`] },
  { name: "(2) http_proxy", lines: (url: string) => [`http_proxy=${url}`] },
  { name: "(3) ALL_PROXY", lines: (url: string) => [`ALL_PROXY=${url}`] },
  {
    name: "(4) HTTP_PROXY with a mismatching no_proxy",
    lines: (url: string) => [`HTTP_PROXY=${url}`, "no_proxy=example.invalid"],
  },
  {
    name: "(5) HTTP_PROXY with a mismatching NO_PROXY",
    lines: (url: string) => [`HTTP_PROXY=${url}`, "NO_PROXY=example.invalid"],
  },
] as const;

/** The concatenated text deltas of a turn's assistant messages. */
function replyText(frames: readonly OmpFrame[]): string {
  return frames
    .map((frame) => {
      const update = frame.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      return frame.type === "message_update" && update?.type === "text_delta"
        ? String(update.delta)
        : "";
    })
    .join("");
}

/**
 * The listener, a world whose cwd `.env` holds `lines(<listener URL>)` and a `write`-tier runtime
 * with or without the two proxy pins; nothing is sent yet.
 */
async function proxyWorld(
  lines: (url: string) => readonly string[],
  proxyPins: boolean,
): Promise<{ proxy: { port: number; hits: ProxyHit[] }; world: OfficialWorld; run: Launch }> {
  const proxy = await proxyListener();
  const url = `http://127.0.0.1:${String(proxy.port)}`;
  const world = await openOfficialWorld(({ workspaceRoot }) => {
    writeFileSync(join(workspaceRoot, ".env"), [...lines(url), ""].join("\n"));
  });
  return { proxy, world, run: launch(world, undefined, true, proxyPins) };
}

describe.skipIf(OMP_TEST_OFF)(
  `official omp v${OMP_VERSION}: cwd .env cannot proxy the model requests`,
  () => {
    it.each(PROXY_CASES)(
      "$name: the turn ends with the fake upstream's reply, the proxy gets nothing",
      TURN_CASE,
      async ({ name, lines }) => {
        const { proxy, world, run } = await proxyWorld(lines, true);

        const frames = await collectPrompt(run.runtime.prompt(BASH_PROMPT));
        const hits = [...proxy.hits];
        const upstream = world.upstream.requests().length;
        log(run, {
          case: `proxy/${name}`,
          upstream,
          proxy: hits.map((hit) => hit.line),
          reply: replyText(frames),
        });

        expect(hits).toEqual([]);
        expect(frames.some((frame) => frame.type === "agent_end")).toBe(true);
        expect(replyText(frames)).toBe(FAKE_REPLY);
        expect(upstream).toBeGreaterThan(0);
        expect(run.env).toHaveLength(1);
        expect([run.env[0]?.no_proxy, run.env[0]?.NO_PROXY]).toEqual(["*", "*"]);
      },
    );

    it(
      "negative control: case (1) with the env lacking no_proxy and NO_PROXY, the proxy gets the model POST",
      TURN_CASE,
      async () => {
        const { proxy, world, run } = await proxyWorld(PROXY_CASES[0].lines, false);
        const target = `POST http://127.0.0.1:${String(world.upstream.port)}/`;

        // Not awaited: the proxy never forwards, the turn's end is not asserted; teardown stops it.
        const turn = collectPrompt(run.runtime.prompt(BASH_PROMPT));
        turn.then(
          () => {},
          () => {},
        );
        const deadline = Date.now() + PROXY_WAIT_MS;
        while (!proxy.hits.some((hit) => hit.line.startsWith(target)) && Date.now() < deadline) {
          await delay(PROXY_POLL_MS);
        }
        const hits = [...proxy.hits];
        const spawnedAt = run.spawnedAt[0] ?? Number.NaN;
        log(run, {
          case: "proxy/control",
          upstream: world.upstream.requests().length,
          proxy: hits.map((hit) => hit.line),
          sinceSpawnMs: hits.map((hit) => hit.at - spawnedAt),
          waitMs: PROXY_WAIT_MS,
        });

        expect(run.env).toHaveLength(1);
        expect(run.env[0]).not.toHaveProperty("no_proxy");
        expect(run.env[0]).not.toHaveProperty("NO_PROXY");
        expect(hits.some((hit) => hit.line.startsWith(target))).toBe(true);
      },
    );
  },
);
