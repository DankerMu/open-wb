/**
 * Issue #131 Linux uid isolation: real SessionRuntime → native sudo → fake-omp probe.
 * Issue #351: retire's SIGKILL of sudo reaps omp through setpriv --pdeathsig KILL.
 * Issue #525: DELETE unlinks the omp-uid-written branch file from the app-uid session dir.
 * Issue #758: and removes the omp-uid-written artifact directory next to that file.
 * Issue #760: what omp writes through sudo → setpriv has no other bits and keeps group write.
 * Issue #706: the managed state layout is read-only for the omp uid except HOME and the
 * three XDG `omp` directories; the trash a DELETE moves artifacts through is closed to it.
 * Issue #708: the host overlay in the managed agent dir cannot be overwritten by the omp uid.
 * Non-Linux / unset WORKBUDDY_UID_TEST skip; opted-in missing OMP_USER fails.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/core/db/index.js";
import { writeManagedModelsYml } from "../../src/model-proxy/models-yml.js";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import { writeHostOverlay } from "../../src/sessions/omp/host-overlay.js";
import type { OmpExit } from "../../src/sessions/omp/process.js";
import { SessionRuntime, type SessionRuntimeOpts } from "../../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout } from "../../src/sessions/omp/state-layout.js";
import { TokenRegistry } from "../../src/sessions/tokens.js";
import { listOneLevel } from "../../src/workspaces/tree.js";
import { FIXED_NOW, fixedRuntime } from "../session-db-helpers.js";
import { cookieFor } from "../session-rest-helpers.js";
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
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_FILES",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "WORKBUDDY_MODEL_TOKEN",
] as const;
const REPORT_LABELS = [
  "uid",
  "gid",
  "env",
  "home",
  "xdgdata",
  "xdgstate",
  "xdgcache",
  "environ",
  "wrote",
  "frames",
  "cwd",
] as const;
/** fake-omp argv ends with the appended scenario; pgrep -u matches the effective uid only. */
const HANG_PATTERN = "scenario hang-term$";
/** runtime.ts TERM@5 s + KILL@8 s budget plus scheduling slack. */
const RETIRE_LIMIT_MS = 11_000;
const REAP_POLL_MS = 2_000;
/** The fake's fixed branch list ends with this text; regenerate matches only the last entry. */
const BRANCH_QUESTION = "second question";
const TURN_LIMIT_MS = 20_000;

interface OwnedLayout {
  ownedRoot: string;
  sandboxRoot: string;
  stateDir: string;
  writePath: string;
  expectedHome: string;
  expectedXdg: { data: string; state: string; cache: string };
}

describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_UID_TEST !== "1")(
  "Linux omp uid isolation",
  () => {
    it("isolates child uid, env, proc, and shared writes", { timeout: 30_000 }, async () => {
      const ompUser = requireOmpUser();
      const parentUid = requireParentUid();
      await withOwnedLayout("uid-isolation-", async (layout, own) => {
        const runtime = own(new SessionRuntime(runtimeOpts(layout, ompUser, SESSION_ID)));
        const frames = await collectPrompt(
          runtime.prompt(`probe:${String(process.pid)}:${layout.writePath}`),
        );
        assertIsolation(frames, parentUid, layout);
      });
    });

    it("reaps omp when retire escalates to SIGKILL of sudo", { timeout: 30_000 }, async () => {
      const ompUser = requireOmpUser();
      await withOwnedLayout("uid-reap-", async (layout, own) => {
        const sudoExits: OmpExit[] = [];
        const runtime = own(
          new SessionRuntime({
            ...runtimeOpts(layout, ompUser, `${SESSION_ID}-reap`),
            spawnImpl: (command, args, options) => {
              expect(command).toBe("sudo");
              const child = spawn(command, [...args, "--scenario", "hang-term"], options);
              child.once("exit", (code, signal) => sudoExits.push({ code, signal }));
              return child as ChildProcessWithoutNullStreams;
            },
          }),
        );
        await collectPrompt(runtime.prompt("hang-term"));
        expect(ompUserHangPids(ompUser)).toHaveLength(1);
        const started = Date.now();
        await runtime.shutdown();
        expect(Date.now() - started).toBeLessThan(RETIRE_LIMIT_MS);
        expect(sudoExits).toEqual([{ code: null, signal: "SIGKILL" }]);
        await expectReaped(ompUser);
      });
    });

    it("deletes a sudo-mode session and the branch file omp wrote", {
      timeout: 60_000,
    }, async () => {
      const ompUser = requireOmpUser();
      const parentUid = requireParentUid();
      const previous = snapshotParentEnv();
      const db = openDb(":memory:");
      const errors: Error[] = [];
      let ownedRoot: string | undefined;
      let app: FastifyInstance | undefined;
      try {
        applyParentEnv(previous);
        ownedRoot = mkdtempSync(join(tmpdir(), "uid-delete-"));
        const layout = createOwnedLayout(ownedRoot);
        app = createApp({
          db,
          authRuntime: fixedRuntime(() => FIXED_NOW),
          assembly: {
            tokens: new TokenRegistry(),
            runtime: {
              bin: FAKE,
              sandboxRoot: layout.sandboxRoot,
              stateDir: layout.stateDir,
              modelId: MODEL_ID,
              idleMs: 60_000,
              ompUser,
              spawnImpl: (command, args, options) => {
                expect(command).toBe("sudo");
                const child = spawn(command, [...args, "--scenario", "branch"], options);
                return child as ChildProcessWithoutNullStreams;
              },
            },
            onError(error) {
              errors.push(error);
            },
          },
        });
        const cookie = await cookieFor(app, "zhangsan");
        const session = await createOwnedSession(app, cookie);
        await runToDone(
          app,
          cookie,
          session,
          "prompt",
          JSON.stringify({ message: BRANCH_QUESTION }),
        );
        await runToDone(app, cookie, session, "regenerate");
        const file = sessionFileOf(db, session);
        expect(file.startsWith(join(layout.stateDir, "sessions", OWNER_ID, "branch-"))).toBe(true);
        expect(statSync(file).uid).not.toBe(parentUid);
        // The artifact directory fake-omp made next to it, with its file and nested directory.
        const artifacts = file.slice(0, -".jsonl".length);
        for (const entry of [artifacts, join(artifacts, "1.bash.log"), join(artifacts, "local")]) {
          expect(statSync(entry).uid).not.toBe(parentUid);
        }
        expect(statSync(artifacts).isDirectory()).toBe(true);
        expect(statSync(join(artifacts, "local", "note.txt")).isFile()).toBe(true);
        // Modes are read here, before the DELETE below removes every one of these entries.
        for (const entry of [
          file,
          artifacts,
          join(artifacts, "1.bash.log"),
          join(artifacts, "local"),
          join(artifacts, "local", "note.txt"),
        ]) {
          expectSharedMode(entry);
        }

        const deleted = await app.inject({
          method: "DELETE",
          url: `/api/sessions/${session}`,
          headers: { cookie },
        });

        expect(deleted.statusCode).toBe(204);
        expect(existsSync(file)).toBe(false);
        expect(existsSync(artifacts)).toBe(false);
        expect(readdirSync(join(layout.stateDir, "trash"))).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        try {
          await app?.close();
        } finally {
          db.close();
          await releaseIsolation(undefined, ownedRoot, previous);
        }
      }
    });

    it("keeps the managed state layout read-only for the omp uid", {
      timeout: 60_000,
    }, async () => {
      const ompUser = requireOmpUser();
      await withOwnedLayout("uid-layout-", async (layout, own) => {
        const state = layout.stateDir;
        const agent = join(state, "home", ".omp", "agent");
        const models = join(agent, "models.yml");
        const overlay = join(agent, "host-overlay.yml");
        const dotenv = join(state, "home", ".env");
        ensureOmpStateLayout(state);
        await writeManagedModelsYml(agent, {
          proxyBaseUrl: "http://127.0.0.1:18016/v1",
          models: [{ id: MODEL_ID, name: MODEL_ID, reasoning: false, vision: false }],
        });
        await writeHostOverlay(state);
        const modelsBefore = readFileSync(models);
        const overlayBefore = readFileSync(overlay);
        // An operator's line: the omp uid can read the file but not change or replace it (#802).
        writeFileSync(dotenv, "OPERATOR_VAR=1\n");
        const dotenvBefore = readFileSync(dotenv);
        const managed = [
          state,
          join(state, "sessions"),
          join(state, "xdg"),
          join(state, "xdg", "data"),
          join(state, "home", ".omp"),
          agent,
        ];
        const writable = [
          join(state, "home"),
          join(state, "xdg", "data", "omp"),
          join(state, "xdg", "state", "omp"),
          join(state, "xdg", "cache", "omp"),
        ];
        const session = own(
          new SessionRuntime(runtimeOpts(layout, ompUser, `${SESSION_ID}-layout`)),
        );
        const ask = async (text: string): Promise<string> =>
          probeReport(await collectPrompt(session.prompt(text)));
        const write = async (path: string): Promise<string> =>
          parseLabeledReport(await ask(`probe:${String(process.pid)}:${path}`)).wrote;
        // The spawn re-asserted the layout; listings are taken after it and before any attempt.
        await collectPrompt(session.prompt("spawn"));
        const before = managed.map((dir) => readdirSync(dir).toSorted());

        for (const dir of managed) {
          expect(await write(join(dir, "planted by omp")), dir).toBe("EACCES");
        }
        expect(await write(models), models).toBe("EACCES");
        expect(await write(overlay), overlay).toBe("EACCES");
        expect(await write(dotenv), dotenv).toBe("EACCES");
        expect(await write(join(state, "trash", "x"))).toBe("EACCES");
        expect(readdirSync(join(state, "trash"))).toEqual([]);
        for (const dir of [join(state, "home"), join(state, "sessions"), agent]) {
          expect(await ask(`rename:${dir}`), dir).toBe("renamed=EACCES");
        }
        // Sticky HOME: the omp uid may write there but not rename the app-owned `.omp` or `.env`.
        expect(await ask(`rename:${join(state, "home", ".omp")}`)).toBe("renamed=EPERM");
        expect(await ask(`rename:${dotenv}`)).toBe("renamed=EPERM");
        for (const dir of writable) {
          expect(await write(join(dir, "written by omp")), dir).toBe("ok");
        }

        expect(readFileSync(models).equals(modelsBefore)).toBe(true);
        expect(lstatSync(models).uid).toBe(process.getuid?.());
        expect(readFileSync(overlay).equals(overlayBefore)).toBe(true);
        expect(lstatSync(overlay).uid).toBe(process.getuid?.());
        expect(lstatSync(overlay).mode & 0o7777).toBe(0o640);
        expect(readFileSync(dotenv).equals(dotenvBefore)).toBe(true);
        expect(lstatSync(dotenv).isFile()).toBe(true);
        expect(lstatSync(dotenv).uid).toBe(process.getuid?.());
        expect(lstatSync(dotenv).mode & 0o7777).toBe(0o640);
        expect(existsSync(`${dotenv}.moved`)).toBe(false);
        expect(managed.map((dir) => readdirSync(dir).toSorted())).toEqual(before);
        for (const dir of [...managed, ...writable]) {
          expect(lstatSync(dir).isDirectory(), dir).toBe(true);
          expect(existsSync(`${dir}.moved`), dir).toBe(false);
        }
        for (const dir of writable) {
          expect(statSync(join(dir, "written by omp")).uid).not.toBe(process.getuid?.());
        }
      });
    });
  },
);

/**
 * Runs `body` in a fresh owned layout with the parent sentinels applied; `own` registers the
 * runtime to shut down. The runtime, the directory and the parent env are always released.
 */
async function withOwnedLayout(
  prefix: string,
  body: (layout: OwnedLayout, own: (runtime: SessionRuntime) => SessionRuntime) => Promise<void>,
): Promise<void> {
  const previous = snapshotParentEnv();
  let ownedRoot: string | undefined;
  let runtime: SessionRuntime | undefined;
  try {
    applyParentEnv(previous);
    ownedRoot = mkdtempSync(join(tmpdir(), prefix));
    await body(createOwnedLayout(ownedRoot), (created) => {
      runtime = created;
      return created;
    });
  } finally {
    await releaseIsolation(runtime, ownedRoot, previous);
  }
}

/** The SessionRuntime options every case shares: fake omp under sudo in the owned layout. */
function runtimeOpts(layout: OwnedLayout, ompUser: string, sessionId: string): SessionRuntimeOpts {
  return {
    sessionId,
    bin: FAKE,
    sandboxRoot: layout.sandboxRoot,
    stateDir: layout.stateDir,
    ownerId: OWNER_ID,
    cwd: join(layout.sandboxRoot, OWNER_ID),
    modelId: MODEL_ID,
    tokens: new TokenRegistry(),
    ompUser,
  };
}

async function createOwnedSession(app: FastifyInstance, cookie: string): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie } });
  expect(created.statusCode).toBe(201);
  return (created.json() as { id: string }).id;
}

/** One accepted prompt or regenerate (202), then the session polled until it reads `done`. */
async function runToDone(
  app: FastifyInstance,
  cookie: string,
  session: string,
  action: "prompt" | "regenerate",
  payload?: string,
): Promise<void> {
  const accepted = await app.inject({
    method: "POST",
    url: `/api/sessions/${session}/${action}`,
    headers: payload === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload }),
  });
  expect(accepted.statusCode).toBe(202);
  const deadline = Date.now() + TURN_LIMIT_MS;
  while (sessionStatus(app, session) !== "done") {
    if (Date.now() >= deadline) {
      throw new Error(`${action} did not reach done`);
    }
    await sleep(50);
  }
}

function sessionStatus(app: FastifyInstance, session: string): string | undefined {
  return app.sessions.store.getMessages(session, OWNER_ID)?.session.status;
}

function sessionFileOf(db: ReturnType<typeof openDb>, session: string): string {
  const row = db.prepare("SELECT omp_session_file FROM chat_sessions WHERE id = ?").get(session) as
    | { omp_session_file: unknown }
    | undefined;
  if (typeof row?.omp_session_file !== "string") {
    throw new Error("session has no omp_session_file");
  }
  return row.omp_session_file;
}

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
  // No colon here: the layout refuses one (#802). The sandbox root and the probe file keep theirs.
  const stateDir = join(ownedRoot, "state dir uid");
  return {
    ownedRoot,
    sandboxRoot,
    stateDir,
    writePath: join(sandboxRoot, OWNER_ID, PROBE_FILE),
    expectedHome: join(stateDir, "home"),
    expectedXdg: {
      data: join(stateDir, "xdg", "data"),
      state: join(stateDir, "xdg", "state"),
      cache: join(stateDir, "xdg", "cache"),
    },
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
  expect(parsed.xdgdata).toBe(layout.expectedXdg.data);
  expect(parsed.xdgstate).toBe(layout.expectedXdg.state);
  expect(parsed.xdgcache).toBe(layout.expectedXdg.cache);
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
  expectSharedMode(layout.writePath);
}

/**
 * The omp side's umask is the sudoers `umask=0007`, not whatever the host's PAM hands out: 0002
 * leaves other bits set, 0022 additionally drops group write. The mode is in the failure message.
 */
function expectSharedMode(path: string): void {
  const mode = statSync(path).mode;
  const seen = `${path} has mode ${(mode & 0o7777).toString(8)}`;
  expect(mode & 0o007, seen).toBe(0);
  expect(mode & 0o060, seen).toBe(0o060);
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
    xdgdata: requiredValue(values, 4),
    xdgstate: requiredValue(values, 5),
    xdgcache: requiredValue(values, 6),
    environ: requiredValue(values, 7),
    wrote: requiredValue(values, 8),
    frames: requiredValue(values, 9),
    cwd: requiredValue(values, 10),
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
