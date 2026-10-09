/**
 * Issue #1071：办公文档转换器的单次转换契约（office-preview「转换器调用契约」的六个场景，以及
 * 「真实转换的人工验证」里的「自动化测试不需要 LibreOffice」）。
 *
 * 全部用例对着 `fixtures/fake-soffice.mjs` 真实 spawn；注入的 spawn 包装器记录每次启动的命令、
 * argv、选项与 `ChildProcess`，是「恰启动一次」「命令为 sudo」「被 SIGKILL 结束」的判据。假 `sudo`
 * 是临时 bin 目录里名为 `sudo`、指向同一个夹具的符号链接，靠 `PATH` 首项命中——从不执行真的
 * `sudo`，包装器在启动前复核这一点。期望的 argv 与 PDF 字节是照规格抄的字面量，不引用源码常量。
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficeConverter, OfficeConvertError } from "../src/preview/office.js";
import { stubSetpriv, useSetprivStub } from "./support/setpriv.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-soffice.mjs", import.meta.url));
/** 假 soffice 正常转换写出的全部字节（与夹具各持一份字面量）。 */
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_32_PDF = /^[0-9a-f]{32}\.pdf$/u;
/** 夹具睡 30 秒；这里的时限远小于它，所以「已不存在」只能是被杀掉的结果。 */
const GONE_WITHIN_MS = 4_000;
const RECORD_WITHIN_MS = 6_000;
/** 转换器自己的超时：不测超时的用例里它不该先到。 */
const LONG_TIMEOUT_MS = 20_000;
/** 等记录、等进程消失的两组用例的单测时限：大于上面两个等待之和，先报错的是带说明的那个。 */
const SLOW_TEST_MS = 15_000;
/** 低熵占位值：只用来证明父环境里的键不进子进程。 */
const PARENT_ONLY = { MODEL_UPSTREAM_API_KEY: "placeholder", DB_PATH: "/placeholder/app.db" };

interface Launch {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: ChildProcess;
}

interface FakeRecord {
  argv: string[];
  env: Record<string, string>;
  pid: number;
  childPid?: number;
}

interface Stage {
  cacheDir: string;
  work: string;
  pdf: string;
  /** 假 `sudo` 所在的临时 bin 目录。 */
  bin: string;
  launches: Launch[];
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  /** 在「工作空间」里写一个输入文件，返回它的绝对路径。 */
  input(name: string, content?: string): string;
}

type Converter = ReturnType<typeof createOfficeConverter>;

const roots: string[] = [];
const converters: Converter[] = [];
const stages: Stage[] = [];
/** 整个文件里启动过的每一个命令，给「不需要 LibreOffice」用。 */
const everyCommand: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** 作业目录里可能留着 0500 的子目录：先放开权限再删。 */
function unlock(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = join(dir, entry.name);
      chmodSync(child, 0o700);
      unlock(child);
    }
  }
}

useSetprivStub();

afterEach(async () => {
  await Promise.all(converters.splice(0).map((converter) => converter.close()));
  const alive = stages
    .splice(0)
    .flatMap((stage) => stage.launches)
    .filter(({ child }) => child.pid !== undefined && isRunning(child));
  for (const { child } of alive) {
    child.kill("SIGKILL");
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  }
  expect(alive.map(({ child }) => child.pid)).toEqual([]);
});

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** 缓存目录的三层由调用方（15.1 的入口）建；这里照它的权限位建出来。 */
function stage(layout: { work: boolean } = { work: true }): Stage {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-converter-")));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const work = join(cacheDir, "work");
  const pdf = join(cacheDir, "pdf");
  const ws = join(root, "ws");
  const bin = join(root, "bin");
  for (const dir of [cacheDir, pdf, ws, bin]) {
    mkdirSync(dir, 0o700);
  }
  if (layout.work) {
    mkdirSync(work);
    chmodSync(work, 0o2770);
  }
  symlinkSync(FAKE, join(bin, "sudo"));
  const launches: Launch[] = [];
  const created: Stage = {
    cacheDir,
    work,
    pdf,
    bin,
    launches,
    spawn(command, args, options) {
      // 真的 sudo 一次都不许跑：命令是裸名时，子进程环境的 PATH 首项必须是放着假 sudo 的目录。
      const path = options.env?.PATH ?? "";
      if (!command.includes("/") && !path.startsWith(`${bin}:`)) {
        throw new Error(`refusing to resolve ${command} outside the test bin dir`);
      }
      const child = spawn(command, [...args], options);
      launches.push({ command, args, options, child });
      everyCommand.push(command);
      return child;
    },
    input(name, content = "not a real office document") {
      const path = join(ws, name);
      writeFileSync(path, content);
      return path;
    },
  };
  stages.push(created);
  return created;
}

function converterFor(
  on: Stage,
  overrides: { officeBin?: string | null; timeoutMs?: number; ompUser?: string } = {},
): Converter {
  const { officeBin = FAKE, timeoutMs = LONG_TIMEOUT_MS, ompUser } = overrides;
  const converter = createOfficeConverter({
    ...(officeBin === null ? {} : { officeBin }),
    cacheDir: on.cacheDir,
    timeoutMs,
    ...(ompUser === undefined ? {} : { ompUser }),
    spawn: on.spawn,
  });
  converters.push(converter);
  return converter;
}

/** 假 sudo 靠 PATH 首项命中；`#!/usr/bin/env node` 还需要 node 所在目录。 */
function useFakeSudo(on: Stage): void {
  setEnv("PATH", `${on.bin}:${dirname(process.execPath)}:/usr/bin:/bin`);
}

/** 契约所列的 argv（自 `officeBin` 之后的部分）。 */
function contractArgs(job: string, input: string): string[] {
  return [
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--nofirststartwizard",
    `-env:UserInstallation=file://${job}/profile`,
    "--convert-to",
    "pdf",
    "--outdir",
    `${job}/out`,
    input,
  ];
}

function sudoPrefix(user: string): string[] {
  return [
    "-n",
    "-u",
    user,
    "--preserve-env=PATH,LANG,HOME",
    "--",
    "/usr/bin/setpriv",
    "--pdeathsig",
    "KILL",
    "--",
    FAKE,
  ];
}

function jobOf(launch: Launch | undefined): string {
  const cwd = launch?.options.cwd;
  if (typeof cwd !== "string") {
    throw new Error("the launch has no job directory");
  }
  return cwd;
}

function recordPath(job: string): string {
  return join(dirname(job), `${basename(job)}.record.json`);
}

function readRecord(job: string): FakeRecord {
  return JSON.parse(readFileSync(recordPath(job), "utf8")) as FakeRecord;
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

/** 等假进程把记录写出来（`needChild` 时还要等它记下子进程的 pid）。 */
async function waitForRecord(on: Stage, needChild = false): Promise<FakeRecord> {
  return waitFor(
    "the fake process record",
    () => {
      const launch = on.launches[0];
      if (launch === undefined || !existsSync(recordPath(jobOf(launch)))) {
        return undefined;
      }
      const record = readRecord(jobOf(launch));
      return needChild && record.childPid === undefined ? undefined : record;
    },
    RECORD_WITHIN_MS,
  );
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** 全部 pid 共用一个时限。 */
async function expectGone(pids: Array<number | undefined>): Promise<void> {
  const known = pids.filter((pid) => pid !== undefined);
  if (known.length !== pids.length) {
    throw new Error("a pid that should have been recorded is missing");
  }
  await waitFor(
    `processes ${known.join(", ")} to disappear`,
    () => (known.every(isGone) ? true : undefined),
    GONE_WITHIN_MS,
  );
}

/** 转换器经 `process.kill` 发出的信号（不含探测存活用的信号 0）。 */
function signalsSent(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(([, signal]) => signal !== 0);
}

async function failureOf(attempt: Promise<string>): Promise<OfficeConvertError> {
  const outcome = await attempt.then(
    (path) => ({ path }),
    (error: unknown) => ({ error }),
  );
  if (!("error" in outcome)) {
    throw new Error(`convert unexpectedly settled with ${outcome.path}`);
  }
  expect(outcome.error).toBeInstanceOf(OfficeConvertError);
  return outcome.error as OfficeConvertError;
}

/** 错误对象只带种类：message 恒等于 kind，没有 cause，自有属性只有 kind 与固定的 name。 */
function expectBareKind(error: OfficeConvertError, kind: string, forbidden: string[]): void {
  expect(error.kind).toBe(kind);
  expect(error.message).toBe(kind);
  expect(error.cause).toBeUndefined();
  expect(error.name).toBe("OfficeConvertError");
  expect(Object.keys(error).sort()).toEqual(["kind", "name"]);
  for (const path of forbidden) {
    expect(error.message).not.toContain(path);
    expect(JSON.stringify(error)).not.toContain(path);
  }
}

function dirsIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** 「缓存目录里没有新增文件」：`pdf/` 为空，`work/` 下没有目录（只可能剩假进程的记录文件）。 */
function expectNothingLeft(on: Stage): void {
  expect(readdirSync(on.pdf)).toEqual([]);
  expect(dirsIn(on.work)).toEqual([]);
}

describe("转换器调用契约：argv、环境与成功判定", () => {
  it("假 soffice 收到的 argv 与环境恰为契约所列，结果是复制进 pdf/ 的新文件，作业目录已不存在", async () => {
    const on = stage();
    for (const [key, value] of Object.entries(PARENT_ONLY)) {
      setEnv(key, value);
    }
    setEnv("LANG", "C.UTF-8");
    const input = on.input("报告 v2.docx");
    const converter = converterFor(on);
    expect(converter.available).toBe(true);

    const result = await converter.convert(input);

    expect(on.launches).toHaveLength(1);
    const [launch] = on.launches;
    const job = jobOf(launch);
    expect(dirname(job)).toBe(on.work);
    expect(basename(job)).toMatch(HEX_32);
    expect(launch?.command).toBe(FAKE);
    expect(launch?.args).toEqual(contractArgs(job, input));
    expect(launch?.options).toEqual({
      cwd: job,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: job },
      stdio: "ignore",
      shell: false,
      detached: true,
    });

    const record = readRecord(job);
    expect(record.argv.slice(1)).toEqual(contractArgs(job, input));
    // macOS 的运行时会给每个进程塞这一个键；它不是转换器传的。
    const { __CF_USER_TEXT_ENCODING: _injected, ...childEnv } = record.env;
    expect(childEnv).toEqual({ PATH: process.env.PATH, LANG: "C.UTF-8", HOME: job });
    expect(JSON.stringify(record.env)).not.toContain("placeholder");

    expect(dirname(result)).toBe(on.pdf);
    expect(basename(result)).toMatch(HEX_32_PDF);
    expect(readFileSync(result, "utf8")).toBe(PDF);
    const stats = lstatSync(result);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o7777).toBe(0o600);
    expect(stats.uid).toBe(process.geteuid?.());
    expect(readdirSync(on.pdf)).toEqual([basename(result)]);
    expect(existsSync(job)).toBe(false);
    expect(dirsIn(on.work)).toEqual([]);
  });

  it("父进程没有 LANG 时子进程环境里也没有这个键", async () => {
    const on = stage();
    setEnv("LANG", undefined);

    await converterFor(on).convert(on.input("a.docx"));

    const [launch] = on.launches;
    const job = jobOf(launch);
    expect(launch?.options.env).toEqual({ PATH: process.env.PATH, HOME: job });
    const { __CF_USER_TEXT_ENCODING: _injected, ...childEnv } = readRecord(job).env;
    expect(Object.keys(childEnv).sort()).toEqual(["HOME", "PATH"]);
  });

  it("每次转换用各自新建的作业目录与 UserInstallation，结果互不覆盖", async () => {
    const on = stage();
    const converter = converterFor(on);
    const input = on.input("表格.xlsx");

    const first = await converter.convert(input);
    const second = await converter.convert(input);

    expect(on.launches).toHaveLength(2);
    const jobs = on.launches.map(jobOf);
    expect(new Set(jobs).size).toBe(2);
    expect(on.launches.map(({ args }) => args[5])).toEqual(
      jobs.map((job) => `-env:UserInstallation=file://${job}/profile`),
    );
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe(PDF);
    expect(readFileSync(second, "utf8")).toBe(PDF);
  });

  it("输入文件名有多个点时只去掉最后一个扩展名", async () => {
    const on = stage();
    // 假 soffice 把 PDF 写到输入内容给出的名字上；转换器找的不是这个名字就拿不到输出。
    const input = on.input("report.v2@named.tar.docx", "report.v2@named.tar.pdf");

    const result = await converterFor(on).convert(input);

    expect(on.launches[0]?.child.exitCode).toBe(0);
    expect(readFileSync(result, "utf8")).toBe(PDF);
  });

  it.skipIf(process.geteuid?.() === 0)(
    "作业目录里有删不掉的残留时转换仍然成功，结果可读",
    async () => {
      const on = stage();

      const result = await converterFor(on).convert(on.input("a@locked-dir.docx"));

      expect(readFileSync(result, "utf8")).toBe(PDF);
      // 删除确实失败过：0500 的非空子目录还在。
      expect(existsSync(join(jobOf(on.launches[0]), "locked", "keep"))).toBe(true);
    },
  );
});

describe("转换器调用契约：sudo 前缀", () => {
  it("提供 ompUser 时启动的命令是 sudo，argv 以契约的前缀开头，不以新进程组启动", async () => {
    const on = stage();
    useFakeSudo(on);
    setEnv("LANG", "C.UTF-8");
    for (const [key, value] of Object.entries(PARENT_ONLY)) {
      setEnv(key, value);
    }
    const input = on.input("报告.docx");

    const result = await converterFor(on, { ompUser: "omp" }).convert(input);

    expect(on.launches).toHaveLength(1);
    const [launch] = on.launches;
    const job = jobOf(launch);
    expect(launch?.command).toBe("sudo");
    expect(launch?.args).toEqual([...sudoPrefix("omp"), ...contractArgs(job, input)]);
    expect(launch?.options).toEqual({
      cwd: job,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: job },
      stdio: "ignore",
      shell: false,
      detached: false,
    });
    // 被启动的确实是临时 bin 目录里的假 sudo，它自身的环境也只有这三个键。
    const record = readRecord(job);
    expect(record.argv[0]).toBe(join(on.bin, "sudo"));
    const { __CF_USER_TEXT_ENCODING: _injected, ...sudoEnv } = record.env;
    expect(sudoEnv).toEqual({ PATH: process.env.PATH, LANG: "C.UTF-8", HOME: job });
    expect(JSON.stringify(record.env)).not.toContain("placeholder");
    expect(readFileSync(result, "utf8")).toBe(PDF);
  });

  it("sudo 立即失败就是转换失败，不回退为直接启动 officeBin", async () => {
    const on = stage();
    useFakeSudo(on);
    const input = on.input("a@exit1.docx");

    const error = await failureOf(converterFor(on, { ompUser: "omp" }).convert(input));

    expectBareKind(error, "failed", [input, on.cacheDir]);
    expect(on.launches.map(({ command }) => command)).toEqual(["sudo"]);
    expectNothingLeft(on);
  });

  it("setpriv 不可执行或 PATH 不是绝对路径时不启动任何进程，也不建作业目录", async () => {
    const on = stage();
    useFakeSudo(on);
    const converter = converterFor(on, { ompUser: "omp" });
    const input = on.input("a.docx");

    const missing = stubSetpriv("ENOENT");
    try {
      expectBareKind(await failureOf(converter.convert(input)), "failed", [input, on.cacheDir]);
    } finally {
      missing.restore();
    }
    setEnv("PATH", "relative-bin:/usr/bin");
    expectBareKind(await failureOf(converter.convert(input)), "failed", [input, on.cacheDir]);

    expect(on.launches).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
  });
});

describe("转换器调用契约：各类失败", () => {
  it.each([
    ["以退出码 1 结束", "a@exit1.docx", 1],
    ["写出完好的 PDF 后以退出码 2 结束", "a@exit2.docx", 2],
    ["以 0 结束但不写输出", "a@no-output.docx", 0],
    ["写出 0 字节的 PDF", "a@empty.docx", 0],
    ["把输出写成指向别处的符号链接", "a@symlink.docx", 0],
    ["把输出写成命名管道", "a@fifo.docx", 0],
  ])(
    "假 soffice %s：failed，作业目录被删，缓存里没有新增文件，错误不含路径",
    async (_case, name, exitCode) => {
      const on = stage();
      const input = on.input(name);

      const error = await failureOf(converterFor(on).convert(input));

      expect(on.launches).toHaveLength(1);
      expect(on.launches[0]?.child.exitCode).toBe(exitCode);
      expectBareKind(error, "failed", [input, jobOf(on.launches[0]), on.cacheDir]);
      expectNothingLeft(on);
    },
  );

  it("假 soffice 写出完好的 PDF 后被信号结束：failed，转换器没有发信号，缓存里没有新增文件", async () => {
    const on = stage();
    const kill = vi.spyOn(process, "kill");
    const input = on.input("a@self-kill.docx");

    const error = await failureOf(converterFor(on).convert(input));

    expect(on.launches).toHaveLength(1);
    const child = on.launches[0]?.child;
    expect(child?.signalCode).toBe("SIGTERM");
    expect(child?.exitCode).toBeNull();
    // 信号是假进程自己发给自己的，不是转换器发的。
    expect(signalsSent(kill)).toEqual([]);
    expectBareKind(error, "failed", [input, jobOf(on.launches[0]), on.cacheDir]);
    expectNothingLeft(on);
  });

  it("officeBin 指向不存在的文件：failed，作业目录被删，缓存里没有新增文件", async () => {
    const on = stage();
    const input = on.input("a.docx");
    const absent = join(on.bin, "absent-office-bin");

    const error = await failureOf(converterFor(on, { officeBin: absent }).convert(input));

    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.child.pid).toBeUndefined();
    expectBareKind(error, "failed", [input, jobOf(on.launches[0]), on.cacheDir, absent]);
    expectNothingLeft(on);
  });

  it("officeBin 不存在时中止：没有 pid 可杀，不发任何信号", async () => {
    const on = stage();
    const kill = vi.spyOn(process, "kill");
    const abort = new AbortController();
    const absent = join(on.bin, "absent-office-bin");

    const attempt = converterFor(on, { officeBin: absent }).convert(
      on.input("a.docx"),
      abort.signal,
    );
    // spawn 已经返回、error 事件还没到：此刻 child.pid 是 undefined。
    abort.abort();
    const error = await failureOf(attempt);

    expect(on.launches[0]?.child.pid).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    expectBareKind(error, "aborted", [on.cacheDir]);
    expectNothingLeft(on);
  });

  it("work/ 不存在：failed，不启动进程（本模块不替调用方建目录）", async () => {
    const on = stage({ work: false });
    const input = on.input("a.docx");

    const error = await failureOf(converterFor(on).convert(input));

    expectBareKind(error, "failed", [input, on.cacheDir]);
    expect(on.launches).toEqual([]);
    expect(existsSync(on.work)).toBe(false);
    expect(readdirSync(on.pdf)).toEqual([]);
  });

  it("pdf/ 不存在：进程成功也算 failed，作业目录照删", async () => {
    const on = stage();
    rmSync(on.pdf, { recursive: true });
    const input = on.input("a.docx");

    const error = await failureOf(converterFor(on).convert(input));

    expectBareKind(error, "failed", [input, on.cacheDir]);
    expect(on.launches[0]?.child.exitCode).toBe(0);
    expect(dirsIn(on.work)).toEqual([]);
    expect(existsSync(on.pdf)).toBe(false);
  });
});

describe("转换器调用契约：超时与中止（同 uid 模式）", { timeout: SLOW_TEST_MS }, () => {
  it("超时：timeout，假进程及其子进程都已不存在，作业目录被删", async () => {
    const on = stage();
    const kill = vi.spyOn(process, "kill");
    const attempt = failureOf(
      converterFor(on, { timeoutMs: 2_000 }).convert(on.input("a@spawn-sleep.docx")),
    );

    const record = await waitForRecord(on, true);
    const error = await attempt;

    expectBareKind(error, "timeout", [on.cacheDir]);
    expect(on.launches).toHaveLength(1);
    const [launch] = on.launches;
    expect(launch?.child.pid).toBe(record.pid);
    expect(launch?.child.signalCode).toBe("SIGKILL");
    // 信号发给了进程组（负的 pid），恰一次。
    expect(signalsSent(kill)).toEqual([[-record.pid, "SIGKILL"]]);
    expect(record.childPid).toEqual(expect.any(Number));
    await expectGone([record.pid, record.childPid]);
    expectNothingLeft(on);
  });

  it("转换进行中中止 signal：aborted，假进程及其子进程都已不存在，作业目录被删", async () => {
    const on = stage();
    const abort = new AbortController();
    const attempt = failureOf(
      converterFor(on).convert(on.input("a@spawn-sleep.docx"), abort.signal),
    );

    const record = await waitForRecord(on, true);
    const job = jobOf(on.launches[0]);
    expect(lstatSync(job).mode & 0o7777).toBe(0o2770);
    abort.abort();
    const error = await attempt;

    expectBareKind(error, "aborted", [on.cacheDir]);
    expect(on.launches[0]?.child.signalCode).toBe("SIGKILL");
    await expectGone([record.pid, record.childPid]);
    expect(existsSync(job)).toBe(false);
    expectNothingLeft(on);
  });

  it("转换进行中 close()：aborted，进程都已不存在；其后的 convert 立即 aborted 且不启动进程", async () => {
    const on = stage();
    const converter = converterFor(on);
    const attempt = failureOf(converter.convert(on.input("a@spawn-sleep.docx")));
    const record = await waitForRecord(on, true);

    await converter.close();

    // close() 落定时被启动的那个进程已经退出。
    expect(on.launches[0]?.child.signalCode).toBe("SIGKILL");
    expectBareKind(await attempt, "aborted", [on.cacheDir]);
    await expectGone([record.pid, record.childPid]);
    expectNothingLeft(on);

    expectBareKind(await failureOf(converter.convert(on.input("b.docx"))), "aborted", []);
    await converter.close();
    expect(on.launches).toHaveLength(1);
    expectNothingLeft(on);
  });

  it("调用时 signal 已中止：aborted，不启动进程，不建作业目录", async () => {
    const on = stage();

    const error = await failureOf(
      converterFor(on).convert(on.input("a.docx"), AbortSignal.abort()),
    );

    expectBareKind(error, "aborted", [on.cacheDir]);
    expect(on.launches).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
  });

  it("转换成功之后再中止 signal 不改变结果", async () => {
    const on = stage();
    const abort = new AbortController();

    const result = await converterFor(on).convert(on.input("a.docx"), abort.signal);
    abort.abort();

    expect(readFileSync(result, "utf8")).toBe(PDF);
  });
});

describe("转换器调用契约：OMP_USER 模式下终止的是 sudo", { timeout: SLOW_TEST_MS }, () => {
  it("超时：timeout，假 sudo 被 SIGKILL 结束且恰被启动一次，没有别的信号与进程", async () => {
    const on = stage();
    useFakeSudo(on);
    const kill = vi.spyOn(process, "kill");

    const error = await failureOf(
      converterFor(on, { ompUser: "omp", timeoutMs: 200 }).convert(on.input("a@sleep.docx")),
    );

    expectBareKind(error, "timeout", [on.cacheDir]);
    expect(on.launches.map(({ command }) => command)).toEqual(["sudo"]);
    const child = on.launches[0]?.child;
    expect(on.launches[0]?.options.detached).toBe(false);
    expect(child?.signalCode).toBe("SIGKILL");
    // 没有对任何进程组或别的 pid 发信号：只有 child.kill。
    expect(signalsSent(kill)).toEqual([]);
    await expectGone([child?.pid]);
  });

  it("close()：aborted，假 sudo 被 SIGKILL 结束且恰被启动一次", async () => {
    const on = stage();
    useFakeSudo(on);
    const kill = vi.spyOn(process, "kill");
    const converter = converterFor(on, { ompUser: "omp" });
    const attempt = failureOf(converter.convert(on.input("a@sleep.docx")));
    const record = await waitForRecord(on);

    await converter.close();

    const child = on.launches[0]?.child;
    expect(child?.pid).toBe(record.pid);
    expect(child?.signalCode).toBe("SIGKILL");
    expectBareKind(await attempt, "aborted", [on.cacheDir]);
    expect(on.launches.map(({ command }) => command)).toEqual(["sudo"]);
    expect(signalsSent(kill)).toEqual([]);
    await expectGone([record.pid]);
  });
});

describe("转换器调用契约：只接受绝对路径", () => {
  it.each([["-env:UserInstallation=file:///x.docx"], ["--accept=x.docx"], ["ws/a.docx"]])(
    "absInput 为 %s：failed，不启动进程，不建作业目录",
    async (input) => {
      const on = stage();

      const error = await failureOf(converterFor(on).convert(input));

      expectBareKind(error, "failed", [input, on.cacheDir]);
      expect(on.launches).toEqual([]);
      expect(readdirSync(on.work)).toEqual([]);
    },
  );

  it.each([
    ["cacheDir", { officeBin: FAKE, cacheDir: "var/preview-cache" }],
    ["cacheDir（未配置 officeBin 时同样）", { cacheDir: "var/preview-cache" }],
    ["officeBin（裸名）", { officeBin: "soffice", cacheDir: tmpdir() }],
    ["officeBin（./ 开头）", { officeBin: "./soffice", cacheDir: tmpdir() }],
  ])("%s 不是绝对路径：构造即抛错，错误不含该值，不启动进程", (_which, paths) => {
    const on = stage();
    const construct = (): Converter =>
      createOfficeConverter({ ...paths, timeoutMs: LONG_TIMEOUT_MS, spawn: on.spawn });

    expect(construct).toThrow(new Error("cacheDir and officeBin must be absolute paths"));
    expect(on.launches).toEqual([]);
  });
});

describe("转换器调用契约：未配置", () => {
  it("不提供 officeBin：available 为 false，convert 以 unavailable 失败，不启动进程，work 下没有新建目录", async () => {
    const on = stage();
    const converter = converterFor(on, { officeBin: null });

    expect(converter.available).toBe(false);
    const error = await failureOf(converter.convert(on.input("a.docx")));

    expectBareKind(error, "unavailable", [on.cacheDir]);
    expect(on.launches).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
    await converter.close();
  });
});

describe("真实转换的人工验证：自动化测试不需要 LibreOffice", () => {
  it("两种模式各转换一次，启动过的可执行文件没有一个名为 soffice 或 libreoffice", async () => {
    const on = stage();
    await converterFor(on).convert(on.input("a.pptx"));
    useFakeSudo(on);
    await converterFor(on, { ompUser: "omp" }).convert(on.input("b.pptx"));

    expect(on.launches.map(({ command }) => command)).toEqual([FAKE, "sudo"]);
    expect(everyCommand.length).toBeGreaterThanOrEqual(2);
    for (const command of everyCommand) {
      expect(["soffice", "libreoffice"]).not.toContain(basename(command));
    }
    // sudo 之后真正被点名的可执行文件同样不是它们。
    expect(basename(on.launches[1]?.args[9] ?? "")).toBe("fake-soffice.mjs");
  });
});
