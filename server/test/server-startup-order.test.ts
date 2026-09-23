/**
 * Issue #102：真实 compiled production 入口。
 * HOST=0.0.0.0 绑定可用端口后，server_started 出现时
 * <OMP_STATE_DIR>/agent/models.yml 必须已经存在，且 baseUrl 指向该端口。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compileServerEntry,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";

const MODEL_ID = "issue-102-tracer-model";
const STARTUP_MODULES = ["core/db", "auth", "http", "model-proxy", "sessions"];
const SQLITE_EXPERIMENTAL_WARNING =
  "ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";
const scratch: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production entry lifecycle", () => {
  it("writes the actual-port model file before server_started and creates no eager runtime dirs", async () => {
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

      const modelsPath = join(state, "agent", "models.yml");
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
              },
            ],
          },
        },
      });
      expect(modelsText).toContain("apiKey: WORKBUDDY_MODEL_TOKEN");
      expect(readdirSync(state).toSorted()).toEqual(["agent"]);
      expect(readdirSync(join(state, "agent")).toSorted()).toEqual(["models.yml"]);
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
    const binDir = join(scratchRoot, "bin");
    mkdirSync(binDir);
    const bin = join(binDir, "hang-omp.mjs");
    writeFileSync(bin, hangEofLauncher());
    chmodSync(bin, 0o755);
    const server = startCompiledServer(
      compiled.entry,
      {
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: join(scratchRoot, "db", "dev.db"),
        OMP_STATE_DIR: join(scratchRoot, "state"),
        SANDBOX_ROOT: join(scratchRoot, "sandbox"),
        OMP_BIN: bin,
        MODEL_ID,
      },
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
});

describe("production entry rejects invalid OMP_USER before effects", () => {
  it.each([
    ["empty", ""],
    ["uppercase", "Omp"],
    ["space", "omp user"],
    ["semicolon", "root;id"],
  ])(
    "rejects %s with one generic record and no startup effects",
    async (_name, user) => {
      const compiled = await compileServerEntry();
      const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-omp-user-"));
      scratch.push(scratchRoot);
      const dbParent = join(scratchRoot, "db");
      const state = join(scratchRoot, "state");
      const sandbox = join(scratchRoot, "sandbox");
      const port = await reserveWildcardPort();
      const server = startCompiledServer(compiled.entry, {
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: join(dbParent, "dev.db"),
        OMP_STATE_DIR: state,
        SANDBOX_ROOT: sandbox,
        OMP_BIN: join(scratchRoot, "bin", "omp"),
        OMP_USER: user,
      });
      const closed = await server.waitForClose();
      expect(closed.code).toBe(1);
      expect(closed.signal).toBeNull();
      expect(server.stdout()).toBe("");
      const applicationStderr = server
        .stderr()
        .replace(/^\(node:\d+\) /u, "")
        .replace(SQLITE_EXPERIMENTAL_WARNING, "");
      expect(applicationStderr).toBe(`${JSON.stringify({ event: "server_start_failed" })}\n`);
      expect(existsSync(dbParent)).toBe(false);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(join(scratchRoot, "bin"))).toBe(false);
      await expectRefused("127.0.0.1", port);
    },
    90_000,
  );
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

function expectRefused(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`unexpected listener on ${host}:${port}`));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
}

function hangEofLauncher(): string {
  const fake = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
  return `#!${process.execPath}
process.argv.push("--scenario", "hang-eof");
await import(${JSON.stringify(fake)});
`;
}

function login(port: number): Promise<string> {
  return requestJson(port, "POST", "/api/auth/login", undefined, {
    account: "zhangsan",
    password: "demo",
  }).then((response) => {
    const cookie = response.headers.get("set-cookie");
    if (response.status !== 200 || cookie === null || !cookie.startsWith("workbuddy_session=")) {
      throw new Error(`login failed: ${response.status} ${response.body}`);
    }
    return cookie.slice(0, cookie.indexOf(";"));
  });
}

function createSession(port: number, cookie: string): Promise<string> {
  return requestJson(port, "POST", "/api/sessions", cookie).then((response) => {
    const body = JSON.parse(response.body) as { id?: unknown };
    if (response.status !== 201 || typeof body.id !== "string") {
      throw new Error(`session create failed: ${response.status} ${response.body}`);
    }
    return body.id;
  });
}

function prompt(port: number, cookie: string, session: string, message: string): Promise<void> {
  return requestJson(port, "POST", `/api/sessions/${session}/prompt`, cookie, { message }).then(
    (response) => {
      if (response.status !== 202) {
        throw new Error(`prompt failed: ${response.status} ${response.body}`);
      }
    },
  );
}

function requestJson(
  port: number,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: string }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  }).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }));
}
