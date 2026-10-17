/**
 * Issue #1504：转换 sidecar 脚本（office-preview「转换 sidecar 实现与镜像」场景「sidecar 脚本对着
 * 假 soffice」；「转换隔离边界」第 4、5 条的 sidecar 一侧）。
 *
 * 以子进程启动 `node converter/sidecar.mjs`（它是守护进程，有顶层副作用，所以从不 import），
 * `CONVERTER_SOFFICE_BIN` 指向 `fixtures/fake-soffice.mjs`；测试充当 app：在临时 spool 的 `jobs/`
 * 下建作业目录、经 `.part` + `rename` 写出 `request.json`，再读 sidecar 写回的 `done` / `failed`。
 * 「杀整组」用夹具既有的 `@spawn-sleep` 标记：它派生一个同进程组的子进程并把两个 pid 记进
 * `jobs/<id>.record.json`。期望的 argv、PDF 字节与日志行是照规格抄的字面量，不引用脚本常量。
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const SIDECAR = fileURLToPath(new URL("../../converter/sidecar.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-soffice.mjs", import.meta.url));
/** 假 soffice 正常转换写出的全部字节（与夹具各持一份字面量）。 */
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
/** 夹具睡 30 秒；这里的时限远小于它，所以「已不存在」只能是被杀掉的结果。 */
const GONE_WITHIN_MS = 4_000;
const MARKER_WITHIN_MS = 6_000;
/** 不测超时的作业：sidecar 自己的时限不该先到。 */
const LONG_TIMEOUT_MS = 20_000;
/** 每例的时限：大于上面的等待之和，先报错的是带说明的那个。 */
vi.setConfig({ testTimeout: 15_000 });
/** 低熵占位值：只用来证明 sidecar 自己的环境不进转换进程。 */
const PARENT_ONLY = "placeholder";
const LOG_KEYS = ["event", "id", "result", "reason", "ms"];

type Exit = { code: number | null; signal: NodeJS.Signals | null };

interface Sidecar {
  child: ChildProcess;
  spool: string;
  jobs: string;
  exit: Promise<Exit>;
  stderr(): string;
}

interface FakeRecord {
  /** `x.record.json` 那样的非夹具文件里没有它。 */
  argv?: string[];
  env: Record<string, string>;
  pid: number;
  childPid?: number;
}

const roots: string[] = [];
const sidecars: Sidecar[] = [];
/** 本文件启动过的每一个可执行文件（含交给 sidecar 的 `CONVERTER_SOFFICE_BIN`），给文末断言用。 */
const everyCommand: string[] = [];

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

afterEach(() => {
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
});

function makeSpool(withJobs = true): string {
  const spool = mkdtempSync(join(tmpdir(), "wb-sidecar-"));
  roots.push(spool);
  if (withJobs) {
    mkdirSync(join(spool, "jobs"));
  }
  return spool;
}

function startSidecar(
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
  const sidecar: Sidecar = {
    child,
    spool,
    jobs: join(spool, "jobs"),
    exit,
    stderr: () => stderr,
  };
  sidecars.push(sidecar);
  return sidecar;
}

/** 照 app 的次序写一个作业：`in/<name>` → `request.json.part` → `rename`。 */
function writeJob(
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

async function waitFor<T>(what: string, probe: () => T | undefined, withinMs: number): Promise<T> {
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
function markerOf(job: string): string | undefined {
  if (existsSync(join(job, "done"))) {
    return "done";
  }
  const failed = join(job, "failed");
  return existsSync(failed) ? `failed:${readFileSync(failed, "utf8")}` : undefined;
}

function settled(job: string): Promise<string> {
  return waitFor(`a marker in ${basename(job)}`, () => markerOf(job), MARKER_WITHIN_MS);
}

function recordPath(job: string): string {
  return `${job}.record.json`;
}

function readRecord(job: string): FakeRecord {
  return JSON.parse(readFileSync(recordPath(job), "utf8")) as FakeRecord;
}

/** 等 `@spawn-sleep` 记下自己与子进程的 pid。 */
function spawnedPair(job: string): Promise<FakeRecord> {
  return waitFor(
    "the fake soffice to record its child",
    () => {
      const record = existsSync(recordPath(job)) ? readRecord(job) : undefined;
      return record?.childPid === undefined ? undefined : record;
    },
    MARKER_WITHIN_MS,
  );
}

async function expectGone(record: FakeRecord): Promise<void> {
  const pids = [record.pid, record.childPid ?? Number.NaN];
  await waitFor(
    `processes ${pids.join(", ")} to disappear`,
    () => (pids.every(isGone) ? true : undefined),
    GONE_WITHIN_MS,
  );
}

function contractArgs(job: string, name: string): string[] {
  const head = "--headless --norestore --nolockcheck --nodefault --nofirststartwizard".split(" ");
  const profile = `-env:UserInstallation=file://${job}/profile`;
  return [...head, profile, "--convert-to", "pdf", "--outdir", `${job}/out`, `${job}/in/${name}`];
}

/** macOS 给每个新进程注入 `__CF_USER_TEXT_ENCODING`；它不是 sidecar 传过去的。 */
const childEnv = ({ env: { __CF_USER_TEXT_ENCODING: _injected, ...env } }: FakeRecord) => env;

/** 运行中进程的工作目录：Linux 读 `/proc`，macOS 问 `lsof`。 */
function cwdOf(pid: number): string {
  if (process.platform === "linux") {
    return readlinkSync(`/proc/${pid}/cwd`);
  }
  everyCommand.push("lsof");
  const out = execFileSync("lsof", ["-a", "-p", `${pid}`, "-d", "cwd", "-Fn"]).toString();
  const line = out.split("\n").find((entry) => entry.startsWith("n"));
  return line?.slice(1) ?? "";
}

function linesOf(sidecar: Sidecar): Record<string, unknown>[] {
  const lines = sidecar.stderr().split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

function lineFor(sidecar: Sidecar, job: string): Promise<Record<string, unknown>> {
  const probe = () => linesOf(sidecar).find((line) => line.id === basename(job));
  return waitFor("the log line", probe, 2_000);
}

describe("sidecar 脚本：正常转换", () => {
  it("报告.docx：done、PDF 字节、argv 恰为参数集、环境恰为 PATH/HOME/LANG、日志一行不含输入名", async () => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, "报告.docx");

    expect(await settled(job)).toBe("done");
    expect(readFileSync(join(job, "done"), "utf8")).toBe("");
    expect(readFileSync(join(job, "out", "报告.pdf"), "utf8")).toBe(PDF);
    const record = readRecord(job);
    expect(basename(record.argv?.[0] ?? "")).toBe("fake-soffice.mjs");
    expect(record.argv?.slice(1)).toEqual(contractArgs(job, "报告.docx"));
    expect(childEnv(record)).toEqual({ PATH: process.env.PATH, HOME: job, LANG: "C.UTF-8" });
    expect(JSON.stringify(record.env)).not.toContain(PARENT_ONLY);
    const lines = await lineFor(sidecar, job);
    expect(Object.keys(lines)).toEqual(LOG_KEYS);
    expect(lines).toMatchObject({ event: "convert", result: "done", reason: "" });
    expect(Number.isInteger(lines.ms)).toBe(true);
    expect(linesOf(sidecar)).toHaveLength(1);
    expect(sidecar.stderr()).not.toContain("报告");
    expect(sidecar.stderr()).not.toContain(sidecar.spool);
  });

  it("sidecar 自己没有 LANG 时转换进程的环境恰为 PATH 与 HOME", async () => {
    const sidecar = startSidecar(makeSpool(), { LANG: undefined });
    const job = writeJob(sidecar.jobs, "a.xlsx");

    expect(await settled(job)).toBe("done");
    expect(childEnv(readRecord(job))).toEqual({ PATH: process.env.PATH, HOME: job });
  });

  it.each([
    ["@exit1.docx", "failed:exit"],
    ["@empty.docx", "failed:no-output"],
    ["@no-output.pptx", "failed:no-output"],
    ["@symlink.docx", "failed:no-output"],
    ["@self-kill.docx", "failed:signal"],
  ])("%s → %s，日志行同一原因码", async (name, expected) => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, name);

    expect(await settled(job)).toBe(expected);
    const line = await lineFor(sidecar, job);
    expect(line).toMatchObject({ result: "failed", reason: expected.slice("failed:".length) });
    expect(sidecar.stderr()).not.toContain(name);
  });
});

describe("sidecar 脚本：request.json 严格校验", () => {
  it.each([
    ["缺键", "a.docx", { version: 1, input: "a.docx" }],
    ["多键", "a.docx", { version: 1, input: "a.docx", timeoutMs: 1000, path: "/x" }],
    ["input 含 /", "sub/a.docx", { version: 1, input: "sub/a.docx", timeoutMs: 1000 }],
    ["input 为 ..", "a.docx", { version: 1, input: "..", timeoutMs: 1000 }],
    ["扩展名 html", "a.html", { version: 1, input: "a.html", timeoutMs: 1000 }],
    ["timeoutMs 为 0", "a.docx", { version: 1, input: "a.docx", timeoutMs: 0 }],
    ["timeoutMs 为字符串", "a.docx", { version: 1, input: "a.docx", timeoutMs: "1000" }],
  ])("%s → failed 内容恰为 bad-request，假 soffice 零记录", async (_case, name, request) => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, name, request);

    expect(await settled(job)).toBe("failed:bad-request");
    expect(existsSync(recordPath(job))).toBe(false);
    expect(existsSync(join(job, "out"))).toBe(false);
  });
});

describe("sidecar 脚本：杀整组", () => {
  it("@spawn-sleep 且 timeoutMs 200 → timeout，假 soffice 与派生的子进程在有界时间内不存在", async () => {
    const sidecar = startSidecar(makeSpool());
    const name = "a@spawn-sleep.docx";
    const job = writeJob(sidecar.jobs, name, { version: 1, input: name, timeoutMs: 200 });

    const record = await spawnedPair(job);
    expect(await settled(job)).toBe("failed:timeout");
    await expectGone(record);
  });

  it("@spawn-sleep 且随后写 cancel → cancelled，工作目录是作业目录，整组在有界时间内不存在", async () => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, "a@spawn-sleep.docx");

    const record = await spawnedPair(job);
    expect(realpathSync(cwdOf(record.pid))).toBe(realpathSync(job));
    writeFileSync(join(job, "cancel"), "", { flag: "wx" });
    expect(await settled(job)).toBe("failed:cancelled");
    await expectGone(record);
  });

  it("@spawn-sleep 的作业目录在落定前被整个删除 → 整组不存在、sidecar 不退出、日志记 cancelled、随后的作业照常", async () => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, "a@spawn-sleep.docx");

    const record = await spawnedPair(job);
    rmSync(job, { recursive: true, force: true });
    await expectGone(record);
    const line = await lineFor(sidecar, job);
    expect(line).toMatchObject({ result: "failed", reason: "cancelled" });
    expect(existsSync(job)).toBe(false);

    const next = writeJob(sidecar.jobs, "b.docx");
    expect(await settled(next)).toBe("done");
    expect(sidecar.child.exitCode).toBeNull();
    expect(sidecar.child.signalCode).toBeNull();
  });

  it("SIGTERM → 在途作业的进程组被杀，sidecar 以 0 退出", async () => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, "a@spawn-sleep.docx");

    const record = await spawnedPair(job);
    sidecar.child.kill("SIGTERM");
    expect(await sidecar.exit).toEqual({ code: 0, signal: null });
    await expectGone(record);
  });
});

describe("sidecar 脚本：领取、并发、心跳与 jobs/", () => {
  it("并发 1：两个作业按 request.json 的 mtime 次序，第二个在第一个落定后才启动", async () => {
    const spool = makeSpool();
    const jobs = join(spool, "jobs");
    // 名字的字母序与 mtime 次序相反：按名字领取的实现先启动 later。
    const first = writeJob(jobs, "a@gate.docx", undefined, "f".repeat(32));
    const later = writeJob(jobs, "b.docx", undefined, "0".repeat(32));
    const now = Date.now() / 1000;
    utimesSync(join(first, "request.json"), now - 2, now - 2);
    utimesSync(join(later, "request.json"), now - 1, now - 1);
    startSidecar(spool);

    await waitFor("the first job to start", () => existsSync(recordPath(first)) || undefined, 6e3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(recordPath(later))).toBe(false);
    expect(markerOf(later)).toBeUndefined();
    writeFileSync(join(first, "in", "a@gate.docx.release"), "");

    expect(await settled(first)).toBe("done");
    expect(await settled(later)).toBe("done");
    const laterStarted = statSync(recordPath(later)).mtimeMs;
    expect(laterStarted).toBeGreaterThanOrEqual(statSync(join(first, "done")).mtimeMs);
  });

  it("jobs/ 下的普通文件被跳过、不产生日志行，作业照常", async () => {
    const spool = makeSpool();
    writeFileSync(join(spool, "jobs", "x.record.json"), "{}");
    const sidecar = startSidecar(spool);
    const job = writeJob(sidecar.jobs, "a.docx");

    expect(await settled(job)).toBe("done");
    await lineFor(sidecar, job);
    expect(linesOf(sidecar).map((line) => line.id)).toEqual([basename(job)]);
    expect(readFileSync(join(spool, "jobs", "x.record.json"), "utf8")).toBe("{}");
  });

  it("heartbeat：已存在的旧心跳在启动时被 touch，之后按 50 ms 周期持续更新", async () => {
    const spool = makeSpool();
    const heartbeat = join(spool, "heartbeat");
    writeFileSync(heartbeat, "");
    const old = Date.now() / 1000 - 30;
    utimesSync(heartbeat, old, old);
    startSidecar(spool);

    const fresh = () => Date.now() - statSync(heartbeat).mtimeMs < 1_000 || undefined;
    await waitFor("a fresh heartbeat", fresh, 6_000);
    const seen = new Set<number>();
    let oldest = 0;
    const until = Date.now() + 600;
    while (Date.now() < until) {
      const mtime = statSync(heartbeat).mtimeMs;
      seen.add(mtime);
      oldest = Math.max(oldest, Date.now() - mtime);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(oldest).toBeLessThan(400);
    expect(readdirSync(spool).sort()).toEqual(["heartbeat", "jobs"]);
  });

  it("jobs/ 在 sidecar 启动 300 ms 后才建出：此前不崩、不替 app 建目录，建出后的作业照常", async () => {
    const spool = makeSpool(false);
    const sidecar = startSidecar(spool);
    await waitFor("the heartbeat", () => existsSync(join(spool, "heartbeat")) || undefined, 6e3);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(sidecar.child.exitCode).toBeNull();
    expect(existsSync(sidecar.jobs)).toBe(false);
    mkdirSync(sidecar.jobs);
    const job = writeJob(sidecar.jobs, "a.docx");
    expect(await settled(job)).toBe("done");
  });
});

/**
 * 写标记变慢的钩子（钩子辅助复现）：`--import` 一段 data: 模块，把 sidecar 进程里的 `writeFileSync`
 * 换成「先打开（文件此刻已存在且为空）→ 等 100 ms → 写入」。标记若直接写到最终名字，紧循环在这
 * 100 ms 里必然读到空的 `failed`；先写 `.part` 再 `rename` 时最终名字一出现内容就是完整的。
 */
const SLOW_WRITES = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.writeFileSync = (path, data, options) => {
  const flag = (typeof options === "object" && options !== null && options.flag) || "w";
  const fd = fs.openSync(path, flag);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fs.writeSync(fd, String(data));
  } finally {
    fs.closeSync(fd);
  }
};
syncBuiltinESMExports();
`;

describe("sidecar 脚本：标记的原子性", () => {
  it("紧循环读作业目录直到 failed 出现：最终名字一出现内容就完整，此后不变", async () => {
    const sidecar = startSidecar(makeSpool(), {}, [
      "--import",
      `data:text/javascript,${encodeURIComponent(SLOW_WRITES)}`,
    ]);
    const job = writeJob(sidecar.jobs, "@exit1.docx");

    const contents: string[] = [];
    const deadline = Date.now() + MARKER_WITHIN_MS;
    let extra = 50;
    while (Date.now() < deadline && extra > 0) {
      if (readdirSync(job).includes("failed")) {
        contents.push(readFileSync(join(job, "failed"), "utf8"));
        extra -= 1;
      }
    }
    expect(contents.length).toBeGreaterThan(0);
    expect(new Set(contents)).toEqual(new Set(["exit"]));
  });
});

describe("sidecar 脚本：启动与 spawn 失败不被吞掉", () => {
  it("CONVERTER_CONCURRENCY 不是正整数：以非 0 退出，一行不含路径的记录，不建心跳", async () => {
    const spool = makeSpool();
    const sidecar = startSidecar(spool, { CONVERTER_CONCURRENCY: "0" });

    expect((await sidecar.exit).code).toBe(1);
    expect(linesOf(sidecar)).toEqual([{ event: "fatal", reason: "config" }]);
    expect(existsSync(join(spool, "heartbeat"))).toBe(false);
  });

  it("CONVERTER_SOFFICE_BIN 不存在：spawn 错误让 sidecar 以非 0 退出，作业没有 done", async () => {
    const spool = makeSpool();
    const sidecar = startSidecar(spool, { CONVERTER_SOFFICE_BIN: join(spool, "no-soffice") });
    const job = writeJob(sidecar.jobs, "a.docx");

    expect((await sidecar.exit).code).toBe(1);
    expect(linesOf(sidecar)).toEqual([{ event: "fatal", reason: "spawn", code: "ENOENT" }]);
    expect(markerOf(job)).toBeUndefined();
  });
});

describe("真实转换的人工验证：自动化测试不需要 LibreOffice 与 Docker", () => {
  it("本文件启动过的可执行文件（含 sidecar 启动的）没有一个名为 soffice、libreoffice 或 docker", () => {
    const names = new Set(everyCommand.map((command) => basename(command)));
    for (const forbidden of ["soffice", "libreoffice", "docker"]) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect(names.has(basename(process.execPath))).toBe(true);
    expect(names.has("fake-soffice.mjs")).toBe(true);
  });
});
