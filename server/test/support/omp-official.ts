/**
 * The real-binary test tier (#813, #815, #984): a managed state layout, a sandbox with the
 * workspace `u1/proj`, the fake upstream as the model endpoint (`models.yml` points straight at it,
 * or with `freshToolRounds` at a forwarder in front of it, and the token book issues its key) and a `SessionRuntime` on the official omp binary whose cwd is
 * that workspace. Every approval request is recorded and answered, with deny unless the case says
 * otherwise. Opt-in through `WORKBUDDY_OMP_TEST=1`; opted in, `OMP_BIN` must be the pinned official
 * binary (`make omp-fetch`) — a missing or different one fails, it is never skipped.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import type { SpawnImpl } from "../../src/sessions/omp/process.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../../src/sessions/omp/state-layout.js";
import type { ApprovalDecision, ApprovalRequest } from "../../src/sessions/omp/ui-requests.js";
import { type FakeUpstreamServer, start } from "./fake-upstream.mjs";

export const OMP_VERSION = "18.0.10";
export const OMP_TEST_OFF = process.env.WORKBUDDY_OMP_TEST !== "1";
const MODEL_ID = "deepseek-v4.1-flash";
const UPSTREAM_KEY = "fake";
const OWNER_ID = "u1";

export interface OfficialDirs {
  agentDir: string;
  sandboxRoot: string;
  ownerRoot: string;
  workspaceRoot: string;
}

/** What one runtime of the world is started with; every key defaults to what production does. */
interface OfficialRuntimeOptions {
  /**
   * Rewrites the argv `spawnOmp` builds: the `--approval-mode` value, and with `hostOverlay: false`
   * the overlay is dropped from both of its sources (argv `--config` and env `PI_CONFIG_FILES`).
   */
  spawnArgs?: { approvalMode?: "always-ask" | "write" | "yolo"; hostOverlay?: boolean };
  /** The answer to an approval request; deny when absent, so nothing is executed. */
  onApproval?: (request: ApprovalRequest) => ApprovalDecision;
}

interface OfficialWorldOptions extends OfficialRuntimeOptions {
  /** The managed `models.yml` as text, given the model endpoint's base URL (its port is dynamic). */
  modelsYml?: (proxyBaseUrl: string) => string;
  /**
   * Lets a session that already holds a tool result open another tool round: the model endpoint
   * becomes a forwarder that shows the fake upstream only the running turn (see
   * `startTurnForwarder`).
   */
  freshToolRounds?: boolean;
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

/**
 * Test-only spawn wrapper: the product argv pins `--approval-mode write` and the overlay until the
 * tier reaches `spawnOmp` (s1g task 7.1, #1000, deletes this wrapper).
 */
function rewritingSpawn(rewrite: NonNullable<OfficialRuntimeOptions["spawnArgs"]>): SpawnImpl {
  return (command, args, options) => {
    const argv = [...args];
    const env = { ...options.env };
    if (rewrite.approvalMode !== undefined) {
      argv[argv.indexOf("--approval-mode") + 1] = rewrite.approvalMode;
    }
    if (rewrite.hostOverlay === false) {
      argv.splice(argv.indexOf("--config"), 2);
      delete env.PI_CONFIG_FILES;
    }
    return (spawn as SpawnImpl)(command, argv, { ...options, env });
  };
}

/** Headers of one hop only, and the length the forwarder recomputes. */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding"]);

function forwardedHeaders(headers: NodeJS.Dict<string | string[]>): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * A chat-completions body with `messages` cut down to the leading system messages plus everything
 * from the last user message onward; anything else is returned as it came.
 */
function currentTurnOnly(raw: Buffer): Buffer {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return raw;
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) {
    return raw;
  }
  const roles = messages.map((message: unknown) => (message as { role?: unknown } | null)?.role);
  const lastUser = roles.lastIndexOf("user");
  if (lastUser === -1) {
    return raw;
  }
  const leading = roles.findIndex((role) => role !== "system" && role !== "developer");
  const trimmed = [...messages.slice(0, leading), ...messages.slice(lastUser)];
  return Buffer.from(JSON.stringify({ ...(body as object), messages: trimmed }));
}

/**
 * Test device for `freshToolRounds`: a loopback forwarder between omp and the fake upstream. The
 * controlled upstream opens a tool round only when the request history holds no tool result, so
 * the second turn of a resumed session would get plain text and nothing could be approved. The
 * forwarder trims each chat-completions request to the running turn and passes everything else
 * (method, path, authorization, status, the streamed response) through. Only what the fake model
 * is shown changes: omp's argv, its session file and its RPC frames are untouched.
 */
async function startTurnForwarder(upstreamPort: number): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => response.destroy());
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = (request.url ?? "").split("?")[0] ?? "";
      const chat = request.method === "POST" && path.endsWith("/chat/completions");
      const body = chat ? currentTurnOnly(raw) : raw;
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: upstreamPort,
          method: request.method,
          path: request.url,
          headers: { ...forwardedHeaders(request.headers), "content-length": body.length },
          agent: false,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, forwardedHeaders(incoming.headers));
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        },
      );
      outgoing.on("error", () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(502).end();
        }
      });
      // The client went away (omp aborted the turn): drop the upstream request with it.
      response.on("close", () => outgoing.destroy());
      outgoing.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
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
  const agentDir = ompAgentDir(stateDir);
  ensureOmpStateLayout(stateDir);
  const upstream: FakeUpstreamServer = await start({ apiKey: UPSTREAM_KEY });
  cleanups.push(() => upstream.close());
  const modelPort =
    options.freshToolRounds === true ? await startTurnForwarder(upstream.port) : upstream.port;
  const proxyBaseUrl = `http://127.0.0.1:${String(modelPort)}/v1`;
  if (options.modelsYml === undefined) {
    await writeManagedModelsYml(agentDir, { proxyBaseUrl, modelId: MODEL_ID });
  } else {
    writeFileSync(join(agentDir, "models.yml"), options.modelsYml(proxyBaseUrl), { mode: 0o640 });
  }
  await writeHostOverlay(stateDir);
  const dirs = { agentDir, sandboxRoot, ownerRoot, workspaceRoot };
  plant(dirs);
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
      tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
      resumePath,
      ...(runtimeOptions.spawnArgs === undefined
        ? {}
        : { spawnImpl: rewritingSpawn(runtimeOptions.spawnArgs) }),
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
