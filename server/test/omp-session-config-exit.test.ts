/**
 * s1d-experts-skills group 1 (issue #1656): omp-runtime「子进程 spawn 契约」scenario「子进程结束后会话
 * 配置文件被删除」on real fake-omp children. A session process with an expert ends by idle reap,
 * shutdown, SIGKILL and a non-zero exit before the handshake; a fork's temporary process ends after
 * `branch`; a spawn of a missing OMP_BIN reports only `error` / `close`. Each one's `<key>.yml` and
 * `<key>.md` are gone once its exit was observed, while a bystander session's files stay byte-equal.
 * The file paths are read from each spawn's own argv (the second `--config`, `--append-system-prompt`).
 *
 * s1d-experts-skills-followups group 1 (issue #1722): scenario「会话配置文件删除失败只报告一次」. The
 * removal failure is injected at the file-system boundary (`node:fs` `rmSync` of a session config
 * path throws EACCES); the oracle is the runtime's removal-failure callback and `process.emitWarning`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OmpExit, OmpProcess, type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import { SessionRuntime, type SessionRuntimeOpts } from "../src/sessions/omp/runtime.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { REAL } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import {
  FIRST,
  forkWorlds,
  messagesOf,
  openForkWorld,
  realSource,
  turn,
} from "./session-fork-helpers.js";
import { QUESTION } from "./session-regenerate-helpers.js";
import { isLive, presetSessionFile } from "./session-supervisor-pool-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";
import { collectPrompt, createClock } from "./support/omp-runtime.js";
import { failSessionConfigRemovals } from "./support/session-config.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const OWNER = "u1";
const EXPERT = {
  disabledExtensions: ["skill:deploy"],
  appendSystemPrompt: "你是一位数据分析师。\n先给结论。",
};
const IDLE_MS = 1_000;

const temps: string[] = [];
const runtimes: SessionRuntime[] = [];
const worlds = forkWorlds();

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const runtime of runtimes.splice(0)) {
    await runtime.shutdown();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The session config files a spawn named in its argv: the second `--config` and the prompt file. */
function configFiles(args: readonly string[]): string[] {
  const configs = args.flatMap((arg, at) => (arg === "--config" ? [String(args[at + 1])] : []));
  const prompt = args.indexOf("--append-system-prompt");
  return [configs[1] ?? "", ...(prompt === -1 ? [] : [String(args[prompt + 1])])];
}

function bytesOf(paths: readonly string[]): string[] {
  return paths.map((path) => readFileSync(path, "utf8"));
}

interface Live {
  runtime: SessionRuntime;
  exited: Promise<OmpExit>;
  /** The first child's `close`, which Node emits after its `exit`. */
  closed: Promise<void>;
  spawned: Array<{ args: string[]; child: ChildProcessWithoutNullStreams }>;
}

function roots(): { sandboxRoot: string; stateDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-session-config-exit-")));
  temps.push(root);
  return { sandboxRoot: join(root, "sandbox"), stateDir: join(root, "state") };
}

/** A SessionRuntime over real fake-omp with the expert capabilities; `extra` is appended to argv. */
function openLive(
  dirs: { sandboxRoot: string; stateDir: string },
  sessionId: string,
  extra: readonly string[] = [],
  options: Partial<SessionRuntimeOpts> = {},
): Live {
  const spawned: Live["spawned"] = [];
  let settle: (exit: OmpExit) => void = () => {};
  const exited = new Promise<OmpExit>((resolve) => {
    settle = resolve;
  });
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    const child = spawn(
      command,
      [...args, ...extra],
      spawnOptions,
    ) as ChildProcessWithoutNullStreams;
    spawned.push({ args: [...args], child });
    child.once("close", () => markClosed());
    return child;
  };
  const runtime = new SessionRuntime({
    sessionId,
    bin: FAKE,
    ...dirs,
    ownerId: OWNER,
    cwd: join(dirs.sandboxRoot, OWNER),
    modelId: "deepseek-v4.1-flash",
    approvalMode: "write",
    tokens: new TokenRegistry(),
    capabilities: EXPERT,
    spawnImpl,
    onExit: (exit) => settle(exit),
    ...options,
  });
  runtimes.push(runtime);
  return { runtime, exited, closed, spawned };
}

function filesOf(live: Live): string[] {
  const first = live.spawned[0];
  if (first === undefined) {
    throw new Error("no spawn");
  }
  return configFiles(first.args);
}

describe("session config files end with their process", () => {
  it(
    "are gone after idle reap, shutdown, SIGKILL and a pre-handshake exit; a bystander's stay",
    REAL,
    async () => {
      const dirs = roots();
      const bystander = openLive(dirs, "bystander");
      await collectPrompt(bystander.runtime.prompt("hello"));
      const kept = filesOf(bystander);
      expect(kept).toHaveLength(2);
      const keptBytes = bytesOf(kept);
      expect(keptBytes).toEqual([
        'disabledExtensions: ["skill:deploy"]\n',
        EXPERT.appendSystemPrompt,
      ]);

      const clock = createClock();
      const idle = openLive(dirs, "idle", [], { clock, idleMs: IDLE_MS });
      await collectPrompt(idle.runtime.prompt("hello"));
      const idleFiles = filesOf(idle);
      expect(idleFiles.map((path) => existsSync(path))).toEqual([true, true]);
      clock.advance(IDLE_MS);
      await idle.exited;
      expect(idleFiles.map((path) => existsSync(path))).toEqual([false, false]);

      const stopped = openLive(dirs, "stopped");
      await collectPrompt(stopped.runtime.prompt("hello"));
      await stopped.runtime.shutdown();
      await stopped.exited;
      expect(filesOf(stopped).map((path) => existsSync(path))).toEqual([false, false]);

      const killed = openLive(dirs, "killed");
      await collectPrompt(killed.runtime.prompt("hello"));
      killed.spawned[0]?.child.kill("SIGKILL");
      expect((await killed.exited).signal).toBe("SIGKILL");
      expect(filesOf(killed).map((path) => existsSync(path))).toEqual([false, false]);

      // An invalid `--ready-delay-ms` makes fake-omp exit 1 with zero frames.
      const failed = openLive(dirs, "failed", [
        "--scenario",
        "slow-ready",
        "--ready-delay-ms",
        "x",
      ]);
      await expect(collectPrompt(failed.runtime.prompt("hello"))).rejects.toThrow();
      expect((await failed.exited).code).toBe(1);
      expect(filesOf(failed).map((path) => existsSync(path))).toEqual([false, false]);

      expect(isLive(bystander.spawned[0]?.child as ChildProcessWithoutNullStreams)).toBe(true);
      expect(bytesOf(kept)).toEqual(keptBytes);
    },
  );

  it(
    "are gone after a spawn that reports only error and close (OMP_BIN missing)",
    REAL,
    async () => {
      const dirs = roots();
      const seen: string[][] = [];
      const proc = new OmpProcess({
        bin: join(dirs.sandboxRoot, "missing-omp"),
        ...dirs,
        ownerId: OWNER,
        cwd: join(dirs.sandboxRoot, OWNER),
        modelId: "deepseek-v4.1-flash",
        approvalMode: "write",
        token: "a".repeat(64),
        resumePath: null,
        capabilities: EXPERT,
        spawnImpl: (command, args, options) => {
          seen.push([...args]);
          return spawn(command, args, options) as ChildProcessWithoutNullStreams;
        },
      });
      const exited = new Promise<OmpExit>((resolve) => proc.on("exit", resolve));

      await expect(proc.start()).rejects.toThrow();
      await exited;

      const files = configFiles(seen[0] ?? []);
      expect(files).toHaveLength(2);
      expect(files.map((path) => existsSync(path))).toEqual([false, false]);
    },
  );
});

describe("a fork's temporary process", () => {
  it(
    "runs with the source session's (empty) capabilities and its file is gone after branch",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { db } = world.fixture;
      const spawns: Array<{ files: string[]; bytes: string[] }> = [];
      const inner = world.rt.runtime.spawnImpl;
      if (inner === undefined) {
        throw new Error("no spawnImpl");
      }
      world.rt.runtime.spawnImpl = (command, args, options) => {
        const files = configFiles(args);
        spawns.push({ files, bytes: bytesOf(files) });
        return inner(command, args, options);
      };
      await turn(world, FIRST);
      await turn(world, QUESTION);
      const u2 = messagesOf(db, world.session)[2];
      presetSessionFile(db, world.session, realSource().file);

      const response = await postSessionAction(
        world.fixture.app,
        "fork",
        world.session,
        world.cookie,
        {
          name: "fork",
          payload: JSON.stringify({ messageId: u2?.id }),
          contentType: "application/json",
        },
      );

      expect(response.statusCode).toBe(201);
      const [source, temp] = spawns;
      expect(spawns).toHaveLength(2);
      // Group 1: every spawn path passes no expert and nothing disabled.
      expect(temp?.files).toHaveLength(1);
      expect(temp?.bytes).toEqual(["disabledExtensions: []\n"]);
      expect(temp?.files.map((path) => existsSync(path))).toEqual([false]);
      // Fork retires the source's process before the temporary one spawns: its file went with it.
      expect(world.liveAtSpawn[1]).toEqual([]);
      expect(source?.bytes).toEqual(["disabledExtensions: []\n"]);
      expect(source?.files.map((path) => existsSync(path))).toEqual([false]);
    },
  );
});

describe("a session config file that cannot be removed (#1722)", () => {
  it(
    "with an expert and both files failing, exit then close report each file once; the exit is published",
    REAL,
    async () => {
      const dirs = roots();
      const reports: Error[] = [];
      const warned = vi.spyOn(process, "emitWarning");
      const live = openLive(dirs, "both", [], {
        onSessionConfigError: (error) => {
          reports.push(error);
        },
      });
      await collectPrompt(live.runtime.prompt("hello"));
      const files = filesOf(live);
      expect(files).toHaveLength(2);
      failSessionConfigRemovals(["yml", "md"]);

      await live.runtime.shutdown();
      const exit = await live.exited;
      await live.closed;

      expect(exit).toEqual({ code: 0, signal: null });
      expect({
        reports: reports.length,
        warnings: warned.mock.calls.map((call) => String(call[0])),
      }).toEqual({ reports: 2, warnings: [] });
      expect(
        reports.map((error) => [error instanceof Error, (error as { code?: string }).code]),
      ).toEqual([
        [true, "EACCES"],
        [true, "EACCES"],
      ]);
      // The failure was real: both files are still there, and nothing else retried them.
      expect(files.map((path) => existsSync(path))).toEqual([true, true]);
    },
  );

  it(
    "with only the .yml failing, exit then close report exactly once and the .md is gone",
    REAL,
    async () => {
      const dirs = roots();
      const reports: Error[] = [];
      const live = openLive(dirs, "yml-only", [], {
        onSessionConfigError: (error) => {
          reports.push(error);
        },
      });
      await collectPrompt(live.runtime.prompt("hello"));
      const files = filesOf(live);
      failSessionConfigRemovals(["yml"]);

      await live.runtime.shutdown();
      await live.exited;
      await live.closed;

      expect(reports).toHaveLength(1);
      expect(files.map((path) => existsSync(path))).toEqual([true, false]);
    },
  );

  it(
    "a throwing callback interrupts neither the other file's attempt nor the exit",
    REAL,
    async () => {
      const dirs = roots();
      let calls = 0;
      const live = openLive(dirs, "throwing", [], {
        onSessionConfigError: () => {
          calls += 1;
          throw new Error("report sink down");
        },
      });
      await collectPrompt(live.runtime.prompt("hello"));
      failSessionConfigRemovals(["yml", "md"]);

      live.spawned[0]?.child.kill("SIGKILL");
      const exit = await live.exited;
      await live.closed;

      expect(exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(calls).toBe(2);
      // The runtime's exit handling finished: the next prompt spawns afresh.
      await collectPrompt(live.runtime.prompt("again"));
      expect(live.spawned).toHaveLength(2);
    },
  );

  it("a synchronously failing spawn reports each file once, and a later exit and close add nothing", async () => {
    const dirs = roots();
    const reports: Error[] = [];
    const stray = new FakeChild();
    const proc = new OmpProcess({
      bin: FAKE,
      ...dirs,
      ownerId: OWNER,
      cwd: join(dirs.sandboxRoot, OWNER),
      modelId: "deepseek-v4.1-flash",
      approvalMode: "write",
      token: "a".repeat(64),
      resumePath: null,
      capabilities: EXPERT,
      onSessionConfigError: (error) => {
        reports.push(error);
      },
      spawnImpl: (command, args, options) => {
        stray.spawnImpl(command, args, options);
        throw new Error("spawn EAGAIN");
      },
    });
    failSessionConfigRemovals(["yml", "md"]);

    await expect(proc.start()).rejects.toThrow("spawn failed");
    expect(reports).toHaveLength(2);

    stray.exit(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reports).toHaveLength(2);
  });

  it("a throwing callback on a synchronously failing spawn leaves the spawn error as the rejection", async () => {
    const dirs = roots();
    let calls = 0;
    failSessionConfigRemovals(["yml", "md"]);

    await expect(
      spawnOmp(
        {
          bin: FAKE,
          ...dirs,
          ownerId: OWNER,
          cwd: join(dirs.sandboxRoot, OWNER),
          modelId: "deepseek-v4.1-flash",
          approvalMode: "write",
          token: "a".repeat(64),
          resumePath: null,
          capabilities: EXPERT,
          onSessionConfigError: () => {
            calls += 1;
            throw new Error("report sink down");
          },
        },
        () => {
          throw new Error("spawn EAGAIN");
        },
      ),
    ).rejects.toThrow("spawn EAGAIN");
    expect(calls).toBe(2);
  });
});
