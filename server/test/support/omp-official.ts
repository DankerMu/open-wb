/**
 * The real-binary test tier (#813, #815): a managed state layout, a sandbox with the workspace
 * `u1/proj`, the fake upstream as the model endpoint (`models.yml` points straight at it and the
 * token book issues its key; its bash tool call is denied) and a `SessionRuntime` on the official
 * omp binary whose cwd is that workspace. Opt-in through `WORKBUDDY_OMP_TEST=1`; opted in,
 * `OMP_BIN` must be the pinned official binary (`make omp-fetch`) — a missing or different one
 * fails, it is never skipped.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../../src/sessions/omp/state-layout.js";
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

export interface OfficialWorld extends OfficialDirs {
  runtime: SessionRuntime;
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
 * Opens the world. `plant` writes the project files before anything is spawned (the process
 * starts with the first command or prompt); everything is torn down after the running case.
 */
export async function openOfficialWorld(
  plant: (dirs: OfficialDirs) => void,
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
  await writeManagedModelsYml(agentDir, {
    proxyBaseUrl: `http://127.0.0.1:${String(upstream.port)}/v1`,
    modelId: MODEL_ID,
  });
  await writeHostOverlay(stateDir);
  const dirs = { agentDir, sandboxRoot, ownerRoot, workspaceRoot };
  plant(dirs);
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official",
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
  return { runtime, ...dirs };
}
