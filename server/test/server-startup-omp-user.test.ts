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
  compiledFixtureEnv,
  compileServerEntry,
  createSession,
  expectPromptStatus,
  login,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";
import { expectRefused, SQLITE_EXPERIMENTAL_WARNING } from "./server-startup-order-helpers.js";
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
      const hookPath = join(scratchRoot, "capture-spawn.mjs");
      writeFileSync(hookPath, captureSpawnHook("present"));
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
      const hookPath = join(scratchRoot, "missing-setpriv.mjs");
      if (setpriv !== undefined) {
        writeFileSync(hookPath, captureSpawnHook(setpriv));
      }
      const dbParent = join(scratchRoot, "db");
      const state = join(scratchRoot, "state");
      const sandbox = join(scratchRoot, "sandbox");
      const port = await reserveWildcardPort();
      const server = startCompiledServer(
        compiled.entry,
        {
          HOST: "127.0.0.1",
          PORT: String(port),
          DB_PATH: join(dbParent, "dev.db"),
          OMP_STATE_DIR: state,
          SANDBOX_ROOT: sandbox,
          OMP_BIN: join(scratchRoot, "bin", "omp"),
          OMP_USER: user,
          PATH: "/usr/bin:/bin",
        },
        setpriv === undefined ? {} : { requireHook: hookPath },
      );
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
      await expectRefused("127.0.0.1", port);
    },
    90_000,
  );
});

/** Also replaces fs.accessSync for /usr/bin/setpriv only (Issue #351 launcher precondition). */
function captureSpawnHook(setpriv: "present" | "ENOENT"): string {
  return `import cp from 'node:child_process';
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const nativeAccess = fs.accessSync;
fs.accessSync = function access(path, mode) {
  if (path !== '/usr/bin/setpriv') return nativeAccess.call(this, path, mode);
  if (${JSON.stringify(setpriv)} !== 'present') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
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
