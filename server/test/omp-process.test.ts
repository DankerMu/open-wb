/**
 * Issue #85 omp spawn contract: argv, allowlisted env, directory preparation.
 */
import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeSudoPath } from "../src/core/process-path.js";
import { type SpawnImpl, type SpawnOmpOpts, spawnOmp } from "../src/sessions/omp/process.js";
import { observeChild } from "./child-stdio-helpers.js";
import { recordedSpawn, sudoPrefix } from "./session-supervisor-helpers.js";

const CALLER_TOKEN = randomBytes(32).toString("hex");
const PARENT_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "u1";
const MODEL = "deepseek-v4.1-flash";
const SENTINEL_PATH = "/workbuddy/sentinel-bin";
const SENTINELS: Record<string, string> = {
  MODEL_UPSTREAM_API_KEY: "upstream-api-key-sentinel",
  MODEL_UPSTREAM_BASE_URL: "https://upstream.example/sentinel",
  OPENAI_API_KEY: "openai-sentinel",
  ANTHROPIC_API_KEY: "anthropic-sentinel",
  KB_SERVICE_API_KEY: "kb-credential-sentinel",
  DB_PATH: "/tmp/should-not-inherit.db",
  UNRELATED_SENTINEL: "unrelated-parent-value",
  HOME: "/tmp/parent-home-sentinel",
  PI_CODING_AGENT_DIR: "/tmp/parent-agent-sentinel",
  WORKBUDDY_MODEL_TOKEN: PARENT_TOKEN,
  PATH: SENTINEL_PATH,
};
const FORBIDDEN_KEYS = [
  "MODEL_UPSTREAM_API_KEY",
  "MODEL_UPSTREAM_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "KB_SERVICE_API_KEY",
  "DB_PATH",
  "UNRELATED_SENTINEL",
] as const;
const ARGV_PROBE = `process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(1),
}));`;
const SHEBANG_PROBE = `process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}));`;
const ENV_BIN = "/usr/bin/env";
/** 有界捕获须早于 REAL_CHILD_TEST_MS 触发，诊断才能出现在失败里。 */
const CAPTURE_MS = 5_000;
const REAL_CHILD_TEST_MS = 15_000;
const LATE_OUTPUT = "written after the observed exit\n";

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  stdio: unknown;
  shell: unknown;
}

interface ArgvProbe {
  cwd: string;
  argv: string[];
}

interface ChildOutput {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
}

interface Parsed<T> {
  value: T;
  code: number | null;
  diagnostic: string;
}

interface SpawnRoots {
  root: string;
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  cwd: string;
  sessionDir: string;
  home: string;
  agent: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("spawnOmp spawn contract", () => {
  it("cold launch uses exact argv without --resume after the four directories exist", async () => {
    const roots = makeRoots();
    const call = await capture(roots, null);
    expect(call.command).toBe(roots.bin);
    expect(call.args).toEqual(coldArgs(roots));
    expect(call.args).not.toContain("--resume");
    expect(call.args.join("\0")).not.toContain(CALLER_TOKEN);
    expect(call.cwd).toBe(roots.cwd);
    expect(call.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(call.shell).toBe(false);
    expectFourDirectories(roots, 0o2770);
  });

  it("resume launch appends --resume and a path with spaces as one argv entry", async () => {
    const roots = makeRoots();
    const resumePath = join(roots.sessionDir, "resume file.jsonl");
    const call = await capture(roots, resumePath);
    expect(call.args).toEqual([...coldArgs(roots), "--resume", resumePath]);
    expectFourDirectories(roots, 0o2770);
    const cold = await capture(roots, null);
    expect(cold.args).toEqual(coldArgs(roots));
  });

  it("child env is the allowlist with the caller token and no parent credentials", async () => {
    const roots = makeRoots();
    const parentBefore = { ...process.env };
    const { call, parentDuring } = await captureWithSnapshot(roots, {
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
    });
    expect({ ...process.env }).toEqual(parentBefore);
    expect(parentDuring.MODEL_UPSTREAM_API_KEY).toBe(SENTINELS.MODEL_UPSTREAM_API_KEY);
    expect(CALLER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(call.env.WORKBUDDY_MODEL_TOKEN).toBe(CALLER_TOKEN);
    expect(call.env.HOME).not.toBe(SENTINELS.HOME);
    expect(call.env.PI_CODING_AGENT_DIR).not.toBe(SENTINELS.PI_CODING_AGENT_DIR);
    for (const key of FORBIDDEN_KEYS) {
      expect(call.env).not.toHaveProperty(key);
    }
  });

  it("copies empty LANG and TMPDIR, omits them when absent, and uses empty PATH when absent", async () => {
    const roots = makeRoots();
    const empty = await capture(roots, null, { LANG: "", TMPDIR: "" });
    expect(empty.command).toBe(roots.bin);
    expect(empty.args).toEqual(coldArgs(roots));
    expect(empty.env).toEqual(allowlist(roots, { LANG: "", TMPDIR: "" }));
    const sparse = makeRoots();
    const omitted = await capture(sparse, null, {
      LANG: undefined,
      TMPDIR: undefined,
      PATH: undefined,
    });
    expect(omitted.command).toBe(sparse.bin);
    expect(omitted.args).toEqual(coldArgs(sparse));
    expect(omitted.env).toEqual(allowlist(sparse, { PATH: "" }));
    expect(omitted.env).not.toHaveProperty("LANG");
    expect(omitted.env).not.toHaveProperty("TMPDIR");
  });

  it("reuses existing directories on a later launch", async () => {
    const roots = makeRoots();
    mkdirSync(roots.cwd, { recursive: true });
    mkdirSync(roots.sessionDir, { recursive: true });
    mkdirSync(roots.home, { recursive: true });
    mkdirSync(roots.agent, { recursive: true });
    chmodSync(roots.cwd, 0o755);
    chmodSync(roots.sessionDir, 0o755);
    chmodSync(roots.home, 0o755);
    chmodSync(roots.agent, 0o755);
    writeFileSync(join(roots.home, "keep.txt"), "keep");
    await captureColdLaunch(roots, 0o755);
    expect(statSync(join(roots.home, "keep.txt")).isFile()).toBe(true);
  });

  it("fails before spawn when a required directory path is a file", async () => {
    const roots = makeRoots();
    mkdirSync(roots.stateDir, { recursive: true });
    writeFileSync(roots.home, "not a directory");
    const calls: SpawnCall[] = [];
    await withContaminatedEnv({}, async () => {
      await expect(spawnOmp(optsOf(roots, null), capturingSpawn(roots, calls))).rejects.toThrow();
    });
    expect(calls).toHaveLength(0);
    expect(statSync(roots.home).isFile()).toBe(true);
  });

  it("creates missing shared path levels at 2770 before spawn and leaves umask unchanged", async () => {
    const roots = makeRoots();
    await captureColdLaunch(roots, 0o2770);
    expect(lstatSync(roots.sandboxRoot).mode & 0o7777).toBe(0o2770);
    expect(lstatSync(roots.stateDir).mode & 0o7777).toBe(0o2770);
    expect(lstatSync(join(roots.stateDir, "sessions")).mode & 0o7777).toBe(0o2770);
  });

  it("real child observes captured env, cwd, and argv under contaminated parent env", {
    timeout: REAL_CHILD_TEST_MS,
  }, async () => {
    const roots = makeRoots();
    const resumePath = join(roots.sessionDir, "resume file.jsonl");
    const parentBefore = { ...process.env };
    const argvCalls: SpawnCall[] = [];
    const envCalls: SpawnCall[] = [];
    let argvProbe: Parsed<ArgvProbe> | undefined;
    let envDump: Parsed<Record<string, string>> | undefined;
    await withContaminatedEnv({ LANG: "C.UTF-8", TMPDIR: "/tmp" }, async () => {
      const parentDuring = { ...process.env };
      argvProbe = await readArgvProbe(
        await spawnOmp(optsOf(roots, resumePath), probingSpawn(roots, argvCalls)),
      );
      envDump = await readEnvDump(
        await spawnOmp(optsOf(roots, resumePath), envDumpSpawn(roots, envCalls)),
      );
      expect({ ...process.env }).toEqual(parentDuring);
    });
    expect({ ...process.env }).toEqual(parentBefore);
    const argvCall = argvCalls[0];
    const envCall = envCalls[0];
    expect(argvCall).toBeDefined();
    expect(envCall).toBeDefined();
    expect(argvProbe).toBeDefined();
    expect(envDump).toBeDefined();
    if (
      argvCall === undefined ||
      envCall === undefined ||
      argvProbe === undefined ||
      envDump === undefined
    ) {
      return;
    }
    expectFourDirectories(roots, 0o2770);
    const probe = argvProbe.value;
    const env = envDump.value;
    expect(realpathSync(probe.cwd), argvProbe.diagnostic).toBe(
      realpathSync(argvCall.cwd ?? probe.cwd),
    );
    expect(realpathSync(probe.cwd), argvProbe.diagnostic).toBe(realpathSync(roots.cwd));
    expect(probe.argv, argvProbe.diagnostic).toEqual([argvCall.command, ...argvCall.args]);
    expect(env, envDump.diagnostic).toEqual(envCall.env);
    expect(env, envDump.diagnostic).toEqual(allowlist(roots, { LANG: "C.UTF-8", TMPDIR: "/tmp" }));
    for (const key of FORBIDDEN_KEYS) {
      expect(env, envDump.diagnostic).not.toHaveProperty(key);
    }
    expect(JSON.stringify(probe.argv), argvProbe.diagnostic).not.toContain(CALLER_TOKEN);
  });

  it("default spawn launches the supplied bin with piped argv and cwd", {
    timeout: REAL_CHILD_TEST_MS,
  }, async () => {
    const roots = makeRoots();
    const bin = join(roots.root, "probe.mjs");
    writeFileSync(bin, `#!${process.execPath}\n${SHEBANG_PROBE}\n`);
    chmodSync(bin, 0o755);
    const parentBefore = { ...process.env };
    let probed: Parsed<ArgvProbe> | undefined;
    await withContaminatedEnv({ LANG: "C.UTF-8", TMPDIR: "/tmp" }, async () => {
      const parentDuring = { ...process.env };
      const child = await spawnOmp({ ...optsOf(roots, null), bin });
      children.push(child);
      child.stdin.end();
      probed = await readArgvProbe(child);
      expect({ ...process.env }).toEqual(parentDuring);
    });
    expect({ ...process.env }).toEqual(parentBefore);
    expect(probed).toBeDefined();
    if (probed === undefined) {
      return;
    }
    const { value: report, diagnostic } = probed;
    expect(probed.code, diagnostic).toBe(0);
    expectFourDirectories(roots, 0o2770);
    expect(realpathSync(report.cwd), diagnostic).toBe(realpathSync(roots.cwd));
    expect(report.argv, diagnostic).toEqual(coldArgs(roots));
    expect(JSON.stringify(report.argv), diagnostic).not.toContain(CALLER_TOKEN);
  });

  it("capture after an observed exit still returns output delivered before close", {
    timeout: REAL_CHILD_TEST_MS,
  }, async () => {
    const { root } = makeRoots();
    const go = join(root, "go");
    const child = spawn(process.execPath, ["-e", lateWriterParent(go)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    await once(child, "exit");
    const pending = captureChild(child);
    writeFileSync(go, "");
    const output = await pending;
    expect(output.stdout, output.diagnostic).toBe(LATE_OUTPUT);
    expect(output.code, output.diagnostic).toBe(0);
    expect(output.diagnostic).toMatch(/events=exited-before-observe>stdout-data(x\d+)?>close$/);
  });

  it("reports exit code, signal, byte count and event order for unusable captures", async () => {
    const empty = spawn(process.execPath, ["-e", "process.exit(3)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(empty);
    await expect(readArgvProbe(empty)).rejects.toThrow(
      /^unparseable argv probe output "": code=3 signal=null stdoutBytes=0 stderrBytes=0 events=exit>close$/,
    );
    const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(hung);
    await expect(captureChild(hung, 200)).rejects.toThrow(
      /^child output capture: no close within 200ms; code=null signal=null stdoutBytes=0 stderrBytes=0 events=none$/,
    );
  });

  it.each(["", "/tmp/workbuddy user:proof $;`\"'", "/tmp/workbuddy-sentinel"])(
    "keeps the direct spawn identical when user is absent or explicitly undefined and TMPDIR is %j",
    async (tmpdir) => {
      const roots = makeRoots();
      const resumePath = join(roots.sessionDir, "resume file.jsonl");
      const parentBefore = { ...process.env };
      const optional = { LANG: "C.UTF-8", TMPDIR: tmpdir };
      const absent = await capture(roots, resumePath, optional);
      const explicit = await capture(roots, resumePath, optional, undefined);
      expect({ ...process.env }).toEqual(parentBefore);
      expect(explicit).toEqual(absent);
      expect(absent.command).toBe(roots.bin);
      expect(absent.args).toEqual([...coldArgs(roots), "--resume", resumePath]);
      expect(absent.env).toEqual(allowlist(roots, optional));
      expect(absent.cwd).toBe(roots.cwd);
      expect(absent.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(absent.shell).toBe(false);
      expect(JSON.stringify(absent.args)).not.toContain(CALLER_TOKEN);
      expect(JSON.stringify(absent.args)).not.toContain(PARENT_TOKEN);
      expect(absent.env).not.toHaveProperty("OMP_USER");
    },
  );

  it.each(["", "/tmp/workbuddy user:proof $;`\"'"])(
    "prefixes sudo for cold and resume while preserving env values under a contaminated parent when TMPDIR is %j",
    async (tmpdir) => {
      const user = "omp";
      const optional = { LANG: "zh_CN.UTF-8", TMPDIR: tmpdir };
      const coldRoots = makeRoots();
      const parentBefore = { ...process.env };
      const cold = await capture(coldRoots, null, optional, user);
      const resumeRoots = makeRoots();
      const resumePath = join(resumeRoots.sessionDir, "resume file.jsonl");
      const resumed = await capture(resumeRoots, resumePath, optional, user);
      expect({ ...process.env }).toEqual(parentBefore);
      expect(cold.command).toBe("sudo");
      expect(cold.args).toEqual([
        ...sudoPrefix(user, coldRoots.bin, tmpdir),
        ...coldArgs(coldRoots),
      ]);
      expect(resumed.command).toBe("sudo");
      expect(resumed.args).toEqual([
        ...sudoPrefix(user, resumeRoots.bin, tmpdir),
        ...coldArgs(resumeRoots),
        "--resume",
        resumePath,
      ]);
      expect(cold.env).toEqual(allowlist(coldRoots, optional));
      expect(resumed.env).toEqual(allowlist(resumeRoots, optional));
      expect(cold.cwd).toBe(coldRoots.cwd);
      expect(resumed.cwd).toBe(resumeRoots.cwd);
      expect(cold.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(resumed.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(cold.shell).toBe(false);
      expect(resumed.shell).toBe(false);
      for (const call of [cold, resumed]) {
        expect(call.env.WORKBUDDY_MODEL_TOKEN).toBe(CALLER_TOKEN);
        expect(JSON.stringify(call.args)).not.toContain(CALLER_TOKEN);
        expect(JSON.stringify(call.args)).not.toContain(PARENT_TOKEN);
        expect(JSON.stringify(call.args)).not.toContain(SENTINELS.MODEL_UPSTREAM_API_KEY);
        expect(call.env).not.toHaveProperty("OMP_USER");
        expect(call.env).not.toHaveProperty("MODEL_UPSTREAM_API_KEY");
      }
    },
  );

  it("omits absent LANG and TMPDIR from the sudo child without inventing them", async () => {
    const roots = makeRoots();
    const call = await capture(roots, null, { LANG: undefined, TMPDIR: undefined }, "omp_user");
    expect(call.command).toBe("sudo");
    expect(call.args).toEqual([...sudoPrefix("omp_user", roots.bin), ...coldArgs(roots)]);
    expect(call.env).toEqual(allowlist(roots));
    expect(call.env).not.toHaveProperty("LANG");
    expect(call.env).not.toHaveProperty("TMPDIR");
    expect(call.env).not.toHaveProperty("OMP_USER");
    const resumePath = join(roots.sessionDir, "resume file.jsonl");
    const resumed = await capture(
      roots,
      resumePath,
      { LANG: undefined, TMPDIR: undefined },
      "omp_user",
    );
    expect(resumed.command).toBe("sudo");
    expect(resumed.args).toEqual([
      ...sudoPrefix("omp_user", roots.bin),
      ...coldArgs(roots),
      "--resume",
      resumePath,
    ]);
    expect(resumed.env).toEqual(allowlist(roots));
    expect(resumed.env).not.toHaveProperty("LANG");
    expect(resumed.env).not.toHaveProperty("TMPDIR");
  });

  it("rejects unsafe PATH for sudo before mkdir and never runs a workspace sudo", async () => {
    expect(() => assertSafeSudoPath("/usr/bin\0/bin")).toThrow();
    for (const path of [
      undefined,
      "",
      ":",
      "/usr/bin:",
      ":/usr/bin",
      "/usr/bin::/bin",
      "bin",
      "/usr/bin:bin",
    ]) {
      const roots = makeRoots();
      const marker = join(roots.root, "ran");
      const decoy = join(roots.cwd, "sudo");
      mkdirSync(roots.cwd, { recursive: true });
      writeFileSync(
        decoy,
        `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');\n`,
      );
      chmodSync(decoy, 0o755);
      const calls: SpawnCall[] = [];
      await withContaminatedEnv({ PATH: path, LANG: undefined, TMPDIR: undefined }, async () => {
        await expect(
          spawnOmp(optsOf(roots, null, "omp"), capturingSpawn(roots, calls)),
        ).rejects.toThrow();
      });
      expect(calls).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(roots.home)).toBe(false);
    }
  });

  it("keeps the direct spawn when PATH is absent and a workspace sudo exists", async () => {
    const roots = makeRoots();
    const marker = join(roots.root, "ran");
    mkdirSync(roots.cwd, { recursive: true });
    writeFileSync(
      join(roots.cwd, "sudo"),
      `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');\n`,
    );
    chmodSync(join(roots.cwd, "sudo"), 0o755);
    const call = await capture(roots, null, { PATH: undefined });
    expect(call.command).toBe(roots.bin);
    expect(call.env.PATH).toBe("");
    expect(existsSync(marker)).toBe(false);
  });
});

function makeRoots(): SpawnRoots {
  const root = mkdtempSync(join(tmpdir(), "omp-spawn-"));
  temps.push(root);
  const sandboxRoot = join(root, "sandbox root");
  const stateDir = join(root, "state dir");
  return {
    root,
    bin: join(root, "omp-bin"),
    sandboxRoot,
    stateDir,
    cwd: join(sandboxRoot, OWNER),
    sessionDir: join(stateDir, "sessions", OWNER),
    home: join(stateDir, "home"),
    agent: join(stateDir, "agent"),
  };
}

function optsOf(roots: SpawnRoots, resumePath: string | null, user?: string): SpawnOmpOpts {
  return {
    bin: roots.bin,
    sandboxRoot: roots.sandboxRoot,
    stateDir: roots.stateDir,
    ownerId: OWNER,
    modelId: MODEL,
    token: CALLER_TOKEN,
    resumePath,
    ...(user === undefined ? {} : { ompUser: user }),
  };
}

function coldArgs(roots: SpawnRoots): string[] {
  return [
    "--mode",
    "rpc",
    "--cwd",
    roots.cwd,
    "--session-dir",
    roots.sessionDir,
    "--model",
    `workbuddy/${MODEL}`,
    "--approval-mode",
    "yolo",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
  ];
}

function allowlist(
  roots: SpawnRoots,
  extra: { PATH?: string; LANG?: string; TMPDIR?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: extra.PATH ?? SENTINEL_PATH,
    HOME: roots.home,
    PI_CODING_AGENT_DIR: roots.agent,
    WORKBUDDY_MODEL_TOKEN: CALLER_TOKEN,
  };
  if (extra.LANG !== undefined) {
    env.LANG = extra.LANG;
  }
  if (extra.TMPDIR !== undefined) {
    env.TMPDIR = extra.TMPDIR;
  }
  return env;
}

function expectFourDirectories(roots: SpawnRoots, mode?: number): void {
  expect(lstatSync(roots.cwd).isDirectory()).toBe(true);
  expect(lstatSync(roots.sessionDir).isDirectory()).toBe(true);
  expect(lstatSync(roots.home).isDirectory()).toBe(true);
  expect(lstatSync(roots.agent).isDirectory()).toBe(true);
  if (mode === undefined) {
    return;
  }
  expect(lstatSync(roots.cwd).mode & 0o7777).toBe(mode);
  expect(lstatSync(roots.sessionDir).mode & 0o7777).toBe(mode);
  expect(lstatSync(roots.home).mode & 0o7777).toBe(mode);
  expect(lstatSync(roots.agent).mode & 0o7777).toBe(mode);
}

async function capture(
  roots: SpawnRoots,
  resumePath: string | null,
  patch: Record<string, string | undefined> = {},
  user?: string,
): Promise<SpawnCall> {
  const calls: SpawnCall[] = [];
  await withContaminatedEnv(patch, async () => {
    await spawnOmp(optsOf(roots, resumePath, user), capturingSpawn(roots, calls));
  });
  const call = calls[0];
  if (call === undefined) {
    throw new Error("spawnImpl was not invoked");
  }
  return call;
}

async function captureColdLaunch(roots: SpawnRoots, mode: number): Promise<void> {
  const umaskBefore = process.umask();
  const call = await capture(roots, null);
  expect(call.command).toBe(roots.bin);
  expect(call.args).toEqual(coldArgs(roots));
  expectFourDirectories(roots, mode);
  expect(process.umask()).toBe(umaskBefore);
}

async function captureWithSnapshot(
  roots: SpawnRoots,
  patch: Record<string, string | undefined>,
): Promise<{ call: SpawnCall; parentDuring: NodeJS.ProcessEnv }> {
  const calls: SpawnCall[] = [];
  let parentDuring: NodeJS.ProcessEnv = {};
  await withContaminatedEnv(patch, async () => {
    parentDuring = { ...process.env };
    await spawnOmp(optsOf(roots, null), capturingSpawn(roots, calls));
    expect({ ...process.env }).toEqual(parentDuring);
  });
  const call = calls[0];
  if (call === undefined) {
    throw new Error("spawnImpl was not invoked");
  }
  return { call, parentDuring };
}

function capturingSpawn(roots: SpawnRoots, calls: SpawnCall[]): SpawnImpl {
  return observingSpawn(roots, calls, (_command, _args, _options) =>
    spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    }),
  );
}

function probingSpawn(roots: SpawnRoots, calls: SpawnCall[]): SpawnImpl {
  return observingSpawn(roots, calls, (command, args, options) =>
    spawn(process.execPath, ["-e", ARGV_PROBE, command, ...args], observedSpawnOptions(options)),
  );
}

function envDumpSpawn(roots: SpawnRoots, calls: SpawnCall[]): SpawnImpl {
  return observingSpawn(roots, calls, (_command, _args, options) =>
    spawn(ENV_BIN, [], observedSpawnOptions(options)),
  );
}

function observingSpawn(
  roots: SpawnRoots,
  calls: SpawnCall[],
  launch: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams,
): SpawnImpl {
  return (command, args, options) => {
    calls.push(recordedCall(command, args, options));
    expectFourDirectories(roots);
    const child = launch(command, args, options);
    children.push(child);
    return child;
  };
}

function observedSpawnOptions(options: SpawnOptions): SpawnOptionsWithoutStdio {
  return {
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  };
}

function recordedCall(command: string, args: readonly string[], options: SpawnOptions): SpawnCall {
  const call = recordedSpawn(command, args, options);
  return {
    command: call.command,
    args: call.args,
    cwd: call.cwd,
    env: call.env,
    stdio: call.stdio,
    shell: call.shell,
  };
}

/** 输出只在 'close' 后才算完整（#191）；超时以诊断拒绝。 */
async function captureChild(
  child: ChildProcessWithoutNullStreams,
  ms = CAPTURE_MS,
): Promise<ChildOutput> {
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const observer = observeChild(child);
  await observer.waitClose(ms, "child output capture");
  return {
    stdout,
    code: child.exitCode,
    signal: child.signalCode,
    diagnostic: observer.diagnostic(),
  };
}

async function readArgvProbe(child: ChildProcessWithoutNullStreams): Promise<Parsed<ArgvProbe>> {
  const output = await captureChild(child);
  let value: ArgvProbe;
  try {
    value = JSON.parse(output.stdout) as ArgvProbe;
  } catch (error) {
    throw new Error(
      `unparseable argv probe output ${JSON.stringify(output.stdout)}: ${output.diagnostic}`,
      { cause: error },
    );
  }
  return { value, code: output.code, diagnostic: output.diagnostic };
}

async function readEnvDump(
  child: ChildProcessWithoutNullStreams,
): Promise<Parsed<Record<string, string>>> {
  const output = await captureChild(child);
  const env: Record<string, string> = {};
  for (const line of output.stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      env[line] = "";
    } else {
      env[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return { value: env, code: output.code, diagnostic: output.diagnostic };
}

/**
 * 父进程立即退出；继承 stdio 的孙进程等到 `go` 出现才写 LATE_OUTPUT 并退出，
 * 于是 'exit' 必先于管道数据被观察到，'close' 必在数据之后。
 */
function lateWriterParent(go: string): string {
  const writer =
    `const fs=require("node:fs");setTimeout(()=>process.exit(1),${CAPTURE_MS}).unref();` +
    `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);` +
    `process.stdout.write(${JSON.stringify(LATE_OUTPUT)});}},10);`;
  return (
    `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(writer)}],` +
    `{stdio:"inherit"}).unref();process.exit(0);`
  );
}

async function withContaminatedEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const merged: Record<string, string | undefined> = { ...SENTINELS, ...patch };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(merged)) {
    previous[key] = process.env[key];
    const value = merged[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitExit(child);
}

function waitExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  if (child.signalCode !== null) {
    return Promise.resolve(1);
  }
  return new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}
