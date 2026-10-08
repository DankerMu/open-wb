/**
 * Issue #102：真实 compiled production 入口。
 * HOST=0.0.0.0 绑定可用端口后，server_started 出现时
 * <OMP_STATE_DIR>/home/.omp/agent/models.yml 必须已经存在，且 baseUrl 指向该端口。
 * #166：经 models.yml、token registry 与代理的完整 fake-omp call-proxy 回合；
 * #210：models.yml 写入被扣住时交付 SIGTERM，不得迟发任何启动记录。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import {
  compiledFixtureEnv,
  compileServerEntry,
  createSession,
  expectBindable,
  gatedModelsWriteHook,
  login,
  prompt,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
  waitForFile,
  waitForTerminalAssistant,
  writeFakeOmpLauncher,
} from "./server-startup-helpers.js";
import { applicationStderr, MODEL_ID } from "./server-startup-order-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];
/** #88 fake-upstream 契约的固定回复文本。 */
const FIXTURE_TEXT = "你好，这是 WorkBuddy 的第一条流式回复。";
const scratch: string[] = [];
const upstreams: FakeUpstreamServer[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production entry lifecycle", () => {
  it("writes the actual-port model file before server_started and creates only the managed state layout", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-startup-case-"));
    scratch.push(scratchRoot);
    const state = join(scratchRoot, "state");
    const sandbox = join(scratchRoot, "sandbox");
    const dbPath = join(scratchRoot, "db", "dev.db");
    const ompBin = join(scratchRoot, "bin", "missing-omp");

    const server = startCompiledServer(compiled.entry, {
      HOST: "0.0.0.0",
      PORT: String(port),
      DB_PATH: dbPath,
      OMP_STATE_DIR: state,
      SANDBOX_ROOT: sandbox,
      OMP_BIN: ompBin,
      MODEL_ID,
    });

    try {
      const started = await server.waitForStarted();
      expect(server.stdout()).toBe(
        `${JSON.stringify({
          event: "server_started",
          host: "0.0.0.0",
          port,
          modules: STARTUP_MODULES,
        })}\n`,
      );
      expect(started).toEqual({
        event: "server_started",
        host: "0.0.0.0",
        port,
        modules: STARTUP_MODULES,
      });
      await expectConnectable("127.0.0.1", port);

      const agentDir = join(state, "home", ".omp", "agent");
      const modelsPath = join(agentDir, "models.yml");
      expect(
        existsSync(modelsPath),
        `models.yml missing after server_started\nstdout=${server.stdout()}\nstderr=${server.stderr()}`,
      ).toBe(true);
      const modelsText = readFileSync(modelsPath, "utf8");
      expect(parse(modelsText)).toEqual({
        providers: {
          workbuddy: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "WORKBUDDY_MODEL_TOKEN",
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                contextWindow: 128000,
                maxTokens: 8192,
                reasoning: true,
                compat: { reasoningContentField: "reasoning_content" },
              },
            ],
          },
        },
      });
      expect(modelsText).toContain("apiKey: WORKBUDDY_MODEL_TOKEN");
      expect(readdirSync(state).toSorted()).toEqual([
        "home",
        "sessions",
        "snapshots",
        "trash",
        "xdg",
      ]);
      expect(readdirSync(join(state, "home")).toSorted()).toEqual([".env", ".omp"]);
      expect(readdirSync(join(state, "sessions"))).toEqual([]);
      expect(readdirSync(agentDir).toSorted()).toEqual(["host-overlay.yml", "models.yml"]);
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(join(scratchRoot, "bin"))).toBe(false);
    } finally {
      await server.dispose();
    }
  }, 90_000);

  it("records native exit before listener close before database close", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-startup-order-"));
    scratch.push(scratchRoot);
    const tracePath = join(scratchRoot, "order.log");
    const bin = writeFakeOmpLauncher(scratchRoot, "hang-eof");
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, port, bin, { MODEL_ID }),
      { orderTrace: tracePath },
    );
    let exitCode: number | null = 1;
    try {
      await server.waitForStarted();
      const cookie = await login(port);
      const session = await createSession(port, cookie);
      await prompt(port, cookie, session, "stay-alive");
      exitCode = await server.stop();
      expect(readFileSync(tracePath, "utf8")).toBe("runtime-exit\nlistener-close\ndb-close\n");
      expect(exitCode).toBe(0);
    } finally {
      await server.dispose();
    }
  }, 40_000);

  it("relays a full call-proxy turn without leaking the upstream key or runtime bearer", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-proxy-turn-"));
    scratch.push(scratchRoot);
    const upstreamKey = `upstream-sentinel-${randomBytes(23).toString("hex")}`;
    const upstream = await startTrackedFakeUpstream(upstreams, { apiKey: upstreamKey });
    const bearerPath = join(scratchRoot, "runtime-bearer.txt");
    const bin = writeFakeOmpLauncher(scratchRoot, "call-proxy", bearerPath);
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, port, bin, {
        MODEL_ID,
        MODEL_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.port}`,
        MODEL_UPSTREAM_API_KEY: upstreamKey,
      }),
    );
    try {
      await server.waitForStarted();
      const cookie = await login(port);
      const session = await createSession(port, cookie);
      await prompt(port, cookie, session, "hello through the proxy");
      const assistant = await waitForTerminalAssistant(port, cookie, session, 15_000);
      expect(assistant).toMatchObject({ content: FIXTURE_TEXT, status: "done" });
      expect(assistant.steps).toMatchObject([{ name: "bash", status: "done" }]);
      const bearer = readFileSync(bearerPath, "utf8");
      expect(bearer).toMatch(/^[0-9a-f]{64}$/iu);
      const modelsText = readFileSync(
        join(scratchRoot, "state", "home", ".omp", "agent", "models.yml"),
        "utf8",
      );
      expect(modelsText).toContain("apiKey: WORKBUDDY_MODEL_TOKEN");
      expect(await server.stop()).toBe(0);
      for (const secret of [upstreamKey, bearer]) {
        expect(modelsText).not.toContain(secret);
        expect(server.stdout()).not.toContain(secret);
        expect(server.stderr()).not.toContain(secret);
      }
    } finally {
      await server.dispose();
    }
  }, 90_000);

  it("publishes nothing when SIGTERM arrives while the models.yml write is held", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-held-write-"));
    scratch.push(scratchRoot);
    const tracePath = join(scratchRoot, "order.log");
    const entered = join(scratchRoot, "write-entered");
    const observed = join(scratchRoot, "signal-observed");
    const hook = join(scratchRoot, "gated-models-write.cjs");
    writeFileSync(hook, gatedModelsWriteHook("call-through"));
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, port, join(scratchRoot, "bin", "omp"), {
        MODEL_ID,
        MODELS_ENTERED: entered,
        MODELS_RELEASE: observed,
      }),
      { orderTrace: tracePath, requireHook: hook },
    );
    try {
      await waitForFile(entered, 15_000);
      expect(existsSync(observed)).toBe(false);
      await server.stop();
      expect(await server.waitForClose()).toEqual({ code: 0, signal: null });
      expect(existsSync(observed)).toBe(true);
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe("");
      const written = join(scratchRoot, "state", "home", ".omp", "agent", "models.yml");
      expect(parse(readFileSync(written, "utf8"))).toMatchObject({
        providers: { workbuddy: { baseUrl: `http://127.0.0.1:${port}/v1` } },
      });
      expect(readFileSync(tracePath, "utf8")).toBe("listener-close\ndb-close\n");
      await expectBindable("127.0.0.1", port);
    } finally {
      await server.dispose();
    }
  }, 90_000);
});

function expectConnectable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    }, 2_000);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", fail);
  });
}
