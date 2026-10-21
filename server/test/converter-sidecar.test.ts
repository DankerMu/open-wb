/**
 * Issue #1504：转换 sidecar 脚本（office-preview「转换 sidecar 实现与镜像」场景「sidecar 脚本对着
 * 假 soffice」；「转换隔离边界」第 4、5 条的 sidecar 一侧）。子进程夹具见 `support/converter-sidecar.ts`；
 * 错误路径与覆盖补充在 `converter-sidecar-errors.test.ts`。
 * 「杀整组」用夹具既有的 `@spawn-sleep` 标记：它派生一个同进程组的子进程并把两个 pid 记进
 * `jobs/<id>.record.json`。期望的 argv、PDF 字节与日志行是照规格抄的字面量，不引用脚本常量。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanUpSidecars,
  everyCommand,
  expectGone,
  expectNoRealConverter,
  type FakeRecord,
  lineFor,
  linesOf,
  MARKER_WITHIN_MS,
  makeSpool,
  markerOf,
  PARENT_ONLY,
  readRecord,
  recordPath,
  type Sidecar,
  settled,
  spawnedPair,
  startSidecar,
  waitFor,
  writeJob,
} from "./support/converter-sidecar.js";

/** 假 soffice 正常转换写出的全部字节（与夹具各持一份字面量）。 */
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
/** 每例的时限：大于夹具里的等待之和，先报错的是带说明的那个。 */
vi.setConfig({ testTimeout: 15_000 });
const LOG_KEYS = ["event", "id", "result", "reason", "ms"];

afterEach(cleanUpSidecars);

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

/** 该 id 的全部 convert 日志行（`lineFor` 只给第一行）。 */
function linesForId(sidecar: Sidecar, job: string): Record<string, unknown>[] {
  return linesOf(sidecar).filter((line) => line.id === basename(job));
}

/** 起一个 sidecar、让它把一个作业落定为 `done`，等到该 id 的日志行（标记先于日志行写出）。 */
async function settledOnce(): Promise<{ sidecar: Sidecar; job: string }> {
  const sidecar = startSidecar(makeSpool());
  const job = writeJob(sidecar.jobs, "a.docx");
  expect(await lineFor(sidecar, job)).toMatchObject({ result: "done", reason: "" });
  return { sidecar, job };
}

/**
 * Issue #1601（office-preview「转换 sidecar 实现与镜像」的两个场景；change sidecar-settled-claim
 * design D6）。不用固定 sleep：哨兵作业的 `request.json` 更新，按 mtime 排在被测作业之后，哨兵的
 * 日志行出现时被测作业至少已被判过一轮（`bad-request` 在领取时同步落定，行先于哨兵的行进 stderr）。
 */
describe("sidecar 脚本：已落定的作业不再领取", () => {
  it("删除途中的作业不被重领：先删 in/ 再删 done、保留 request.json，该 id 恰一行日志、没有 failed，整目录随后可删", async () => {
    const { sidecar, job } = await settledOnce();

    // `done` 还在时不会被领取，所以先删 `in/` 没有竞态；删掉 `done` 之后才是 app 删除途中的输家次序。
    rmSync(join(job, "in"), { recursive: true });
    rmSync(join(job, "done"));
    expect(existsSync(join(job, "request.json"))).toBe(true);
    const sentinel = writeJob(sidecar.jobs, "sentinel.docx");
    expect(await settled(sentinel)).toBe("done");
    await lineFor(sidecar, sentinel);

    const outcomes = linesForId(sidecar, job).map((line) => `${line.result}:${line.reason}`);
    expect({ outcomes, failed: existsSync(join(job, "failed")) }).toEqual({
      outcomes: ["done:"],
      failed: false,
    });
    rmSync(job, { recursive: true });
    expect(existsSync(job)).toBe(false);
  });

  it("已落定集合有界：作业目录删除并被列过一次之后，以同一 id 重建的就绪作业在标记等待上限内被领取", async () => {
    const { sidecar, job } = await settledOnce();

    rmSync(job, { recursive: true });
    // 哨兵在删除之后才写出：领取到它的那一轮列表里已没有被删的 id。
    const sentinel = writeJob(sidecar.jobs, "sentinel.docx");
    expect(await settled(sentinel)).toBe("done");

    writeJob(sidecar.jobs, "a.docx", undefined, basename(job));
    expect(await settled(job)).toBe("done");
    await waitFor("the second log line", () => linesForId(sidecar, job)[1], 2_000);
    expect(linesForId(sidecar, job)).toHaveLength(2);
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
    expectNoRealConverter();
  });
});
