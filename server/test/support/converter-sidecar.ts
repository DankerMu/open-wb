/**
 * 转换 sidecar 子进程测试的共用夹具（issue 1504；`converter-sidecar*.test.ts`）。
 *
 * 以子进程启动 `node converter/sidecar.mjs`（它是守护进程，有顶层副作用，所以从不 import），
 * `CONVERTER_SOFFICE_BIN` 指向 `fixtures/fake-soffice.mjs`；测试充当 app：在临时 spool 的 `jobs/`
 * 下建作业目录、经 `.part` + `rename` 写出 `request.json`，再读 sidecar 写回的 `done` / `failed`。
 * 每个测试文件各有一份本模块的状态（vitest 按文件隔离模块），`everyCommand` 因此是「本文件启动过的
 * 可执行文件」。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const SIDECAR = fileURLToPath(new URL("../../../converter/sidecar.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../fixtures/fake-soffice.mjs", import.meta.url));
/** 夹具睡 30 秒；这里的时限远小于它，所以「已不存在」只能是被杀掉的结果。 */
const GONE_WITHIN_MS = 4_000;
export const MARKER_WITHIN_MS = 6_000;
/** 不测超时的作业：sidecar 自己的时限不该先到。 */
const LONG_TIMEOUT_MS = 20_000;
/** 低熵占位值：只用来证明 sidecar 自己的环境不进转换进程。 */
export const PARENT_ONLY = "placeholder";

type Exit = { code: number | null; signal: NodeJS.Signals | null };

export interface Sidecar {
  child: ChildProcess;
  spool: string;
  jobs: string;
  exit: Promise<Exit>;
  stderr(): string;
}

export interface FakeRecord {
  /** `x.record.json` 那样的非夹具文件里没有它。 */
  argv?: string[];
  env: Record<string, string>;
  pid: number;
  childPid?: number;
}

const roots: string[] = [];
const sidecars: Sidecar[] = [];
/** 本文件启动过的每一个可执行文件（含交给 sidecar 的 `CONVERTER_SOFFICE_BIN`）。 */
export const everyCommand: string[] = [];

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function recordsUnder(jobs: string): FakeRecord[] {
  return (existsSync(jobs) ? readdirSync(jobs) : [])
    .filter((name) => name.endsWith(".record.json"))
    .map((name) => JSON.parse(readFileSync(join(jobs, name), "utf8")) as FakeRecord);
}

/** `afterEach` 用：杀 sidecar 与它留下的每个假进程，删临时目录。 */
export function cleanUpSidecars(): void {
  for (const sidecar of sidecars.splice(0)) {
    sidecar.child.kill("SIGKILL");
    for (const record of recordsUnder(sidecar.jobs)) {
      everyCommand.push(record.argv?.[0] ?? "");
      for (const pid of [record.pid, record.childPid]) {
        if (pid !== undefined && !isGone(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function makeSpool(withJobs = true): string {
  const spool = mkdtempSync(join(tmpdir(), "wb-sidecar-"));
  roots.push(spool);
  if (withJobs) {
    mkdirSync(join(spool, "jobs"));
  }
  return spool;
}

/** 钩子辅助复现：`--import` 一段 data: 模块，在 sidecar 进程里先于脚本运行。 */
export function hook(source: string): string[] {
  return ["--import", `data:text/javascript,${encodeURIComponent(source)}`];
}

export function startSidecar(
  spool: string,
  overrides: Record<string, string | undefined> = {},
  nodeFlags: string[] = [],
): Sidecar {
  const given: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    WB_PARENT_ONLY: PARENT_ONLY,
    CONVERTER_SPOOL_DIR: spool,
    CONVERTER_SOFFICE_BIN: FAKE,
    CONVERTER_POLL_MS: "20",
    CONVERTER_HEARTBEAT_MS: "50",
    CONVERTER_CONCURRENCY: "1",
    ...overrides,
  };
  const env = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
  everyCommand.push(process.execPath, given.CONVERTER_SOFFICE_BIN ?? "");
  const child = spawn(process.execPath, [...nodeFlags, SIDECAR], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<Exit>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const sidecar: Sidecar = { child, spool, jobs: join(spool, "jobs"), exit, stderr: () => stderr };
  sidecars.push(sidecar);
  return sidecar;
}

/** 照 app 的次序写一个作业：`in/<name>` → `request.json.part` → `rename`。 */
export function writeJob(
  jobs: string,
  name: string,
  request: unknown = { version: 1, input: name, timeoutMs: LONG_TIMEOUT_MS },
  id = randomBytes(16).toString("hex"),
): string {
  const job = join(jobs, id);
  const input = join(job, "in", name);
  mkdirSync(join(input, ".."), { recursive: true });
  writeFileSync(input, "input bytes");
  writeFileSync(join(job, "request.json.part"), JSON.stringify(request));
  renameSync(join(job, "request.json.part"), join(job, "request.json"));
  return job;
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  withinMs: number,
): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `done` → `"done"`；`failed` → `failed:<内容>`；都没有 → `undefined`。 */
export function markerOf(job: string): string | undefined {
  if (existsSync(join(job, "done"))) {
    return "done";
  }
  const failed = join(job, "failed");
  return existsSync(failed) ? `failed:${readFileSync(failed, "utf8")}` : undefined;
}

export function settled(job: string): Promise<string> {
  return waitFor(`a marker in ${basename(job)}`, () => markerOf(job), MARKER_WITHIN_MS);
}

export function recordPath(job: string): string {
  return `${job}.record.json`;
}

export function readRecord(job: string): FakeRecord {
  return JSON.parse(readFileSync(recordPath(job), "utf8")) as FakeRecord;
}

/** 等 `@spawn-sleep` 记下自己与子进程的 pid。 */
export function spawnedPair(job: string): Promise<FakeRecord> {
  return waitFor(
    "the fake soffice to record its child",
    () => {
      const record = existsSync(recordPath(job)) ? readRecord(job) : undefined;
      return record?.childPid === undefined ? undefined : record;
    },
    MARKER_WITHIN_MS,
  );
}

export async function expectGone(record: FakeRecord): Promise<void> {
  const pids = [record.pid, record.childPid ?? Number.NaN];
  await waitFor(
    `processes ${pids.join(", ")} to disappear`,
    () => (pids.every(isGone) ? true : undefined),
    GONE_WITHIN_MS,
  );
}

export function linesOf(sidecar: Sidecar): Record<string, unknown>[] {
  const lines = sidecar.stderr().split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

export function lineFor(sidecar: Sidecar, job: string): Promise<Record<string, unknown>> {
  const probe = () => linesOf(sidecar).find((line) => line.id === basename(job));
  return waitFor("the log line", probe, 2_000);
}

/** 「真实转换的人工验证」：本文件启动过的可执行文件没有一个名为 soffice、libreoffice 或 docker。 */
export function expectNoRealConverter(): void {
  const names = new Set(everyCommand.map((command) => basename(command)));
  for (const forbidden of ["soffice", "libreoffice", "docker"]) {
    expect(names.has(forbidden)).toBe(false);
  }
  expect(names.has(basename(process.execPath))).toBe(true);
  expect(names.has("fake-soffice.mjs")).toBe(true);
}
