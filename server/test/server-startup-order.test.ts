/**
 * Issue #102：真实 compiled production 入口。
 * HOST=0.0.0.0 绑定可用端口后，server_started 出现时
 * <OMP_STATE_DIR>/agent/models.yml 必须已经存在，且 baseUrl 指向该端口。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withOpenDb } from "./core-db-helpers.js";
import {
  type CompiledServerEntry,
  childUmaskHook,
  compileServerEntry,
  denyChmodHook,
  observeOpenDbHook,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";
import { sudoPrefix } from "./session-supervisor-helpers.js";

const MODEL_ID = "issue-102-tracer-model";
const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];
const PRIVATE_FILE_MODE = 0o600;
const SHARED_DIR_MODE = 0o2770;
const EXISTING_DIR_MODE = 0o755;
const MARKER_TITLE = "owned-state-marker";
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
});

describe("production entry private state permissions", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it("repairs a cold DB and pre-existing 0644 main/WAL/SHM to 0600 before open", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-private-db-"));
    scratch.push(scratchRoot);
    const dbParent = join(scratchRoot, "db");
    mkdirSync(dbParent, { recursive: true });
    chmodSync(dbParent, EXISTING_DIR_MODE);
    const dbPath = join(dbParent, "dev.db");
    const state = join(scratchRoot, "state");
    const sandbox = join(scratchRoot, "sandbox");
    const existingState = join(scratchRoot, "existing-state");
    const existingSandbox = join(scratchRoot, "existing-sandbox");
    mkdirSync(existingState, { recursive: true });
    mkdirSync(existingSandbox, { recursive: true });
    chmodSync(existingState, EXISTING_DIR_MODE);
    chmodSync(existingSandbox, EXISTING_DIR_MODE);
    const umaskBefore = process.umask();
    const modeLog = join(scratchRoot, "modes.jsonl");
    const hookPath = join(scratchRoot, "observe-open.cjs");
    writeFileSync(hookPath, observeOpenDbHook());

    const coldPort = await reserveWildcardPort();
    const restrictiveUmask = 0o077;
    const previousUmask = process.umask(restrictiveUmask);
    let restoredUmask = false;
    const restoreUmask = (): void => {
      if (!restoredUmask) {
        process.umask(previousUmask);
        restoredUmask = true;
      }
    };
    const cold = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, coldPort, join(scratchRoot, "bin", "omp"), {
        MODEL_ID,
        OMP_STATE_DIR: state,
        SANDBOX_ROOT: sandbox,
        MODE_LOG: modeLog,
      }),
      { requireHook: hookPath },
    );
    try {
      await cold.waitForStarted();
      restoreUmask();
      expect(process.umask()).toBe(umaskBefore);
      const coldLive = readModeObservations(modeLog);
      expect(coldLive.length).toBeGreaterThan(0);
      const firstOpen = coldLive[0];
      if (firstOpen === undefined) {
        throw new Error("openDb was not observed");
      }
      expect(firstOpen.path).toBe(dbPath);
      expect(firstOpen.main).toBe(PRIVATE_FILE_MODE);
      expect(firstOpen.wal === null || firstOpen.wal === PRIVATE_FILE_MODE).toBe(true);
      expect(firstOpen.shm === null || firstOpen.shm === PRIVATE_FILE_MODE).toBe(true);
      expectLivePrivateFiles(dbPath);
      expect(lstatSync(join(state, "agent")).mode & 0o7777).toBe(SHARED_DIR_MODE);
      expect(existsSync(sandbox)).toBe(false);
      expect(lstatSync(dbParent).mode & 0o7777).toBe(EXISTING_DIR_MODE);
    } finally {
      restoreUmask();
      await cold.dispose();
    }

    seedOwnedMarker(dbPath);
    chmodSync(dbPath, 0o644);
    writeFileSync(`${dbPath}-wal`, "");
    writeFileSync(`${dbPath}-shm`, "");
    chmodSync(`${dbPath}-wal`, 0o644);
    chmodSync(`${dbPath}-shm`, 0o644);
    writeFileSync(modeLog, "");

    const restartPort = await reserveWildcardPort();
    const restart = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, restartPort, join(scratchRoot, "bin", "omp"), {
        MODEL_ID,
        DB_PATH: dbPath,
        OMP_STATE_DIR: existingState,
        SANDBOX_ROOT: existingSandbox,
        MODE_LOG: modeLog,
      }),
      { requireHook: hookPath },
    );
    try {
      await restart.waitForStarted();
      const restartLive = readModeObservations(modeLog);
      expect(restartLive.length).toBeGreaterThan(0);
      const firstRestart = restartLive[0];
      if (firstRestart === undefined) {
        throw new Error("restart openDb was not observed");
      }
      expect(firstRestart.path).toBe(dbPath);
      expect(firstRestart.main).toBe(PRIVATE_FILE_MODE);
      expect(firstRestart.wal).toBe(PRIVATE_FILE_MODE);
      expect(firstRestart.shm).toBe(PRIVATE_FILE_MODE);
      expectLivePrivateFiles(dbPath);
      expect(readOwnedMarker(dbPath)).toBe(MARKER_TITLE);
      expect(lstatSync(existingState).mode & 0o7777).toBe(EXISTING_DIR_MODE);
      expect(lstatSync(existingSandbox).mode & 0o7777).toBe(EXISTING_DIR_MODE);
      expect(lstatSync(join(existingState, "agent")).mode & 0o7777).toBe(SHARED_DIR_MODE);
      expect(existsSync(join(existingSandbox, "u1"))).toBe(false);
    } finally {
      await restart.dispose();
    }
    expect(process.umask()).toBe(umaskBefore);
  }, 90_000);

  it("skips private file preparation for :memory: and leaves no DB files", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-memory-db-"));
    scratch.push(scratchRoot);
    const dbParent = join(scratchRoot, "db");
    const state = join(scratchRoot, "state");
    const sandbox = join(scratchRoot, "sandbox");
    const modeLog = join(scratchRoot, "modes.jsonl");
    const hookPath = join(scratchRoot, "observe-open.cjs");
    writeFileSync(hookPath, observeOpenDbHook());
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, port, join(scratchRoot, "bin", "omp"), {
        MODEL_ID,
        DB_PATH: ":memory:",
        MODE_LOG: modeLog,
      }),
      { requireHook: hookPath },
    );
    try {
      await server.waitForStarted();
      const observations = readModeObservations(modeLog);
      expect(observations).toEqual([{ path: ":memory:", main: null, wal: null, shm: null }]);
      expect(existsSync(dbParent)).toBe(false);
      expect(existsSync(join(scratchRoot, "dev.db"))).toBe(false);
      expect(existsSync(join(state, "agent", "models.yml"))).toBe(true);
      expect(existsSync(sandbox)).toBe(false);
    } finally {
      await server.dispose();
    }
  }, 40_000);

  it("fails closed when native chmod of the existing main file is denied and retains data", async () => {
    const seeded = seedDeniedDb("open-wb-chmod-fail-");
    chmodSync(seeded.dbPath, 0o644);
    await startDeniedPreparation(compiled, seeded, [seeded.dbPath], "deny-chmod.cjs");
    expect(existsSync(join(seeded.scratchRoot, "sandbox"))).toBe(false);
    expect(lstatSync(seeded.dbPath).mode & 0o777).toBe(0o644);
    expect(readOwnedMarker(seeded.dbPath)).toBe(MARKER_TITLE);
  }, 40_000);

  it("fails closed when an existing sidecar cannot be repaired and retains the main file", async () => {
    const seeded = seedDeniedDb("open-wb-sidecar-fail-");
    const walPath = `${seeded.dbPath}-wal`;
    writeFileSync(walPath, "");
    chmodSync(walPath, 0o644);
    await startDeniedPreparation(compiled, seeded, [walPath], "deny-wal.cjs");
    expect(existsSync(walPath)).toBe(true);
    expect(readOwnedMarker(seeded.dbPath)).toBe(MARKER_TITLE);
  }, 40_000);

  it.each([
    ["main", true],
    ["WAL sidecar", false],
  ] as const)(
    "fails closed when an existing %s path is a directory and leaves it unchanged",
    async (_name, mainIsDirectory) => {
      const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-db-dirs-"));
      scratch.push(scratchRoot);
      const dbParent = join(scratchRoot, "db");
      mkdirSync(dbParent, { recursive: true });
      const dbPath = join(dbParent, "dev.db");
      const walPath = `${dbPath}-wal`;
      const target = mainIsDirectory ? dbPath : walPath;
      if (!mainIsDirectory) {
        seedOwnedMarker(dbPath);
      }
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "keep.txt"), mainIsDirectory ? "main-keep" : "wal-keep");
      chmodSync(target, EXISTING_DIR_MODE);
      const port = await reserveWildcardPort();
      const server = startCompiledServer(
        compiled.entry,
        compiledFixtureEnv(scratchRoot, port, join(scratchRoot, "bin", "omp"), { MODEL_ID }),
      );
      await expectGenericStartupFailure(server, port);
      expect(existsSync(join(scratchRoot, "state"))).toBe(false);
      expect(existsSync(join(scratchRoot, "sandbox"))).toBe(false);
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(lstatSync(target).mode & 0o7777).toBe(EXISTING_DIR_MODE);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe(
        mainIsDirectory ? "main-keep" : "wal-keep",
      );
      if (!mainIsDirectory) {
        expect(lstatSync(dbPath).isFile()).toBe(true);
        expect(lstatSync(dbPath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
      }
    },
    40_000,
  );

  it("repairs a wx-created 0000 main to 0600 under a child-only umask 0777", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-umask-child-"));
    scratch.push(scratchRoot);
    const dbParent = join(scratchRoot, "db");
    mkdirSync(dbParent, { recursive: true });
    chmodSync(dbParent, EXISTING_DIR_MODE);
    const dbPath = join(dbParent, "dev.db");
    const logs = join(scratchRoot, "logs");
    mkdirSync(logs);
    chmodSync(logs, EXISTING_DIR_MODE);
    const modeLog = join(logs, "modes.jsonl");
    const umaskLog = join(logs, "umask.txt");
    writeFileSync(modeLog, "");
    writeFileSync(umaskLog, "");
    chmodSync(modeLog, 0o644);
    chmodSync(umaskLog, 0o644);
    const hookPath = join(scratchRoot, "child-umask.cjs");
    writeFileSync(hookPath, childUmaskHook());
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(scratchRoot, port, join(scratchRoot, "bin", "omp"), {
        MODEL_ID,
        MODE_LOG: modeLog,
        UMASK_LOG: umaskLog,
      }),
      { requireHook: hookPath },
    );
    try {
      await server.waitForStarted();
      const observations = readModeObservations(modeLog);
      const firstOpen = observations[0];
      if (firstOpen === undefined) {
        throw new Error("openDb was not observed");
      }
      expect(firstOpen.path).toBe(dbPath);
      expect(firstOpen.main).toBe(PRIVATE_FILE_MODE);
      expectLivePrivateFiles(dbPath);
      expect(lstatSync(dbParent).mode & 0o7777).toBe(EXISTING_DIR_MODE);
      expect(Number.parseInt(readFileSync(umaskLog, "utf8").trim(), 8)).toBe(0o777);
    } finally {
      await server.dispose();
    }
  }, 40_000);
});

describe("production entry forwards OMP_USER to the captured spawn", () => {
  it.each([undefined, "omp"] as const)(
    "captures the %s prompt spawn without invoking sudo",
    async (ompUser) => {
      const compiled = await compileServerEntry();
      const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-omp-forward-"));
      scratch.push(scratchRoot);
      const tracePath = join(scratchRoot, "spawn.jsonl");
      const hookPath = join(scratchRoot, "capture-spawn.mjs");
      writeFileSync(hookPath, captureSpawnHook());
      const port = await reserveWildcardPort();
      const bin = join(scratchRoot, "bin", "omp");
      const forwardedTmpdir = "/tmp/workbuddy compiled:forward $;";
      const server = startCompiledServer(
        compiled.entry,
        compiledFixtureEnv(scratchRoot, port, bin, {
          PATH: "/usr/bin:/bin",
          TMPDIR: forwardedTmpdir,
          ...(ompUser === undefined ? {} : { OMP_USER: ompUser }),
          PROBE_TRACE: tracePath,
        }),
        { requireHook: hookPath },
      );
      try {
        await server.waitForStarted();
        const cookie = await login(port);
        const session = await createSession(port, cookie);
        await expectPromptStatus(port, cookie, session, "forward", 502);
        const calls = readFileSync(tracePath, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { command: string; args: string[] });
        expect(calls).toHaveLength(1);
        const call = calls[0];
        if (call === undefined) {
          throw new Error("compiled prompt did not spawn");
        }
        expect(call.command).toBe(ompUser === undefined ? bin : "sudo");
        if (ompUser !== undefined) {
          const prefix = sudoPrefix(ompUser, bin, forwardedTmpdir);
          expect(call.args.slice(0, prefix.length)).toEqual(prefix);
        }
      } finally {
        await server.dispose();
      }
    },
    90_000,
  );
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
  return expectPromptStatus(port, cookie, session, message, 202);
}

function expectPromptStatus(
  port: number,
  cookie: string,
  session: string,
  message: string,
  status: number,
): Promise<void> {
  return requestJson(port, "POST", `/api/sessions/${session}/prompt`, cookie, { message }).then(
    (response) => {
      if (response.status !== status) {
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

function captureSpawnHook(): string {
  return `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const nativeSpawn = cp.spawn;
cp.spawn = function capture(command, args, options) {
  if (command === 'sudo' || command === process.env.OMP_BIN) {
    appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ command, args }) + '\\n');
    return nativeSpawn(process.execPath, ['-e', 'process.exit(7)'], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      shell: false,
    });
  }
  return nativeSpawn(command, args, options);
};
syncBuiltinESMExports();
`;
}

function readModeObservations(path: string): Array<{
  path: string;
  main: number | null;
  wal: number | null;
  shm: number | null;
}> {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          path: string;
          main: number | null;
          wal: number | null;
          shm: number | null;
        },
    );
}

function expectLivePrivateFiles(dbPath: string): void {
  expect(lstatSync(dbPath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  const wal = `${dbPath}-wal`;
  const shm = `${dbPath}-shm`;
  if (existsSync(wal)) {
    expect(lstatSync(wal).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  }
  if (existsSync(shm)) {
    expect(lstatSync(shm).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  }
}

function seedOwnedMarker(dbPath: string): void {
  withOpenDb(dbPath, (db) => {
    db.prepare(
      "INSERT INTO chat_sessions(id, owner_id, title, status, stream_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "u1", MARKER_TITLE, "idle", 0, 1, 1);
  });
}

function readOwnedMarker(dbPath: string): string {
  return withOpenDb(dbPath, (db) => {
    const row = db
      .prepare("SELECT title FROM chat_sessions WHERE id = ?")
      .get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as { title?: unknown } | undefined;
    if (row === undefined || typeof row.title !== "string") {
      throw new Error("owned marker is missing");
    }
    return row.title;
  });
}

function expectApplicationStderr(stderr: string): void {
  const applicationStderr = stderr
    .replace(/^\(node:\d+\) /u, "")
    .replace(SQLITE_EXPERIMENTAL_WARNING, "");
  expect(applicationStderr).toBe(`${JSON.stringify({ event: "server_start_failed" })}\n`);
}

async function expectGenericStartupFailure(server: StartedServer, port: number): Promise<void> {
  const closed = await server.waitForClose();
  expect(closed.code).toBe(1);
  expect(closed.signal).toBeNull();
  expect(server.stdout()).toBe("");
  expectApplicationStderr(server.stderr());
  await expectRefused("127.0.0.1", port);
}

function seedDeniedDb(prefix: string): { scratchRoot: string; dbPath: string } {
  const scratchRoot = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(scratchRoot);
  const dbPath = join(scratchRoot, "db", "dev.db");
  mkdirSync(join(scratchRoot, "db"), { recursive: true });
  seedOwnedMarker(dbPath);
  return { scratchRoot, dbPath };
}

async function startDeniedPreparation(
  compiled: CompiledServerEntry,
  seeded: { scratchRoot: string; dbPath: string },
  denied: string[],
  hookName: string,
): Promise<void> {
  const hookPath = join(seeded.scratchRoot, hookName);
  writeFileSync(hookPath, denyChmodHook(denied));
  const port = await reserveWildcardPort();
  const server = startCompiledServer(
    compiled.entry,
    compiledFixtureEnv(seeded.scratchRoot, port, join(seeded.scratchRoot, "bin", "omp"), {
      MODEL_ID,
    }),
    { requireHook: hookPath },
  );
  await expectGenericStartupFailure(server, port);
  expect(existsSync(join(seeded.scratchRoot, "state"))).toBe(false);
}

function compiledFixtureEnv(
  scratchRoot: string,
  port: number,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    PORT: String(port),
    DB_PATH: join(scratchRoot, "db", "dev.db"),
    OMP_STATE_DIR: join(scratchRoot, "state"),
    SANDBOX_ROOT: join(scratchRoot, "sandbox"),
    OMP_BIN: bin,
    ...extra,
  };
}
