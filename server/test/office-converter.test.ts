/**
 * Issue 1505：app 侧办公文档转换器对 spool 的单次转换契约（office-preview「sidecar 转换契约」的六个
 * 场景、「转换 sidecar 的健康与 fail-closed」场景「运行期心跳的边沿触发」，以及「真实转换的人工
 * 验证」里的「自动化测试不需要 LibreOffice」）。
 *
 * 全部用例对着进程内的假 sidecar（`support/fake-sidecar.ts`，不做任何隔离）：它记下每个作业的
 * `request.json` 原文、`in/` 的字节、领取那一刻作业目录里的全部文件与看到 `cancel` 的时刻，是
 * 「三键」「字节相等」「不泄露路径」「写了 cancel」的判据。`child_process` 的七个启动函数整文件都被
 * 计数（`syncBuiltinESMExports` 让源码的具名导入也经过计数器），是「没有启动任何子进程」的判据。
 * 期望的键集、PDF 字节与 message 是照规格抄的字面量，不引用源码常量。
 */
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, {
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfficeConverter, OfficeConvertError } from "../src/preview/office.js";
import {
  type FakeJob,
  type FakeSidecar,
  PDF,
  startFakeSidecar,
  stopFakeSidecars,
} from "./support/fake-sidecar.js";

const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_32_PDF = /^[0-9a-f]{32}\.pdf$/u;
/** 转换器自己的超时：不测超时的用例里它不该先到。 */
const LONG_TIMEOUT_MS = 20_000;
const POLL_MS = 20;
const WITHIN_MS = 6_000;
const UNAVAILABLE_RECORD = { event: "office_convert_sidecar_unavailable" };
/** 三个 app 一侧路径里各放一个哨兵段：spool 里任何一个字节都不该含它们。 */
const SENTINELS = ["zq-sentinel-sandbox", "zq-sentinel-cache", "zq-sentinel-state"];
const LAUNCHERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

interface Stage {
  root: string;
  cacheDir: string;
  pdf: string;
  spool: string;
  jobs: string;
  sidecar: FakeSidecar;
  /** 在「工作空间」（路径含哨兵段）里写一个输入文件，返回它的绝对路径。 */
  input(name: string, content?: string | Buffer): string;
}

type Converter = ReturnType<typeof createOfficeConverter>;

const roots: string[] = [];
const converters: Converter[] = [];
/** 整个文件里经 `child_process` 启动过的每一个命令。 */
const launched: string[] = [];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of LAUNCHERS) {
    const real = childProcess[name as keyof typeof childProcess] as (...args: unknown[]) => unknown;
    vi.spyOn(childProcess, name as "spawn").mockImplementation(((...args: unknown[]) => {
      launched.push(String(args[0]));
      return real(...args);
    }) as never);
  }
  syncBuiltinESMExports();
});

afterEach(async () => {
  await Promise.all(converters.splice(0).map((converter) => converter.close()));
  stopFakeSidecars();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
  process.env[key] = value;
}

/** 入口建好的布局：`<cache>/pdf`（`0700`）、spool（`0700`）与其下 `jobs/`；假 sidecar 心跳新鲜。 */
function stage(layout: { jobs: boolean } = { jobs: true }): Stage {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-converter-")));
  roots.push(root);
  const cacheDir = join(root, SENTINELS[1] ?? "", "cache");
  const ws = join(root, SENTINELS[0] ?? "", "u1", "ws", "dir");
  const spool = join(root, "spool");
  for (const dir of [join(cacheDir, "pdf"), ws, spool]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (layout.jobs) {
    mkdirSync(join(spool, "jobs"), { mode: 0o700 });
  }
  setEnv("SANDBOX_ROOT", join(root, SENTINELS[0] ?? ""));
  setEnv("PREVIEW_CACHE_DIR", cacheDir);
  setEnv("OMP_STATE_DIR", join(root, SENTINELS[2] ?? "", "state"));
  return {
    root,
    cacheDir,
    pdf: join(cacheDir, "pdf"),
    spool,
    jobs: join(spool, "jobs"),
    sidecar: startFakeSidecar(spool),
    input(name, content = "not a real office document") {
      const path = join(ws, name);
      writeFileSync(path, content);
      return path;
    },
  };
}

function converterFor(
  on: Stage,
  overrides: { spoolDir?: string | null; timeoutMs?: number; log?: (record: unknown) => void } = {},
): Converter {
  const { spoolDir = on.spool, timeoutMs = LONG_TIMEOUT_MS, log } = overrides;
  const converter = createOfficeConverter({
    ...(spoolDir === null ? {} : { spoolDir }),
    cacheDir: on.cacheDir,
    timeoutMs,
    pollMs: POLL_MS,
    ...(log === undefined ? {} : { log }),
  });
  converters.push(converter);
  return converter;
}

async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + WITHIN_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(10);
  }
}

/** 等假 sidecar 领取第 `index` 个作业（读到了 `request.json`）。 */
function claimed(on: Stage, index = 0): Promise<FakeJob> {
  return waitFor("the fake sidecar to claim the job", () => {
    const job = on.sidecar.jobs()[index];
    return job?.request === undefined ? undefined : job;
  });
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
    expect(JSON.stringify(error)).not.toContain(path);
  }
}

/** 「缓存与 spool 里没有新增」：`pdf/` 为空，`jobs/` 下没有目录。 */
function expectNothingLeft(on: Stage): void {
  expect(readdirSync(on.pdf)).toEqual([]);
  expect(readdirSync(on.jobs)).toEqual([]);
}

/** spool 树里每个普通文件的字节（递归）。 */
function spoolFiles(dir: string): Buffer[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? spoolFiles(path) : entry.isFile() ? [readFileSync(path)] : [];
  });
}

describe("sidecar 转换契约：作业目录里只有字节与三键", () => {
  it("1 MiB 随机内容的「报告 v2.docx」：in/ 字节相等、request.json 恰三键、spool 不含任何哨兵段，结果是 pdf/ 下 0600 的新文件，作业目录已删", async () => {
    const on = stage();
    const content = randomBytes(1_048_576);
    const input = on.input("报告 v2.docx", content);
    const converter = converterFor(on);
    expect(converter.available).toBe(true);

    const attempt = converter.convert(input);
    // 作业目录在 `convert` 返回之前同步建出。
    const [created] = on.sidecar.jobs();
    expect(created?.id).toMatch(HEX_32);
    expect(lstatSync(created?.dir ?? "").mode & 0o7777).toBe(0o700);
    const result = await attempt;

    const [job, ...others] = on.sidecar.jobs();
    expect(others).toEqual([]);
    expect(job?.name).toBe("报告 v2.docx");
    expect(job?.bytes?.equals(content)).toBe(true);
    const request = JSON.parse(job?.request ?? "{}") as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["input", "timeoutMs", "version"]);
    expect(request).toEqual({ version: 1, input: "报告 v2.docx", timeoutMs: LONG_TIMEOUT_MS });
    expect(Object.keys(job?.files ?? {}).sort()).toEqual([
      join("in", "报告 v2.docx"),
      "request.json",
    ]);
    for (const bytes of [...Object.values(job?.files ?? {}), ...spoolFiles(on.spool)]) {
      for (const leak of [...SENTINELS, input, dirname(input)]) {
        expect(bytes.includes(leak)).toBe(false);
      }
    }

    expect(dirname(result)).toBe(on.pdf);
    expect(basename(result)).toMatch(HEX_32_PDF);
    expect(readFileSync(result, "utf8")).toBe(PDF);
    const stats = lstatSync(result);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o7777).toBe(0o600);
    expect(stats.uid).toBe(process.geteuid?.());
    expect(readdirSync(on.pdf)).toEqual([basename(result)]);
    expect(existsSync(job?.dir ?? "")).toBe(false);
    expect(readdirSync(on.jobs)).toEqual([]);
    expect(launched).toEqual([]);
  });

  it("每次转换用各自新建的作业目录，结果互不覆盖；0 字节的输入照样以 0 字节复制", async () => {
    const on = stage();
    const converter = converterFor(on);
    const input = on.input("表格.xlsx");

    const first = await converter.convert(input);
    const second = await converter.convert(input);
    await converter.convert(on.input("空.docx", ""));

    const jobs = on.sidecar.jobs();
    expect(new Set(jobs.map(({ id }) => id)).size).toBe(3);
    expect(jobs[2]?.bytes?.length).toBe(0);
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toBe(PDF);
    expect(readFileSync(second, "utf8")).toBe(PDF);
  });
});

describe("sidecar 转换契约：输入在 lstat 之后被换成符号链接", () => {
  /** 钩子辅助复现：输入的第一次 `openSync` 之前把它换成指向工作空间外文件的符号链接。 */
  function swapOnOpen(input: string, outside: string): () => number {
    const realOpenSync = fs.openSync;
    let swaps = 0;
    vi.spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
      if (path === input && swaps === 0) {
        swaps += 1;
        rmSync(input);
        symlinkSync(outside, input);
      }
      return realOpenSync(path, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    return () => swaps;
  }

  it.each(["打开之前被换入", "本就是符号链接"])(
    "%s：failed，spool 里没有为它建作业目录与 in/，错误不含路径",
    async (when) => {
      const on = stage();
      const outside = join(on.root, "outside.docx");
      writeFileSync(outside, "outside the workspace");
      const input = on.input("a.docx");
      let swaps = (): number => 1;
      if (when === "本就是符号链接") {
        rmSync(input);
        symlinkSync(outside, input);
      } else {
        swaps = swapOnOpen(input, outside);
      }

      const error = await failureOf(converterFor(on).convert(input));

      expect(swaps()).toBe(1);
      expectBareKind(error, "failed", [input, outside, on.root]);
      expect(on.sidecar.jobs()).toEqual([]);
      expectNothingLeft(on);
    },
  );
});

describe("sidecar 转换契约：标记到 kind", () => {
  it("done 且输出完好：成功；多点扩展名的输入取 out/report.v2@named.tar.pdf", async () => {
    const on = stage();

    const result = await converterFor(on).convert(on.input("report.v2@named.tar.docx"));

    expect(readFileSync(result, "utf8")).toBe(PDF);
    expect(on.sidecar.jobs()[0]?.output).toBe(join("out", "report.v2@named.tar.pdf"));
  });

  it.each([
    ["写 failed（原因码 exit）", "a@exit1.docx"],
    ["写 failed（原因码 bad-request）", "a@bad-request.docx"],
    ["写出 0 字节的 PDF 后 done", "a@empty.docx"],
    ["把输出写成符号链接后 done", "a@symlink.docx"],
    ["把输出写成没有写端的命名管道后 done", "a@fifo.docx"],
    ["不建 out/ 直接写 done", "a@nopdf.docx"],
  ])("假 sidecar %s：failed，pdf/ 没有新增，作业目录被删，错误不含路径", async (_case, name) => {
    const on = stage();
    const input = on.input(name);
    const startedAt = performance.now();
    const attempt = failureOf(converterFor(on).convert(input));
    const outcome = await Promise.race([attempt, delay(1_500).then(() => "still pending")]);

    expect(outcome).not.toBe("still pending");
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expectBareKind(await attempt, "failed", [input, on.cacheDir, on.spool]);
    const [job] = on.sidecar.jobs();
    expect(job?.answer).toMatch(/^(done|failed:exit|failed:bad-request)$/u);
    expect(existsSync(job?.dir ?? "")).toBe(false);
    expectNothingLeft(on);
  });
});

describe("sidecar 转换契约：超时、中止与关停都写 cancel", { timeout: 15_000 }, () => {
  it("timeoutMs 200、假 sidecar 不写标记：timeout，假 sidecar 记录到 cancel，作业目录被删", async () => {
    const on = stage();
    const startedAt = Date.now();

    const error = await failureOf(
      converterFor(on, { timeoutMs: 200 }).convert(on.input("a@hang.docx")),
    );

    expectBareKind(error, "timeout", [on.spool]);
    const [job] = on.sidecar.jobs();
    const cancelAt = await waitFor("the cancel record", () => job?.cancelAt);
    expect(cancelAt - startedAt).toBeGreaterThanOrEqual(150);
    expect(existsSync(job?.dir ?? "")).toBe(false);
    expectNothingLeft(on);
  });

  it("等待中中止调用方的 signal：aborted，cancel 已写，作业目录被删", async () => {
    const on = stage();
    const abort = new AbortController();
    const attempt = failureOf(converterFor(on).convert(on.input("a@hang.docx"), abort.signal));
    const job = await claimed(on);

    abort.abort();

    expectBareKind(await attempt, "aborted", [on.spool]);
    await waitFor("the cancel record", () => job.cancelAt);
    expect(existsSync(job.dir)).toBe(false);
    expectNothingLeft(on);
  });

  it("等待中 close()：aborted、cancel 已写、作业目录已删；其后的 convert 立即 aborted 且不建作业", async () => {
    const on = stage();
    const converter = converterFor(on);
    const attempt = failureOf(converter.convert(on.input("a@hang.docx")));
    const job = await claimed(on);

    await converter.close();

    // close() 落定时作业目录已删、cancel 已写。
    expect(existsSync(job.dir)).toBe(false);
    expectBareKind(await attempt, "aborted", [on.spool]);
    await waitFor("the cancel record", () => job.cancelAt);
    expectBareKind(await failureOf(converter.convert(on.input("b.docx"))), "aborted", []);
    await converter.close();
    expect(on.sidecar.jobs()).toHaveLength(1);
    expectNothingLeft(on);
  });

  it("调用时 signal 已中止：aborted，不建作业目录；成功之后再中止 signal 不改变结果", async () => {
    const on = stage();
    const converter = converterFor(on);

    expectBareKind(
      await failureOf(converter.convert(on.input("a.docx"), AbortSignal.abort())),
      "aborted",
      [],
    );
    expect(on.sidecar.jobs()).toEqual([]);
    const abort = new AbortController();
    const result = await converter.convert(on.input("b.docx"), abort.signal);
    abort.abort();
    expect(readFileSync(result, "utf8")).toBe(PDF);
    expect(on.sidecar.jobs()[0]?.cancelAt).toBeUndefined();
  });
});

describe("sidecar 转换契约：检查次序与构造参数", () => {
  it("不提供 spoolDir：available 为 false，convert 以 unavailable 失败，spool 里没有新建目录", async () => {
    const on = stage();
    const converter = converterFor(on, { spoolDir: null });

    expect(converter.available).toBe(false);
    expectBareKind(await failureOf(converter.convert(on.input("a.docx"))), "unavailable", []);
    // 对不存在的输入同样是 unavailable：次序上它在一切文件操作之前。
    const missing = join(on.root, "missing.docx");
    expectBareKind(await failureOf(converter.convert(missing)), "unavailable", []);
    expect(on.sidecar.jobs()).toEqual([]);
    expectNothingLeft(on);
  });

  it("已 close() 后调用：aborted，不建作业目录", async () => {
    const on = stage();
    const converter = converterFor(on);
    await converter.close();

    expectBareKind(await failureOf(converter.convert(on.input("a.docx"))), "aborted", []);
    expect(on.sidecar.jobs()).toEqual([]);
  });

  it.each([["ws/a.docx"], ["-env:UserInstallation=file:///x.docx"], ["--accept=x.docx"]])(
    "absInput 为 %s：failed，不建作业目录",
    async (input) => {
      const on = stage();

      expectBareKind(await failureOf(converterFor(on).convert(input)), "failed", [input]);
      expect(on.sidecar.jobs()).toEqual([]);
      expectNothingLeft(on);
    },
  );

  it("jobs/ 不存在：failed，不替调用方建它；pdf/ 不存在：sidecar 写了 done 也算 failed，作业目录照删", async () => {
    const bare = stage({ jobs: false });
    expectBareKind(await failureOf(converterFor(bare).convert(bare.input("a.docx"))), "failed", [
      bare.spool,
    ]);
    expect(existsSync(bare.jobs)).toBe(false);

    const on = stage();
    rmSync(on.pdf, { recursive: true });
    expectBareKind(await failureOf(converterFor(on).convert(on.input("a.docx"))), "failed", [
      on.cacheDir,
    ]);
    expect(on.sidecar.jobs()[0]?.answer).toBe("done");
    expect(readdirSync(on.jobs)).toEqual([]);
    expect(existsSync(on.pdf)).toBe(false);
  });

  it.each([
    ["cacheDir", { spoolDir: tmpdir(), cacheDir: "var/preview-cache" }],
    ["cacheDir（未提供 spoolDir 时同样）", { cacheDir: "var/preview-cache" }],
    ["spoolDir", { spoolDir: "spool", cacheDir: tmpdir() }],
    ["spoolDir（./ 开头）", { spoolDir: "./spool", cacheDir: tmpdir() }],
  ])("%s 不是绝对路径：构造即抛固定 message 的普通错误", (_which, paths) => {
    expect(() => createOfficeConverter({ ...paths, timeoutMs: LONG_TIMEOUT_MS })).toThrow(
      new Error("cacheDir and spoolDir must be absolute paths"),
    );
  });
});

describe("转换 sidecar 的健康与 fail-closed：运行期心跳的边沿触发", () => {
  it("新鲜 → 成功；不新鲜 → 三次 unavailable、零作业、log 恰一条；恢复 → 成功；再不新鲜 → 恰再一条", async () => {
    const on = stage();
    const records: unknown[] = [];
    const converter = converterFor(on, { log: (record) => records.push(record) });

    expect(readFileSync(await converter.convert(on.input("a.docx")), "utf8")).toBe(PDF);
    on.sidecar.heartbeat("stale");
    for (const name of ["b.docx", "c.docx", "d.docx"]) {
      expectBareKind(await failureOf(converter.convert(on.input(name))), "unavailable", []);
    }
    expect(on.sidecar.jobs()).toHaveLength(1);
    expect(readdirSync(on.jobs)).toEqual([]);
    expect(records).toEqual([UNAVAILABLE_RECORD]);

    on.sidecar.heartbeat("fresh");
    expect(readFileSync(await converter.convert(on.input("e.docx")), "utf8")).toBe(PDF);
    expect(records).toEqual([UNAVAILABLE_RECORD]);
    on.sidecar.heartbeat("stale");
    expectBareKind(await failureOf(converter.convert(on.input("f.docx"))), "unavailable", []);
    expect(records).toEqual([UNAVAILABLE_RECORD, UNAVAILABLE_RECORD]);
    expect(Object.keys(records[1] as object)).toEqual(["event"]);
  });

  it("log 抛出：吞掉，结果仍是 unavailable；heartbeat 缺席同样不新鲜", async () => {
    const on = stage();
    rmSync(join(on.spool, "heartbeat"));
    on.sidecar.heartbeat("none");
    const converter = converterFor(on, {
      log: () => {
        throw new Error("sink unavailable");
      },
    });

    expectBareKind(await failureOf(converter.convert(on.input("a.docx"))), "unavailable", []);
    expect(on.sidecar.jobs()).toEqual([]);
  });
});

describe("真实转换的人工验证：自动化测试不需要 LibreOffice", () => {
  it("本文件经 child_process 启动过的命令里没有 soffice、libreoffice、docker——转换器一个都没启动；计数器本身是活的", async () => {
    const on = stage();
    await converterFor(on).convert(on.input("a.pptx"));
    await failureOf(converterFor(on).convert(on.input("b@fifo.pptx")));
    expect(launched).toEqual([]);

    childProcess.spawnSync(process.execPath, ["--version"]);
    expect(launched).toEqual([process.execPath]);
    for (const command of launched) {
      expect(["soffice", "libreoffice", "docker"]).not.toContain(basename(command));
    }
  });
});
