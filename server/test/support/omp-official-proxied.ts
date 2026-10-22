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
 *
 * Tasks 4.4 / 5.5 add `openProxiedApp`: the same proxy and upstream, with the production sessions
 * assembly (createApp → registerSessions → SessionSupervisor, SQLite, the system clock) in front of
 * the official binary instead of a bare `SessionRuntime`, so a case sees what the browser sees (the
 * published events), the sessions `log` port and the stop route. The proxy stays the standalone
 * one above (createApp's own `/v1` cannot take injected deadlines); it shares the app's
 * `TokenRegistry`, so a spawn's bearer resolves exactly as in production. The child's stdout is
 * teed into `frames` (the runtime still reads every byte), so the omp-level assertions still hold.
 * Group 6 hands createApp the proxy's own upstream (key and base URL), as production does, so the
 * sessions-side sanitiser works with the same secret list, and exposes the app's database.
 *
 * s1d-model-registry group 5 adds the `registry` option: the proxy and createApp share one real model
 * registry (`models/store.ts` + `models/registry.ts`) on the app's database, its rows written once the
 * fake upstream's port is known (the fake expects the given key, so its `secret` body echoes it), and
 * createApp gets `assembly.models` and no `assembly.upstream` — as the production entry assembles it.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import fastify, { type FastifyInstance } from "fastify";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/core/db/index.js";
import { handleHttpError } from "../../src/http/errors.js";
import { registerModelProxy } from "../../src/model-proxy/index.js";
import { staticRegistry } from "../../src/model-proxy/lookup.js";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import { createRegistry } from "../../src/models/registry.js";
import { createModelStore } from "../../src/models/store.js";
import type { ChatEvent } from "../../src/sessions/events.js";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import type { SpawnImpl } from "../../src/sessions/omp/process.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout, ompAgentDir } from "../../src/sessions/omp/state-layout.js";
import type { ApprovalRequest } from "../../src/sessions/omp/ui-requests.js";
import { TokenRegistry } from "../../src/sessions/tokens.js";
import { FIXED_NOW, fixedRuntime } from "../session-db-helpers.js";
import { cookieFor } from "../session-rest-helpers.js";
import { type FakeUpstreamServer, start } from "./fake-upstream.mjs";
import { officialBin, onTeardown, teeStdoutFrames } from "./omp-official.js";
import { type StalledHandshake, startStalledHandshake } from "./stalled-handshake.js";

/** The two whitelisted models; the runtime runs the first. */
export const PROXIED_MODELS = ["deepseek-v4.1-flash", "workbuddy-second"] as const;
const PROXIED_CATALOG = {
  models: PROXIED_MODELS.map((id) => ({
    id,
    name: id,
    reasoning: false,
    vision: false,
    maxTokens: 32768,
  })),
  defaultModelId: PROXIED_MODELS[0],
};
const UPSTREAM_KEY = "fake";
const OWNER_ID = "u1";

interface ProxiedWorldOptions {
  /** Where the proxy sends requests; the fake upstream when absent. */
  target?: "fake-upstream" | "stalled-handshake";
  firstByteDeadlineMs?: number;
  connectDeadlineMs?: number;
  /** A shared real registry whose rows route to the fake upstream expecting `apiKey`; absent → static. */
  registry?: { apiKey: string };
}

/** The shared registry of the `registry` option: its database is the app's. */
interface SharedRegistry {
  db: DatabaseSync;
  store: ReturnType<typeof createModelStore>;
  registry: ReturnType<typeof createRegistry>;
}

export interface ProxiedWorld {
  runtime: SessionRuntime;
  upstream: FakeUpstreamServer;
  stalled: StalledHandshake;
  workspaceRoot: string;
  approvals: ApprovalRequest[];
}

/** What the sessions `log` port received, in order. */
type LogRecord = Record<string, unknown>;

export interface ProxiedApp {
  app: FastifyInstance;
  /** The app's database (the three error columns, #909 group 6). */
  db: DatabaseSync;
  upstream: FakeUpstreamServer;
  stalled: StalledHandshake;
  cookie: string;
  /** Every published event of every session, in publication order, with its `Date.now()`. */
  events: Array<{ sessionId: string; event: ChatEvent<number>; at: number }>;
  /** Every frame omp wrote to stdout, across spawns, in arrival order. */
  frames: OmpFrame[];
  log: LogRecord[];
  /** Approval ids the world denied (the direct world's 「deny unless the case says otherwise」). */
  denied: number[];
  /** Faults the supervisor retained; a passing case leaves it empty. */
  faults: Error[];
  /** The shared registry when the `registry` option was given. */
  models: SharedRegistry | undefined;
}

interface Proxied {
  bin: string;
  stateDir: string;
  sandboxRoot: string;
  workspaceRoot: string;
  upstream: FakeUpstreamServer;
  stalled: StalledHandshake;
  tokens: TokenRegistry;
  /** What the proxy forwards to; createApp gets the same (production's one `upstream`). */
  target: { baseUrl: string; apiKey: string };
  shared: SharedRegistry | undefined;
}

/** The `registry` option: the proxied catalog registered in a fresh database, each row routed to `target`. */
function sharedRegistry(target: { baseUrl: string; apiKey: string }): SharedRegistry {
  const db = openDb(":memory:");
  onTeardown(() => db.close());
  const store = createModelStore(db);
  for (const model of PROXIED_CATALOG.models) {
    store.create({ ...model, upstream: target });
  }
  const registry = createRegistry(store);
  registry.refresh();
  return { db, store, registry };
}

/** The layout, upstream, stalled listener and proxy shared by both worlds; torn down per case. */
async function openProxy(options: ProxiedWorldOptions): Promise<Proxied> {
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
  const upstream = await start({ apiKey: options.registry?.apiKey ?? UPSTREAM_KEY });
  onTeardown(() => upstream.close());
  const stalled = await startStalledHandshake();
  onTeardown(() => stalled.close());
  const tokens = new TokenRegistry();
  const proxy = fastify({ logger: false });
  proxy.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  const target = {
    baseUrl:
      options.target === "stalled-handshake"
        ? `https://127.0.0.1:${String(stalled.port)}`
        : `http://127.0.0.1:${String(upstream.port)}/v1`,
    apiKey: options.registry?.apiKey ?? UPSTREAM_KEY,
  };
  // Written only now: the rows carry the fake upstream's port.
  const shared = options.registry === undefined ? undefined : sharedRegistry(target);
  registerModelProxy(proxy, {
    tokens,
    models: shared?.registry ?? staticRegistry(PROXIED_CATALOG, target),
    ...(options.firstByteDeadlineMs === undefined
      ? {}
      : { firstByteDeadlineMs: options.firstByteDeadlineMs }),
    ...(options.connectDeadlineMs === undefined
      ? {}
      : { connectDeadlineMs: options.connectDeadlineMs }),
  });
  await proxy.listen({ host: "127.0.0.1", port: 0 });
  onTeardown(() => proxy.close());
  await writeManagedModelsYml(ompAgentDir(stateDir), {
    proxyBaseUrl: deriveProxyBaseUrl(proxy.server.address() as AddressInfo),
    models: PROXIED_CATALOG.models,
  });
  await writeHostOverlay(stateDir, { browserEnabled: false, visionModelId: null });
  return { bin, stateDir, sandboxRoot, workspaceRoot, upstream, stalled, tokens, target, shared };
}

export async function openProxiedWorld(options: ProxiedWorldOptions = {}): Promise<ProxiedWorld> {
  const proxied = await openProxy(options);
  const approvals: ApprovalRequest[] = [];
  const runtime: SessionRuntime = new SessionRuntime({
    sessionId: "omp-official-proxied",
    bin: proxied.bin,
    sandboxRoot: proxied.sandboxRoot,
    stateDir: proxied.stateDir,
    ownerId: OWNER_ID,
    cwd: proxied.workspaceRoot,
    modelId: PROXIED_MODELS[0],
    approvalMode: "write",
    tokens: proxied.tokens,
    onApproval: (request) => {
      approvals.push(request);
      runtime.respondApproval(request.id, "deny");
    },
  });
  onTeardown(() => runtime.shutdown());
  const { upstream, stalled, workspaceRoot } = proxied;
  return { runtime, upstream, stalled, workspaceRoot, approvals };
}

/** Appends every stdout frame of `child` to `frames` (`teeStdoutFrames`); omp's own reader is untouched. */
function teeFrames(child: ChildProcessWithoutNullStreams, frames: OmpFrame[]): void {
  teeStdoutFrames(child.stdout, (frame) => frames.push(frame));
}

export async function openProxiedApp(options: ProxiedWorldOptions = {}): Promise<ProxiedApp> {
  const proxied = await openProxy(options);
  const frames: OmpFrame[] = [];
  const events: ProxiedApp["events"] = [];
  const log: LogRecord[] = [];
  const denied: number[] = [];
  const faults: Error[] = [];
  const teeing: SpawnImpl = (command, args, spawnOptions) => {
    const child = (spawn as SpawnImpl)(command, args, spawnOptions);
    teeFrames(child, frames);
    return child;
  };
  const { shared } = proxied;
  const db = shared?.db ?? openDb(":memory:");
  const app: FastifyInstance = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      tokens: proxied.tokens,
      ...(shared === undefined ? { upstream: proxied.target } : { models: shared.registry }),
      runtime: {
        bin: proxied.bin,
        sandboxRoot: proxied.sandboxRoot,
        stateDir: proxied.stateDir,
        modelId: PROXIED_MODELS[0],
        spawnImpl: teeing,
      },
      onError: (error) => {
        faults.push(error);
      },
      onEvent: (sessionId, _epoch, event) => {
        events.push({ sessionId, event, at: Date.now() });
        if (event.type === "approval.request") {
          denied.push(event.data.approvalId);
          // The observer must return synchronously; the answer goes out on the next turn.
          setImmediate(() => {
            void app.sessions.supervisor
              .decide(sessionId, event.data.approvalId, "deny")
              .catch(() => undefined);
          });
        }
      },
      log: (record) => {
        log.push({ ...record });
      },
    },
  });
  onTeardown(async () => {
    try {
      await app.close();
    } finally {
      // A shared database is closed by its own (earlier registered, so later run) teardown step.
      if (shared === undefined) {
        db.close();
      }
    }
  });
  const cookie = await cookieFor(app, "zhangsan");
  const { upstream, stalled } = proxied;
  return {
    app,
    db,
    upstream,
    stalled,
    cookie,
    events,
    frames,
    log,
    denied,
    faults,
    models: shared,
  };
}

/** One prompt of `openProxiedApp`, as the browser and omp saw it. */
export interface AppTurn {
  session: string;
  /** omp's frames of the turn: the first `agent_start` through the terminal `agent_end`. */
  frames: OmpFrame[];
  /** The session's published events. */
  events: ChatEvent<number>[];
  /** From the prompt route's call to the published `turn.end` (or to `stopAt`). */
  ms: number;
}

const POLL_MS = 20;
const TURN_BOUND_MS = 170_000;

/** A fresh session of `world`'s account; resolves to its id. */
export async function openAppSession(world: ProxiedApp): Promise<string> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  if (response.statusCode !== 201) {
    throw new Error(`session creation answered ${String(response.statusCode)}`);
  }
  return (response.json() as { id: string }).id;
}

/** Polls `done` on real time until it holds or the bound passes. */
export async function until(done: () => boolean, what: string, boundMs = TURN_BOUND_MS) {
  const deadline = Date.now() + boundMs;
  while (!done()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The published events of `session`, in order. */
export function publishedOf(world: ProxiedApp, session: string): ChatEvent<number>[] {
  return world.events.filter((entry) => entry.sessionId === session).map((entry) => entry.event);
}

function turnFrames(frames: readonly OmpFrame[]): OmpFrame[] {
  const first = frames.findIndex((frame) => frame.type === "agent_start");
  const last = frames.findIndex(
    (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
  );
  return first === -1 ? [] : frames.slice(first, last === -1 ? undefined : last + 1);
}

/**
 * Prompts a fresh session and waits for its published `turn.end`, or until a frame matches `stopAt`
 * (the turn is then abandoned to the case's teardown).
 */
export async function runAppTurn(
  world: ProxiedApp,
  text: string,
  stopAt?: (frame: OmpFrame) => boolean,
): Promise<AppTurn> {
  const session = await openAppSession(world);
  const startedAt = Date.now();
  const response = await world.app.inject({
    method: "POST",
    url: `/api/sessions/${session}/prompt`,
    headers: { "content-type": "application/json", cookie: world.cookie },
    payload: JSON.stringify({ message: text }),
  });
  if (response.statusCode !== 202) {
    throw new Error(`prompt answered ${String(response.statusCode)}`);
  }
  await until(
    () =>
      publishedOf(world, session).some((event) => event.type === "turn.end") ||
      (stopAt !== undefined && world.frames.some(stopAt)),
    `the turn of ${text}`,
  );
  const ms = Date.now() - startedAt;
  return { session, frames: turnFrames(world.frames), events: publishedOf(world, session), ms };
}
