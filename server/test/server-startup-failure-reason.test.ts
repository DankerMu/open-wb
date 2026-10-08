/**
 * Issue #1203: the startup failure record names the stage startup failed in — a closed enum of
 * source literals, never anything read from the error. Every case runs the real compiled entry.
 * Expected lines are the spec's bytes (http-service-skeleton「启动失败记录带失败阶段」).
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  expectBindable,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";

const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
const PATH_SENTINEL = "PATHSENTINEL1203zq";
const UPSTREAM_SENTINEL = "upstream-api-key-sentinel-startup-failure";
const scratch: string[] = [];
const children = new Set<ChildProcess>();
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Failure {
  root: string;
  port: number;
  stdout: string;
  stderr: string;
}

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "open-wb-fail-reason-"));
  scratch.push(root);
  return root;
}

/** Runs the entry to its own exit and requires exit code 1 with nothing on stdout. */
async function failStartup(
  root: string,
  extra: Record<string, string> = {},
  requireHook?: string,
): Promise<Failure> {
  const port = await reserveWildcardPort();
  const server = startCompiledServer(
    compiled.entry,
    compiledFixtureEnv(root, port, join(root, "bin", "omp"), extra),
    requireHook === undefined ? {} : { requireHook },
  );
  try {
    expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
    expect(server.stdout()).toBe("");
    return { root, port, stdout: server.stdout(), stderr: server.stderr() };
  } finally {
    await server.dispose();
  }
}

/** The whole application stderr is one line whose bytes are exactly the record for `reason`. */
function expectReason(stderr: string, reason: string): void {
  const line = stderr.replace(NODE_SQLITE_WARNING, "");
  expect(line).toBe(`{"event":"server_start_failed","reason":"${reason}"}\n`);
  expect(Object.keys(JSON.parse(line) as object)).toEqual(["event", "reason"]);
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once("error", reject);
    holder.listen(port, "127.0.0.1", () => resolve(holder));
  });
}

/** The entry with a stdout it cannot write: a descriptor opened read-only (write fails EBADF). */
async function failWithUnwritableStdout(root: string, port: number): Promise<string> {
  const sink = join(root, "stdout-sink");
  writeFileSync(sink, "");
  const fd = openSync(sink, "r");
  const child = spawn(process.execPath, [compiled.entry], {
    stdio: ["ignore", fd, "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      ...compiledFixtureEnv(root, port, join(root, "bin", "omp"), {}),
    },
  });
  children.add(child);
  try {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(closed).toEqual({ code: 1, signal: null });
    return stderr;
  } finally {
    children.delete(child);
    child.kill("SIGKILL");
    closeSync(fd);
  }
}

describe("startup failure record carries the failed stage (#1203)", () => {
  it("config: an invalid PORT fails before any effect", async () => {
    const failure = await failStartup(scratchRoot(), { PORT: "abc" });
    expectReason(failure.stderr, "config");
    expect(existsSync(join(failure.root, "db"))).toBe(false);
    expect(existsSync(join(failure.root, "state"))).toBe(false);
  }, 60_000);

  it("db: the DB parent location is a file", async () => {
    const root = scratchRoot();
    writeFileSync(join(root, "db"), "not-a-directory");
    const failure = await failStartup(root);
    expectReason(failure.stderr, "db");
    expect(existsSync(join(root, "state"))).toBe(false);
  }, 60_000);

  it("app: assembling the application throws (injected: createApp's static-root resolve)", async () => {
    // createApp has no failure reachable from configuration alone, so a preload makes the one
    // path.resolve call it performs on STATIC_ROOT throw. Everything else is the real entry.
    const root = scratchRoot();
    const staticRoot = join(root, "static");
    const marker = join(root, "app-hook-fired");
    const hook = join(root, "fail-create-app.cjs");
    writeFileSync(
      hook,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const { syncBuiltinESMExports } = require('node:module');",
        "const nativeResolve = path.resolve;",
        "path.resolve = function failStaticRoot(...args) {",
        `  if (args.length === 1 && args[0] === ${JSON.stringify(staticRoot)}) {`,
        `    fs.writeFileSync(${JSON.stringify(marker)}, '');`,
        "    throw new Error('injected createApp failure');",
        "  }",
        "  return nativeResolve.apply(this, args);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const failure = await failStartup(root, { STATIC_ROOT: staticRoot }, hook);
    expectReason(failure.stderr, "app");
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(join(root, "db", "dev.db"))).toBe(true);
    expect(existsSync(join(root, "state"))).toBe(false);
  }, 60_000);

  it("listen: the port is already taken", async () => {
    const root = scratchRoot();
    const port = await reserveWildcardPort();
    const holder = await listenOn(port);
    try {
      const server = startCompiledServer(
        compiled.entry,
        compiledFixtureEnv(root, port, join(root, "bin", "omp"), {}),
      );
      try {
        expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
        expect(server.stdout()).toBe("");
        expectReason(server.stderr(), "listen");
      } finally {
        await server.dispose();
      }
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
    expect(existsSync(join(root, "db", "dev.db"))).toBe(true);
    expect(existsSync(join(root, "state"))).toBe(false);
  }, 60_000);

  it("state_layout: home/.omp is occupied by a file", async () => {
    const root = scratchRoot();
    mkdirSync(join(root, "state", "home"), { recursive: true });
    writeFileSync(join(root, "state", "home", ".omp"), "not-a-directory");
    const failure = await failStartup(root);
    expectReason(failure.stderr, "state_layout");
    await expectBindable("127.0.0.1", failure.port);
  }, 60_000);

  it("models_yml: models.yml is occupied by a directory", async () => {
    const root = scratchRoot();
    const agentDir = join(root, "state", "home", ".omp", "agent");
    mkdirSync(join(agentDir, "models.yml"), { recursive: true });
    const failure = await failStartup(root);
    expectReason(failure.stderr, "models_yml");
    expect(existsSync(join(agentDir, "host-overlay.yml"))).toBe(false);
  }, 60_000);

  it("host_overlay: host-overlay.yml is occupied by a directory", async () => {
    const root = scratchRoot();
    const agentDir = join(root, "state", "home", ".omp", "agent");
    mkdirSync(join(agentDir, "host-overlay.yml"), { recursive: true });
    const failure = await failStartup(root);
    expectReason(failure.stderr, "host_overlay");
    expect(existsSync(join(agentDir, "models.yml"))).toBe(true);
  }, 60_000);

  it("publish: the stdout sink fails after listen", async () => {
    const root = scratchRoot();
    const port = await reserveWildcardPort();
    const stderr = await failWithUnwritableStdout(root, port);
    expectReason(stderr, "publish");
    const agentDir = join(root, "state", "home", ".omp", "agent");
    expect(existsSync(join(agentDir, "models.yml"))).toBe(true);
    expect(existsSync(join(agentDir, "host-overlay.yml"))).toBe(true);
    await expectBindable("127.0.0.1", port);
  }, 60_000);

  it("leaks neither the state path nor the upstream key when the layout check fails", async () => {
    const root = scratchRoot();
    const state = join(root, `state-${PATH_SENTINEL}`);
    mkdirSync(join(state, "home"), { recursive: true });
    writeFileSync(join(state, "home", ".omp"), "not-a-directory");
    const failure = await failStartup(root, {
      OMP_STATE_DIR: state,
      MODEL_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1",
      MODEL_UPSTREAM_API_KEY: UPSTREAM_SENTINEL,
    });
    // Sentinels first: a record that grew an error text must fail here, not only on the line shape.
    const output = failure.stdout + failure.stderr;
    expect(output).not.toContain(PATH_SENTINEL);
    expect(output).not.toContain(UPSTREAM_SENTINEL);
    expect(output).not.toContain(root);
    expectReason(failure.stderr, "state_layout");
  }, 60_000);
});
