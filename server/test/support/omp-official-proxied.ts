/**
 * Issue #909 (task 1.6): the real-binary world with the model proxy in between. `openOfficialWorld`
 * points `models.yml` straight at the fake upstream, so it cannot show what omp does with the
 * proxy's failure answers; here `registerModelProxy` listens on loopback, its token lookup is the
 * runtime's own `TokenRegistry` (64-hex bearers, as in production), the managed `models.yml` names
 * two whitelisted models of one provider and points at the proxy, and the proxy forwards to the fake
 * upstream — or, with `target: "stalled-handshake"`, to a listener that accepts TCP and never
 * completes TLS. Both deadlines can be injected (production passes neither). Every approval is
 * denied and recorded. Opt-in through `WORKBUDDY_OMP_TEST=1` with the pinned binary, as the
 * direct world.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { handleHttpError } from "../../src/http/errors.js";
import { registerModelProxy } from "../../src/model-proxy/index.js";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../../src/sessions/omp/state-layout.js";
import type { ApprovalRequest } from "../../src/sessions/omp/ui-requests.js";
import { TokenRegistry } from "../../src/sessions/tokens.js";
import { type FakeUpstreamServer, start } from "./fake-upstream.mjs";
import { officialBin, onTeardown } from "./omp-official.js";
import { type StalledHandshake, startStalledHandshake } from "./stalled-handshake.js";

/** The two whitelisted models; the runtime runs the first. */
const PROXIED_MODELS = ["deepseek-v4.1-flash", "workbuddy-second"] as const;
const UPSTREAM_KEY = "fake";
const OWNER_ID = "u1";

interface ProxiedWorldOptions {
  /** Where the proxy sends requests; the fake upstream when absent. */
  target?: "fake-upstream" | "stalled-handshake";
  firstByteDeadlineMs?: number;
  connectDeadlineMs?: number;
}

export interface ProxiedWorld {
  runtime: SessionRuntime;
  upstream: FakeUpstreamServer;
  stalled: StalledHandshake;
  workspaceRoot: string;
  approvals: ApprovalRequest[];
}

export async function openProxiedWorld(options: ProxiedWorldOptions = {}): Promise<ProxiedWorld> {
  const bin = officialBin();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-official-proxied-")));
  onTeardown(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const sandboxRoot = join(root, "sandbox");
  const workspaceRoot = join(sandboxRoot, OWNER_ID, "proj");
  mkdirSync(workspaceRoot, { recursive: true });
  // Ends omp's upward walk at the sandbox root, as in the direct world.
  mkdirSync(join(sandboxRoot, ".git"));
  ensureOmpStateLayout(stateDir);
  const upstream = await start({ apiKey: UPSTREAM_KEY });
  onTeardown(() => upstream.close());
  const stalled = await startStalledHandshake();
  onTeardown(() => stalled.close());
  const tokens = new TokenRegistry();
  const proxy = fastify({ logger: false });
  proxy.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  registerModelProxy(proxy, {
    tokens,
    allowedModels: new Set(PROXIED_MODELS),
    upstream: {
      baseUrl:
        options.target === "stalled-handshake"
          ? `https://127.0.0.1:${String(stalled.port)}`
          : `http://127.0.0.1:${String(upstream.port)}/v1`,
      apiKey: UPSTREAM_KEY,
    },
    ...(options.firstByteDeadlineMs === undefined
      ? {}
      : { firstByteDeadlineMs: options.firstByteDeadlineMs }),
    ...(options.connectDeadlineMs === undefined
      ? {}
      : { connectDeadlineMs: options.connectDeadlineMs }),
  });
  await proxy.listen({ host: "127.0.0.1", port: 0 });
  onTeardown(() => proxy.close());
  const agentDir = ompAgentDir(stateDir);
  await writeManagedModelsYml(agentDir, {
    proxyBaseUrl: deriveProxyBaseUrl(proxy.server.address() as AddressInfo),
    models: PROXIED_MODELS.map((id) => ({ id, name: id, reasoning: false, vision: false })),
  });
  await writeHostOverlay(stateDir);
  const approvals: ApprovalRequest[] = [];
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-proxied",
    bin,
    sandboxRoot,
    stateDir,
    ownerId: OWNER_ID,
    cwd: workspaceRoot,
    modelId: PROXIED_MODELS[0],
    approvalMode: "write",
    tokens,
    onApproval: (request) => {
      approvals.push(request);
      runtime.respondApproval(request.id, "deny");
    },
  });
  onTeardown(() => runtime.shutdown());
  return { runtime, upstream, stalled, workspaceRoot, approvals };
}
