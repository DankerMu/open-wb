/**
 * Issue #131 Linux uid isolation: real SessionRuntime → native sudo → fake-omp probe.
 * Issue #351: retire's SIGKILL of sudo reaps omp through setpriv --pdeathsig KILL.
 * Non-Linux / unset WORKBUDDY_UID_TEST skip; opted-in missing OMP_USER fails.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import type { OmpExit } from "../../src/sessions/omp/process.js";
import { SessionRuntime } from "../../src/sessions/omp/runtime.js";
import { TokenRegistry } from "../../src/sessions/tokens.js";
import { listOneLevel } from "../../src/workspaces/tree.js";
import { collectPrompt } from "../support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("../support/fake-omp.mjs", import.meta.url));
const SESSION_ID = "sess-uid-isolation-131";
const OWNER_ID = "u1";
const MODEL_ID = "deepseek-v4.1-flash";
const PROBE_CONTENT = "probe";
const PROBE_FILE = "probe file:report.txt";
const SHARED_MODE = 0o2770;
const PARENT_SENTINELS = {
  MODEL_UPSTREAM_API_KEY: "upstream-api-key-sentinel",
  OPENAI_API_KEY: "openai-sentinel",
  ANTHROPIC_API_KEY: "anthropic-sentinel",
  WORKBUDDY_CANARY_SECRET: "workbuddy-canary-secret",
} as const;
const REQUIRED_CHILD_ENV_KEYS = [
  "PATH",
  "LANG",
  "TMPDIR",
  "HOME",
  "PI_CODING_AGENT_DIR",
  "WORKBUDDY_MODEL_TOKEN",
] as const;
const REPORT_LABELS = ["uid", "gid", "env", "home", "agent", "environ", "wrote", "frames"] as const;
/** fake-omp argv ends with the appended scenario; pgrep -u matches the effective uid only. */
const HANG_PATTERN = "scenario hang-term$";
/** runtime.ts TERM@5 s + KILL@8 s budget plus scheduling slack. */
const RETIRE_LIMIT_MS = 11_000;
const REAP_POLL_MS = 2_000;

interface OwnedLayout {
  ownedRoot: string;
  sandboxRoot: string;
  stateDir: string;
  writePath: string;
  expectedHome: string;
  expectedAgent: string;
}

describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_UID_TEST !== "1")(
  "Linux omp uid isolation",
  () => {
    it("isolates child uid, env, proc, and shared writes", { timeout: 30_000 }, async () => {
      const ompUser = requireOmpUser();
      const parentUid = requireParentUid();
      const previous = snapshotParentEnv();
      let ownedRoot: string | undefined;
      let runtime: SessionRuntime | undefined;
      try {
        applyParentEnv(previous);
        ownedRoot = mkdtempSync(join(tmpdir(), "uid-isolation-"));
        const layout = createOwnedLayout(ownedRoot);
        runtime = new SessionRuntime({
          sessionId: SESSION_ID,
          bin: FAKE,
          sandboxRoot: layout.sandboxRoot,
          stateDir: layout.stateDir,
          ownerId: OWNER_ID,
          modelId: MODEL_ID,
          tokens: new TokenRegistry(),
          ompUser,
        });
        const frames = await collectPrompt(
          runtime.prompt(`probe:${String(process.pid)}:${layout.writePath}`),
        );
        assertIsolation(frames, parentUid, layout);
      } finally {
        await releaseIsolation(runtime, ownedRoot, previous);
      }
    });

    it("reaps omp when retire escalates to SIGKILL of sudo", { timeout: 30_000 }, async () => {
      const ompUser = requireOmpUser();
      const previous = snapshotParentEnv();
      let ownedRoot: string | undefined;
      let runtime: SessionRuntime | undefined;
      try {
        applyParentEnv(previous);
        ownedRoot = mkdtempSync(join(tmpdir(), "uid-reap-"));
        const layout = createOwnedLayout(ownedRoot);
        const sudoExits: OmpExit[] = [];
        runtime = new SessionRuntime({
          sessionId: `${SESSION_ID}-reap`,
          bin: FAKE,
          sandboxRoot: layout.sandboxRoot,
          stateDir: layout.stateDir,
          ownerId: OWNER_ID,
          modelId: MODEL_ID,
          tokens: new TokenRegistry(),
          ompUser,
          spawnImpl: (command, args, options) => {
            expect(command).toBe("sudo");
            const child = spawn(command, [...args, "--scenario", "hang-term"], options);
            child.once("exit", (code, signal) => sudoExits.push({ code, signal }));
            return child as ChildProcessWithoutNullStreams;
          },
        });
        await collectPrompt(runtime.prompt("hang-term"));
        expect(ompUserHangPids(ompUser)).toHaveLength(1);
        const started = Date.now();
        await runtime.shutdown();
        expect(Date.now() - started).toBeLessThan(RETIRE_LIMIT_MS);
        expect(sudoExits).toEqual([{ code: null, signal: "SIGKILL" }]);
        await expectReaped(ompUser);
      } finally {
        await releaseIsolation(runtime, ownedRoot, previous);
      }
    });
  },
);

/** pgrep status 1 is "no match"; any other failure is an observation failure, never empty. */
function ompUserHangPids(ompUser: string): string[] {
  const result = spawnSync("pgrep", ["-u", ompUser, "-f", HANG_PATTERN], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(`pgrep failed with status ${String(result.status)}`);
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

async function expectReaped(ompUser: string): Promise<void> {
  const deadline = Date.now() + REAP_POLL_MS;
  let pids = ompUserHangPids(ompUser);
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(50);
    pids = ompUserHangPids(ompUser);
  }
  expect(pids).toEqual([]);
}

function requireOmpUser(): string {
  const ompUser = process.env.OMP_USER;
  if (ompUser === undefined || ompUser.length === 0) {
    throw new Error("OMP_USER must be set when WORKBUDDY_UID_TEST=1");
  }
  return ompUser;
}

function requireParentUid(): number {
  const parentUid = process.getuid?.();
  if (typeof parentUid !== "number") {
    throw new Error("posix parent uid unavailable");
  }
  return parentUid;
}

function snapshotParentEnv(): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const key of [...Object.keys(PARENT_SENTINELS), "LANG", "TMPDIR"]) {
    previous[key] = process.env[key];
  }
  return previous;
}

function applyParentEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(PARENT_SENTINELS)) {
    process.env[key] = value;
  }
  process.env.LANG = previous.LANG ?? "C.UTF-8";
  process.env.TMPDIR = previous.TMPDIR ?? tmpdir();
}

function createOwnedLayout(ownedRoot: string): OwnedLayout {
  chmodSync(ownedRoot, SHARED_MODE);
  const sandboxRoot = join(ownedRoot, "sandbox root:uid");
  const stateDir = join(ownedRoot, "state dir:uid");
  return {
    ownedRoot,
    sandboxRoot,
    stateDir,
    writePath: join(sandboxRoot, OWNER_ID, PROBE_FILE),
    expectedHome: join(stateDir, "home"),
    expectedAgent: join(stateDir, "agent"),
  };
}

function probeReport(frames: readonly OmpFrame[]): string {
  const updates = frames.filter((frame) => frame.type === "message_update");
  expect(updates).toHaveLength(1);
  const event = updates[0]?.assistantMessageEvent;
  if (event === null || typeof event !== "object") {
    throw new Error("probe message_update missing assistantMessageEvent object");
  }
  const { type, delta } = event as { type?: unknown; delta?: unknown };
  if (type !== "text_delta" || typeof delta !== "string") {
    throw new Error("probe assistantMessageEvent is not a text_delta string");
  }
  return delta;
}

function assertIsolation(
  frames: readonly OmpFrame[],
  parentUid: number,
  layout: OwnedLayout,
): void {
  expect(frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
    true,
  );
  const parsed = parseLabeledReport(probeReport(frames));
  expect(/^[0-9]+$/u.test(parsed.uid)).toBe(true);
  const childUid = Number(parsed.uid);
  expect(Number.isInteger(childUid)).toBe(true);
  expect(childUid).not.toBe(parentUid);

  const childKeys = parsed.env.length === 0 ? [] : parsed.env.split(",");
  for (const key of REQUIRED_CHILD_ENV_KEYS) {
    expect(childKeys).toContain(key);
  }
  for (const key of Object.keys(PARENT_SENTINELS)) {
    expect(childKeys).not.toContain(key);
  }
  expect(parsed.home).toBe(layout.expectedHome);
  expect(parsed.agent).toBe(layout.expectedAgent);
  expect(parsed.environ).toBe("EACCES");
  expect(parsed.wrote).toBe("ok");

  expect(listOneLevel(join(layout.sandboxRoot, OWNER_ID))).toEqual([
    {
      name: PROBE_FILE,
      type: "file",
      size: Buffer.byteLength(PROBE_CONTENT),
      mtime: lstatSync(layout.writePath).mtimeMs,
    },
  ]);
  expect(readFileSync(layout.writePath, "utf8")).toBe(PROBE_CONTENT);
}

async function releaseIsolation(
  runtime: SessionRuntime | undefined,
  ownedRoot: string | undefined,
  previous: Record<string, string | undefined>,
): Promise<void> {
  try {
    if (runtime !== undefined) {
      await runtime.shutdown();
    }
  } finally {
    try {
      if (ownedRoot !== undefined) {
        rmSync(ownedRoot, { recursive: true, force: true });
      }
    } finally {
      restoreEnv(previous);
    }
  }
}

function parseLabeledReport(report: string): Record<(typeof REPORT_LABELS)[number], string> {
  const values: string[] = [];
  let rest = report;
  for (let index = 0; index < REPORT_LABELS.length; index += 1) {
    const label = REPORT_LABELS[index];
    const prefix = `${label}=`;
    if (label === undefined || !rest.startsWith(prefix)) {
      throw new Error(`probe report missing ${label}=`);
    }
    rest = rest.slice(prefix.length);
    const next = REPORT_LABELS[index + 1];
    if (next === undefined) {
      values.push(rest);
      break;
    }
    const separator = ` ${next}=`;
    const splitAt = rest.indexOf(separator);
    if (splitAt === -1) {
      throw new Error(`probe report missing ${next}=`);
    }
    values.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt + 1);
  }
  return {
    uid: requiredValue(values, 0),
    gid: requiredValue(values, 1),
    env: requiredValue(values, 2),
    home: requiredValue(values, 3),
    agent: requiredValue(values, 4),
    environ: requiredValue(values, 5),
    wrote: requiredValue(values, 6),
    frames: requiredValue(values, 7),
  };
}

function requiredValue(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error("probe report is truncated");
  }
  return value;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
