/**
 * 真实 compiled production 入口：OMP_USER。
 * 合法值原样转发到被捕获的 spawn；非法值在任何启动副作用之前以一条通用记录退出。
 * 自 server-startup-order.test.ts 原样拆出。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureSpawnHook,
  compiledFixtureEnv,
  compileServerEntry,
  createSession,
  expectPromptStatus,
  login,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import {
  expectNeverListened,
  SQLITE_EXPERIMENTAL_WARNING,
  startListenTraced,
} from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";
import { sudoPrefix } from "./session-supervisor-helpers.js";

const scratch: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production entry forwards OMP_USER to the captured spawn", () => {
  it.each([undefined, "omp"] as const)(
    "captures the %s prompt spawn without invoking sudo",
    async (ompUser) => {
      const compiled = await compileServerEntry();
      const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-omp-forward-"));
      scratch.push(scratchRoot);
      const tracePath = join(scratchRoot, "spawn.jsonl");
      const hookPath = join(scratchRoot, "capture-spawn.cjs");
      writeFileSync(hookPath, captureSpawnHook("present"));
      const bin = join(scratchRoot, "bin", "omp");
      const forwardedTmpdir = "/tmp/workbuddy compiled:forward $;";
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(scratchRoot, port, bin, {
          PATH: "/usr/bin:/bin",
          TMPDIR: forwardedTmpdir,
          ...(ompUser === undefined ? {} : { OMP_USER: ompUser }),
          PROBE_TRACE: tracePath,
        }),
        requireHook: hookPath,
      }));
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
    ["empty", "", undefined],
    ["uppercase", "Omp", undefined],
    ["space", "omp user", undefined],
    ["semicolon", "root;id", undefined],
    ["valid user without /usr/bin/setpriv", "omp", "ENOENT"],
  ] as const)(
    "rejects %s with one generic record and no startup effects",
    async (_name, user, setpriv) => {
      const compiled = await compileServerEntry();
      const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-omp-user-"));
      scratch.push(scratchRoot);
      const hookPath = join(scratchRoot, "missing-setpriv.cjs");
      if (setpriv !== undefined) {
        writeFileSync(hookPath, captureSpawnHook(setpriv));
      }
      const dbParent = join(scratchRoot, "db");
      const state = join(scratchRoot, "state");
      const sandbox = join(scratchRoot, "sandbox");
      const started = await startListenTraced(compiled.entry, scratchRoot, (port) => ({
        env: {
          HOST: "127.0.0.1",
          PORT: String(port),
          DB_PATH: join(dbParent, "dev.db"),
          OMP_STATE_DIR: state,
          SANDBOX_ROOT: sandbox,
          OMP_BIN: join(scratchRoot, "bin", "omp"),
          OMP_USER: user,
          PATH: "/usr/bin:/bin",
        },
        ...(setpriv === undefined ? {} : { requireHook: hookPath }),
      }));
      const { server } = started;
      const closed = await server.waitForClose();
      expect(closed.code).toBe(1);
      expect(closed.signal).toBeNull();
      expect(server.stdout()).toBe("");
      const applicationStderr = server
        .stderr()
        .replace(/^\(node:\d+\) /u, "")
        .replace(SQLITE_EXPERIMENTAL_WARNING, "");
      expect(applicationStderr).toBe(
        `${JSON.stringify({ event: "server_start_failed", reason: "config" })}\n`,
      );
      expect(existsSync(dbParent)).toBe(false);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(join(scratchRoot, "bin"))).toBe(false);
      expectNeverListened(started);
    },
    90_000,
  );
});
