/**
 * The real-binary test tier (#813, #815, #984): a managed state layout, a sandbox with the
 * workspace `u1/proj`, the fake upstream as the model endpoint (`models.yml` points straight at it
 * and the token book issues its key; nothing sits between omp and the upstream) and a
 * `SessionRuntime` on the official omp binary whose cwd is that workspace. Every approval request
 * is recorded and answered, with deny unless the case says otherwise. Opt-in through `WORKBUDDY_OMP_TEST=1`; opted in, `OMP_BIN` must be the pinned official
 * binary (`make omp-fetch`) — a missing or different one fails, it is never skipped.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import type { SpawnImpl } from "../../src/sessions/omp/process.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../../src/sessions/omp/state-layout.js";
import type { ApprovalDecision, ApprovalRequest } from "../../src/sessions/omp/ui-requests.js";
import { type FakeUpstreamServer, type FakeUpstreamStartOptions, start } from "./fake-upstream.mjs";

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
   * `approvalMode` is the runtime's own (`write` when absent); with `hostOverlay: false` the
   * overlay is dropped from both of its sources (argv `--config` and env `PI_CONFIG_FILES`).
   */
  spawnArgs?: { approvalMode?: "always-ask" | "write" | "yolo"; hostOverlay?: boolean };
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

/** Registers a teardown step of the running case (also used by the proxied world, #909). */
export function onTeardown(step: () => unknown): void {
  cleanups.push(step);
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
      approvalMode: runtimeOptions.spawnArgs?.approvalMode ?? "write",
      tokens: { issue: () => UPSTREAM_KEY, revoke: () => {} },
      resumePath,
      ...(runtimeOptions.spawnArgs?.hostOverlay === false ? { spawnImpl: rewritingSpawn } : {}),
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
