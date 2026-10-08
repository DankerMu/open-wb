/**
 * 真实 compiled production 入口：私有状态权限。
 * DB 主文件与 WAL/SHM 在 open 之前修到 0600；修不了就 fail closed，且保留既有数据。
 * 自 server-startup-order.test.ts 原样拆出。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOpenDb } from "./core-db-helpers.js";
import {
  type CompiledServerEntry,
  childUmaskHook,
  compiledFixtureEnv,
  compileServerEntry,
  denyChmodHook,
  observeOpenDbHook,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";
import { applicationStderr, expectRefused, MODEL_ID } from "./server-startup-order-helpers.js";

const PRIVATE_FILE_MODE = 0o600;
/** 托管布局（#706）：托管配置目录与状态根都是 app 持有、组只读。 */
const MANAGED_DIR_MODE = 0o2750;
const EXISTING_DIR_MODE = 0o755;
const MARKER_TITLE = "owned-state-marker";
const scratch: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
      expect(lstatSync(join(state, "home", ".omp", "agent")).mode & 0o7777).toBe(MANAGED_DIR_MODE);
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
      // The sandbox root keeps its mode; the state root is corrected to the managed layout's.
      expect(lstatSync(existingState).mode & 0o7777).toBe(MANAGED_DIR_MODE);
      expect(lstatSync(existingSandbox).mode & 0o7777).toBe(EXISTING_DIR_MODE);
      expect(lstatSync(join(existingState, "home", ".omp", "agent")).mode & 0o7777).toBe(
        MANAGED_DIR_MODE,
      );
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
      expect(existsSync(join(state, "home", ".omp", "agent", "models.yml"))).toBe(true);
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

/** Every caller fails while the private DB files are prepared: stage `db`. */
function expectApplicationStderr(stderr: string): void {
  const record = { event: "server_start_failed", reason: "db" };
  expect(applicationStderr(stderr)).toBe(`${JSON.stringify(record)}\n`);
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
