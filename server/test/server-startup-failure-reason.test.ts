/**
 * Issue #1203: the startup failure record names the stage startup failed in — a closed enum of
 * source literals, never anything read from the error. Every case runs the real compiled entry.
 * Expected lines are the spec's bytes (http-service-skeleton「启动失败记录带失败阶段」).
 */
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
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";
import {
  expectDbReopens,
  expectLayoutWithoutManagedFiles,
} from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
const PATH_SENTINEL = "PATHSENTINEL1203zq";
const UPSTREAM_SENTINEL = "upstream-api-key-sentinel-startup-failure";
const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
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

/**
 * Starts the entry on a port of the helper's choosing — a listen-class failure there is a lost race
 * for the port (#1273), so it is retried on another one — and runs it to its own exit. `extra` as a
 * function is evaluated once per attempt: an explicit PREVIEW_PORT has to be taken anew each time.
 * The root is reused across attempts because the callers seed the obstacle into it beforehand.
 */
async function failStartup(
  root: string,
  extra: Record<string, string> | (() => Promise<Record<string, string>>) = {},
  requireHook?: string,
): Promise<Failure> {
  const { server, port } = await startCompiledServerWithRetry(compiled.entry, async (port) => ({
    env: compiledFixtureEnv(
      root,
      port,
      join(root, "bin", "omp"),
      typeof extra === "function" ? await extra() : extra,
    ),
    ...(requireHook === undefined ? {} : { requireHook }),
  }));
  return failedExit(root, port, server);
}

/** Runs the entry to its own exit and requires exit code 1 with nothing on stdout. */
async function failedExit(root: string, port: number, server: StartedServer): Promise<Failure> {
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

/**
 * The entry with a stdout it cannot write: a descriptor opened read-only (write fails EBADF).
 * Started through the retrying helper, so a port lost to another process before the entry's own
 * listen is retried instead of surfacing as `listen` (#1273, the shape of the #1337 false red).
 */
async function failWithUnwritableStdout(root: string): Promise<{ stderr: string; port: number }> {
  const sink = join(root, "stdout-sink");
  writeFileSync(sink, "");
  const fd = openSync(sink, "r");
  const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
    env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {}),
    stdout: fd,
  })).catch((error: unknown) => {
    closeSync(fd);
    throw error;
  });
  try {
    const closed = await server.waitForClose();
    expect(closed).toEqual({ code: 1, signal: null });
    return { stderr: server.stderr(), port };
  } finally {
    await server.dispose();
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
    // Not on the retrying helper: this case takes the port on purpose; `listen` is the expected result.
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

  it("preview_listen: the preview port is already taken", async () => {
    const root = scratchRoot();
    // Not on the retrying helper: this case takes the preview port on purpose; `preview_listen` is
    // the expected result. Both ports are reserved the old way.
    const previewPort = await reserveWildcardPort();
    const holder = await listenOn(previewPort);
    let failure: Failure;
    try {
      const port = await reserveWildcardPort();
      const server = startCompiledServer(
        compiled.entry,
        compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
          PREVIEW_PORT: String(previewPort),
        }),
      );
      failure = await failedExit(root, port, server);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
    expectReason(failure.stderr, "preview_listen");
    expect(existsSync(join(root, "db", "dev.db"))).toBe(true);
    // 托管布局在主绑定成功之后、预览绑定之前建立（#1337）：目录在，两个托管文件没有写出。
    expectLayoutWithoutManagedFiles(join(root, "state"));
    expect(existsSync(join(root, "preview-cache"))).toBe(false);
    // 主监听器先绑定成功（#1337），随预览绑定失败的清理关闭：PORT 与 DB 立即可由后继进程复用。
    await expectBindable("127.0.0.1", failure.port);
    expectDbReopens(join(root, "db", "dev.db"));
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

  it("preview_cache: the preview cache location is a file", async () => {
    const root = scratchRoot();
    writeFileSync(join(root, "preview-cache"), "not-a-directory");
    // The preview listener binds before the cache is prepared: its port is taken anew per attempt.
    let previewPort = 0;
    const failure = await failStartup(root, async () => {
      previewPort = await reserveWildcardPort();
      return { PREVIEW_PORT: String(previewPort) };
    });
    expectReason(failure.stderr, "preview_cache");
    const agentDir = join(root, "state", "home", ".omp", "agent");
    expect(existsSync(join(agentDir, "host-overlay.yml"))).toBe(true);
    await expectBindable("127.0.0.1", failure.port);
    await expectBindable("127.0.0.1", previewPort);
  }, 60_000);

  it("publish: the stdout sink fails after listen", async () => {
    const root = scratchRoot();
    const { stderr, port } = await failWithUnwritableStdout(root);
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
    await expectBindable("127.0.0.1", failure.port);
  }, 60_000);
});

/**
 * Issue #909 (http-service-skeleton「非法上游密钥拒绝启动」): an upstream key the proxy could not
 * send as `authorization: Bearer <key>` stops startup at `config`. A key holding U+0000 cannot
 * reach this entry at all: `spawn` refuses such an env value (ERR_INVALID_ARG_VALUE) and an
 * assignment to `process.env` is cut at the NUL, so that input is covered by `server-config.test.ts`.
 */
describe("an upstream key that is not a valid HTTP header value (#909)", () => {
  const KEY_SENTINEL = "KEYSENTINEL909";

  it.each([
    ["U+000A", `k\n${KEY_SENTINEL}`],
    ["non-Latin-1", `密钥${KEY_SENTINEL}`],
  ])(
    "%s: config fails before any effect and no output carries the key",
    async (_label, key) => {
      const failure = await failStartup(scratchRoot(), { MODEL_UPSTREAM_API_KEY: key });
      expect(failure.stdout + failure.stderr).not.toContain(KEY_SENTINEL);
      expectReason(failure.stderr, "config");
      for (const effect of ["db", "state", "sandbox", "preview-cache"]) {
        expect(existsSync(join(failure.root, effect)), effect).toBe(false);
      }
      await expectBindable("127.0.0.1", failure.port);
    },
    60_000,
  );

  it("`abc def` (a space inside) starts normally", async () => {
    const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => {
      const root = scratchRoot();
      return {
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
          MODEL_UPSTREAM_API_KEY: "abc def",
        }),
      };
    });
    try {
      await server.waitForStarted();
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
