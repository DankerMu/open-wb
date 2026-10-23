/**
 * Issue #1567 (omp-pin-18-12 task 3.2): the repo-root marker at spawn — omp-runtime
 * 「会话工作目录的仓库根标记」, Scenario「spawn 前建出标记」, and the `.git` clauses of「子进程 spawn
 * 契约」 Scenarios「参数与目录」「Effective child boundary」. `spawnOmp` is driven directly with a
 * recording spawnImpl that looks at the disk the moment it is called (the child's boundary), then
 * through `SessionRuntime` for the token oracle of a failed preparation (as omp-spawn-cwd.test.ts
 * does for an invalid approval mode), then through the production createApp assembly over real
 * fake-omp children for the regenerate and fork entries. Expected values are the spec's literals.
 */
import type { SpawnOptions } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentUnavailableError,
  type SpawnImpl,
  type SpawnOmpOpts,
  spawnOmp,
} from "../src/sessions/omp/process.js";
import { markerFs } from "../src/sessions/omp/repo-root-marker.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { REAL, settle } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { FIRST, messagesOf, turn } from "./session-fork-helpers.js";
import {
  openRegenWorld,
  QUESTION,
  type RegenWorld,
  regenWorlds,
  waitDead,
} from "./session-regenerate-helpers.js";
import { IDLE_MS, OWNER_ID, requiredCall, waitForTurn } from "./session-supervisor-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";
import { createTokens } from "./support/omp-runtime.js";
import { EMPTY_CAPABILITIES } from "./support/session-config.js";

const MARKER_MODE = 0o2770;
const IS_ROOT = process.getuid?.() === 0;
const temps: string[] = [];
const worlds = regenWorlds();
const realMkdir = markerFs.mkdirSync;

afterEach(() => {
  markerFs.mkdirSync = realMkdir;
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Roots {
  sandboxRoot: string;
  stateDir: string;
  ownerRoot: string;
  proj: string;
}

interface Recorded {
  args: string[];
  options: SpawnOptions;
  /** `<cwd>/.git` as seen when spawnImpl ran: a directory's mode and entries, else its lstat kind. */
  marker: { mode: number; entries: string[] } | "file" | "link" | null;
}

/** A sandbox with the owner root and its workspace `proj`, each at 0755, no `.git` anywhere. */
function makeRoots(): Roots {
  const root = mkdtempSync(join(tmpdir(), "omp-spawn-marker-"));
  temps.push(root);
  const sandboxRoot = join(root, "sandbox");
  const ownerRoot = join(sandboxRoot, OWNER_ID);
  const proj = join(ownerRoot, "proj");
  mkdirSync(proj, { recursive: true, mode: 0o755 });
  return { sandboxRoot, stateDir: join(root, "state"), ownerRoot, proj };
}

function opts(roots: Roots, cwd: string, resumePath: string | null = null): SpawnOmpOpts {
  return {
    bin: "/nonexistent/omp",
    sandboxRoot: roots.sandboxRoot,
    stateDir: roots.stateDir,
    ownerId: OWNER_ID,
    modelId: "m1",
    approvalMode: "write",
    capabilities: EMPTY_CAPABILITIES,
    token: "t".repeat(64),
    resumePath,
    cwd,
  };
}

function markerSeen(cwd: string): Recorded["marker"] {
  const path = join(cwd, ".git");
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return null;
  }
  if (!stats.isDirectory()) {
    return stats.isSymbolicLink() ? "link" : "file";
  }
  return { mode: stats.mode & 0o7777, entries: readdirSync(path) };
}

/** Records each call with the marker as it stands at that moment; never starts a process. */
function recorder(): { calls: Recorded[]; spawnImpl: SpawnImpl } {
  const calls: Recorded[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push({ args: [...args], options, marker: markerSeen(String(options.cwd)) });
    return new FakeChild().spawnImpl(command, args, options);
  };
  return { calls, spawnImpl };
}

/** Makes the marker's `mkdir` replace the fresh directory with a link to `target`. */
function swapMarkerForLinkTo(target: string): void {
  markerFs.mkdirSync = ((path: string) => {
    realMkdir(path);
    rmdirSync(path);
    symlinkSync(target, path, "dir");
    return undefined;
  }) as typeof markerFs.mkdirSync;
}

const EMPTY_MARKER = { mode: MARKER_MODE, entries: [] };

describe("spawnOmp plants the marker before the child starts", () => {
  it("bound and unbound first spawns find an empty 2770 .git in their cwd; resume spawns leave it as it is", async () => {
    const roots = makeRoots();
    const { calls, spawnImpl } = recorder();

    await spawnOmp(opts(roots, roots.proj), spawnImpl);
    await spawnOmp(opts(roots, roots.ownerRoot), spawnImpl);
    const inodes = [roots.proj, roots.ownerRoot].map((cwd) => lstatSync(join(cwd, ".git")).ino);
    const resumed = join(roots.stateDir, "sessions", OWNER_ID, "prior.jsonl");
    await spawnOmp(opts(roots, roots.proj, resumed), spawnImpl);
    await spawnOmp(opts(roots, roots.ownerRoot, resumed), spawnImpl);

    expect(calls.map((call) => call.options.cwd)).toEqual([
      roots.proj,
      roots.ownerRoot,
      roots.proj,
      roots.ownerRoot,
    ]);
    expect(calls.map((call) => call.marker)).toEqual(Array(4).fill(EMPTY_MARKER));
    expect(calls[2]?.args.slice(-2)).toEqual(["--resume", resumed]);
    for (const [index, cwd] of [roots.proj, roots.ownerRoot].entries()) {
      const stats = lstatSync(join(cwd, ".git"));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.uid).toBe(process.geteuid?.());
      expect(stats.ino).toBe(inodes[index]);
    }
    // The owner root holds its workspace and the marker; the workspace only the marker.
    expect(readdirSync(roots.ownerRoot).sort()).toEqual([".git", "proj"]);
    expect(readdirSync(roots.proj)).toEqual([".git"]);
  });

  it("spawns with an existing real .git, a .git file and a dangling .git link, each left as it was", async () => {
    const roots = makeRoots();
    const real = join(roots.proj, ".git");
    mkdirSync(real, { mode: 0o755 });
    writeFileSync(join(real, "HEAD"), "ref: refs/heads/main\n");
    const fileCwd = join(roots.ownerRoot, "file");
    const linkCwd = join(roots.ownerRoot, "link");
    mkdirSync(fileCwd);
    mkdirSync(linkCwd);
    writeFileSync(join(fileCwd, ".git"), "gitdir: ../x\n");
    symlinkSync(join(roots.ownerRoot, "nowhere"), join(linkCwd, ".git"));
    const { calls, spawnImpl } = recorder();

    for (const cwd of [roots.proj, fileCwd, linkCwd]) {
      await spawnOmp(opts(roots, cwd), spawnImpl);
    }

    expect(calls.map((call) => call.marker)).toEqual([
      { mode: 0o755, entries: ["HEAD"] },
      "file",
      "link",
    ]);
    expect(readFileSync(join(real, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(lstatSync(real).mode & 0o7777).toBe(0o755);
    expect(readFileSync(join(fileCwd, ".git"), "utf8")).toBe("gitdir: ../x\n");
    expect(lstatSync(join(linkCwd, ".git")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(linkCwd, ".git"))).toBe(join(roots.ownerRoot, "nowhere"));
    expect(existsSync(join(roots.ownerRoot, "nowhere"))).toBe(false);
  });

  it("spawns when a concurrent git init wins between lstat and mkdir (EEXIST), changing nothing", async () => {
    const roots = makeRoots();
    markerFs.mkdirSync = ((path: string) => {
      realMkdir(path, { mode: 0o755 });
      chmodSync(path, 0o755);
      writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
      return realMkdir(path);
    }) as typeof markerFs.mkdirSync;
    const { calls, spawnImpl } = recorder();

    await spawnOmp(opts(roots, roots.proj), spawnImpl);

    expect(calls.map((call) => call.marker)).toEqual([{ mode: 0o755, entries: ["HEAD"] }]);
  });
});

describe("a marker that cannot be made fails the acquisition: no spawn, the issued token revoked", () => {
  async function acquire(roots: Roots, cwd: string): Promise<{ error: unknown; calls: number }> {
    const { calls, spawnImpl } = recorder();
    const tokens = createTokens("marker");
    const runtime = new SessionRuntime({
      sessionId: "s-marker",
      bin: "/nonexistent/omp",
      sandboxRoot: roots.sandboxRoot,
      stateDir: roots.stateDir,
      ownerId: OWNER_ID,
      modelId: "m1",
      approvalMode: "write",
      capabilities: EMPTY_CAPABILITIES,
      tokens,
      spawnImpl,
      handshakeTimeoutMs: 60_000,
      cwd,
    });
    const error = await runtime.prompt("hello").dispatched.catch((caught: unknown) => caught);
    await runtime.shutdown();
    expect(tokens.issued).toHaveLength(1);
    expect(tokens.revoked).toEqual(tokens.issued);
    expect(tokens.live.size).toBe(0);
    return { error, calls: calls.length };
  }

  it.skipIf(IS_ROOT)("an unwritable cwd", async () => {
    const roots = makeRoots();
    chmodSync(roots.proj, 0o555);
    let outcome: { error: unknown; calls: number };
    try {
      outcome = await acquire(roots, roots.proj);
    } finally {
      chmodSync(roots.proj, 0o755);
    }

    expect(outcome.error).toBeInstanceOf(AgentUnavailableError);
    expect(outcome.calls).toBe(0);
    expect(readdirSync(roots.proj)).toEqual([]);
  });

  it("a removed workspace root, which is not recreated", async () => {
    const roots = makeRoots();
    rmdirSync(roots.proj);

    const outcome = await acquire(roots, roots.proj);

    expect(outcome.error).toBeInstanceOf(AgentUnavailableError);
    expect(outcome.calls).toBe(0);
    expect(existsSync(roots.proj)).toBe(false);
  });

  it("a .git swapped for a link to another directory between mkdir and the mode change", async () => {
    const roots = makeRoots();
    const target = join(roots.stateDir, "elsewhere");
    mkdirSync(target, { recursive: true, mode: 0o750 });
    chmodSync(target, 0o750);
    swapMarkerForLinkTo(target);

    const outcome = await acquire(roots, roots.proj);

    expect(outcome.error).toBeInstanceOf(AgentUnavailableError);
    expect(outcome.calls).toBe(0);
    expect(lstatSync(target).mode & 0o7777).toBe(0o750);
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("regenerate and fork spawn through the same contract", () => {
  /** A real fake-omp world whose own session is bound to u1's workspace `proj`. */
  async function openBound(): Promise<{ world: RegenWorld; root: string }> {
    const world = worlds.track(await openRegenWorld());
    mkdirSync(world.rt.runtime.sandboxRoot, { recursive: true });
    const created = await world.fixture.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": "application/json", cookie: world.cookie },
      payload: JSON.stringify({ name: "proj", dir: "proj" }),
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json() as { id: string; root: string };
    world.fixture.db
      .prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?")
      .run(workspace.id, world.session);
    return { world, root: workspace.root };
  }

  /** The omp uid removed the marker; only the next spawn puts it back. */
  function removeMarker(root: string): void {
    rmdirSync(join(root, ".git"));
    expect(existsSync(join(root, ".git"))).toBe(false);
  }

  it(
    "regenerate's lazy acquisition and fork's temporary process put a removed marker back",
    REAL,
    async () => {
      const { world, root } = await openBound();
      const { app } = world.fixture;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      world.rt.clock.advance(IDLE_MS);
      await waitDead(world, 0);
      await settle();
      expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
      removeMarker(root);

      const regenerated = await postSessionAction(app, "regenerate", world.session, world.cookie);
      expect(regenerated.statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      expect(requiredCall(world.rt.calls, 1).cwd).toBe(root);
      expect(markerSeen(root)).toEqual(EMPTY_MARKER);
      removeMarker(root);

      const first = messagesOf(world.fixture.db, world.session).find((m) => m.role === "user");
      const forked = await postSessionAction(app, "fork", world.session, world.cookie, {
        name: "fork body",
        payload: JSON.stringify({ messageId: first?.id }),
        contentType: "application/json",
      });
      expect(forked.statusCode).toBe(201);
      expect(requiredCall(world.rt.calls, 2).cwd).toBe(root);
      expect(world.rt.calls).toHaveLength(3);
      expect(markerSeen(root)).toEqual(EMPTY_MARKER);
    },
  );
});
