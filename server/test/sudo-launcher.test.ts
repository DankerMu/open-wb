/**
 * Issue #351 sudo-mode launcher precondition: canonical config and the spawn boundary
 * require an executable /usr/bin/setpriv when ompUser is present, before side effects.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSetprivExecutable } from "../src/core/process-path.js";
import { resolveServerConfig } from "../src/server.js";
import { type SpawnImpl, type SpawnOmpOpts, spawnOmp } from "../src/sessions/omp/process.js";
import { type SetprivOutcome, type SetprivStub, stubSetpriv } from "./support/setpriv.js";

const SAFE_PATH = "/usr/bin:/bin";
const ENTRY = new URL("../src/server.ts", import.meta.url).href;
const temps: string[] = [];
const stubs: SetprivStub[] = [];
const savedPath = process.env.PATH;

afterEach(() => {
  for (const stub of stubs.splice(0).reverse()) {
    stub.restore();
  }
  process.env.PATH = savedPath;
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function launcher(outcome: SetprivOutcome): SetprivStub {
  const stub = stubSetpriv(outcome);
  stubs.push(stub);
  return stub;
}

function spawnRoots(): { opts: SpawnOmpOpts; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "sudo-launcher-"));
  temps.push(root);
  const sandboxRoot = join(root, "sandbox");
  const stateDir = join(root, "state");
  return {
    opts: {
      bin: join(root, "omp-bin"),
      sandboxRoot,
      stateDir,
      ownerId: "u1",
      modelId: "deepseek-v4.1-flash",
      token: "t".repeat(64),
      resumePath: null,
    },
    cwd: join(sandboxRoot, "u1"),
    home: join(stateDir, "home"),
  };
}

function recordingSpawn(commands: string[]): SpawnImpl {
  return (command) => {
    commands.push(command);
    return {} as ChildProcessWithoutNullStreams;
  };
}

describe("assertSetprivExecutable", () => {
  it("checks exactly /usr/bin/setpriv for X_OK and passes when executable", () => {
    const stub = launcher("present");
    expect(() => assertSetprivExecutable()).not.toThrow();
    expect(stub.calls).toEqual([{ path: "/usr/bin/setpriv", mode: constants.X_OK }]);
  });

  it.each(["ENOENT", "EACCES"] as const)("fails generically when access reports %s", (code) => {
    launcher(code);
    expect(() => assertSetprivExecutable()).toThrow(
      "/usr/bin/setpriv must be executable when OMP_USER is configured",
    );
  });
});

describe("canonical config launcher precondition", () => {
  it.each(["ENOENT", "EACCES"] as const)("rejects OMP_USER when setpriv is %s", (code) => {
    const stub = launcher(code);
    expect(() => resolveServerConfig({ OMP_USER: "omp", PATH: SAFE_PATH }, ENTRY)).toThrow(
      "/usr/bin/setpriv must be executable",
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("accepts OMP_USER with an executable launcher and never checks without OMP_USER", () => {
    const present = launcher("present");
    expect(resolveServerConfig({ OMP_USER: "omp", PATH: SAFE_PATH }, ENTRY).ompUser).toBe("omp");
    expect(present.calls).toHaveLength(1);
    const missing = launcher("ENOENT");
    expect(resolveServerConfig({ PATH: SAFE_PATH }, ENTRY).ompUser).toBeUndefined();
    expect(missing.calls).toHaveLength(0);
  });
});

describe("spawn boundary launcher precondition", () => {
  it.each(["ENOENT", "EACCES"] as const)(
    "rejects a sudo spawn before mkdir and spawn when setpriv is %s",
    async (code) => {
      process.env.PATH = SAFE_PATH;
      const stub = launcher(code);
      const roots = spawnRoots();
      const commands: string[] = [];
      await expect(
        spawnOmp({ ...roots.opts, ompUser: "omp" }, recordingSpawn(commands)),
      ).rejects.toThrow("/usr/bin/setpriv must be executable");
      expect(stub.calls).toHaveLength(1);
      expect(commands).toEqual([]);
      expect(existsSync(roots.cwd)).toBe(false);
      expect(existsSync(roots.home)).toBe(false);
    },
  );

  it("keeps the direct spawn unaffected by a missing launcher", async () => {
    process.env.PATH = SAFE_PATH;
    const stub = launcher("ENOENT");
    const roots = spawnRoots();
    const commands: string[] = [];
    await spawnOmp(roots.opts, recordingSpawn(commands));
    expect(commands).toEqual([roots.opts.bin]);
    expect(stub.calls).toHaveLength(0);
    expect(existsSync(roots.cwd)).toBe(true);
  });
});
