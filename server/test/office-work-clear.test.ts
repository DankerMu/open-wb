/**
 * Issue #1072（任务 14.3，含分摊的 14.5 / 14.6 条款）：office-preview「转换缓存」里启动时对 `work`
 * 的清空，含场景「OMP_USER 模式下启动时清空 work」（owner D-24）。
 *
 * `sudo` 是临时 bin 目录里指向 `fixtures/fake-sudo-find.mjs` 的符号链接，靠 `PATH` 首项命中——真的
 * `sudo` 与 `find` 一次都不执行（搭建见 `office-cache-helpers.ts`）。假 `sudo` 自己什么都不删，只
 * 记录收到的 argv、环境、工作目录与前后两次看到的 `work` 条目。期望的 argv 与日志串是照规格抄的
 * 字面量，不引用源码常量。
 *
 * Issue #1074（任务 15.1，owner D-26）：场景「启动清空超时与关停终止」。假 `sudo` 的 `hang` 模式写完
 * 带 pid 的记录之后一直睡眠；它是否还在以 `kill(pid, 0)` 判定，被哪个信号结束取自 `ChildProcess`。
 * 这里看得到的只是本进程对自己启动的那个假 `sudo` 做了什么；真实 `sudo` 之下的 `find` 是否随之
 * 结束不在这些用例的观察范围内。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOfficeCleanup } from "../src/preview/office-cache.js";
import {
  type Bench,
  bench,
  FAKE_SOFFICE,
  PDF,
  type Spawn,
  setEnv,
  useOfficeBenches,
} from "./office-cache-helpers.js";

const WORK_CLEAR_FAILED = '{"event":"preview_work_clear_failed"}';
/** 低熵占位值：只用来证明父环境里的键不进子进程。 */
const PARENT_ONLY = { MODEL_UPSTREAM_API_KEY: "placeholder", DB_PATH: "/placeholder/app.db" };
const isRoot = process.geteuid?.() === 0;
/** 两者都提供才执行 `sudo … find`；`officeBin` 只是一个绝对路径，这里从不执行它。 */
const OMP_MODE = { ompUser: "omp", officeBin: FAKE_SOFFICE };

interface SudoRecord {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
  entriesAtStart: string[] | null;
  entriesAtExit: string[] | null;
}

useOfficeBenches();

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

describe("转换缓存：启动时清空 work", () => {
  interface Cleared {
    logs: unknown[];
    clearWork(): Promise<void>;
  }

  function cleanupOn(
    on: Bench,
    identity: { ompUser?: string; officeBin?: string },
    overrides: { cacheDir?: string; spawn?: Spawn; log?: (record: unknown) => void } = {},
  ): Cleared {
    const logs: unknown[] = [];
    const cleanup = createOfficeCleanup({
      cacheDir: overrides.cacheDir ?? on.cacheDir,
      ...identity,
      spawn: overrides.spawn ?? on.spawn,
      log: overrides.log ?? ((record) => logs.push(record)),
    });
    return { logs, clearWork: () => cleanup.clearWork() };
  }

  /** 上一次运行遗留的作业目录，里面有一层子目录与一个文件。 */
  function leftover(on: Bench, name = "0123abcd"): string {
    mkdirSync(join(on.work, name, "out"), { recursive: true });
    writeFileSync(join(on.work, name, "out", "a.pdf"), PDF);
    return name;
  }

  /** 假 `sudo` 靠 PATH 首项命中；`#!/usr/bin/env node` 还需要 node 所在目录。 */
  function fakeSudoPath(on: Bench): string {
    const path = `${on.bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    setEnv("PATH", path);
    return path;
  }

  function sudoRecord(on: Bench): SudoRecord {
    return JSON.parse(readFileSync(join(on.cacheDir, "sudo.record.json"), "utf8")) as SudoRecord;
  }

  /** 恰一次，且记录序列化后整串相等：没有路径、用户名或别的键。 */
  function expectOneFailureLog(cleared: Cleared): void {
    expect(cleared.logs).toHaveLength(1);
    expect(JSON.stringify(cleared.logs[0])).toBe(WORK_CLEAR_FAILED);
  }

  function expectWorkEmptied(on: Bench): void {
    expect(readdirSync(on.work)).toEqual([]);
    expect(lstatSync(on.work).isDirectory()).toBe(true);
    expect(modeOf(on.work)).toBe(0o2770);
  }

  it.each<[string, string | undefined]>([
    ["父进程有 LANG", "C"],
    ["父进程没有 LANG", undefined],
  ])(
    "ompUser 与 officeBin 都提供（%s）：先恰一次固定参数的 sudo … find，等它结束才自己删，结束时 work 为空",
    async (_case, lang) => {
      const on = bench();
      const job = leftover(on);
      const path = fakeSudoPath(on);
      setEnv("LANG", lang);
      for (const [key, value] of Object.entries(PARENT_ONLY)) {
        setEnv(key, value);
      }
      const env = lang === undefined ? { PATH: path } : { PATH: path, LANG: lang };
      const cleared = cleanupOn(on, OMP_MODE);

      await expect(cleared.clearWork()).resolves.toBe(undefined);

      const argv = ["-n", "-u", "omp", "--", "/usr/bin/find", `${on.cacheDir}/work`];
      argv.push("-mindepth", "1", "-delete");
      expect(on.launches).toHaveLength(1);
      expect(on.launches[0]?.command).toBe("sudo");
      expect(on.launches[0]?.args).toEqual(argv);
      expect(on.launches[0]?.options).toEqual({ cwd: "/", env, stdio: "ignore", shell: false });
      const record = sudoRecord(on);
      expect(record.argv).toEqual([join(on.bin, "sudo"), ...argv]);
      expect(record.cwd).toBe("/");
      // macOS 给每个进程补这个键，不是调用方传的；对 options.env 的断言是精确的。
      const { __CF_USER_TEXT_ENCODING: _injected, ...childEnv } = record.env;
      expect(childEnv).toEqual(env);
      // 假 sudo 启动时与退出前各列一次目录，中间睡约 150 毫秒：两次都还看得见遗留目录。
      expect(record.entriesAtStart).toEqual([job]);
      expect(record.entriesAtExit).toEqual([job]);
      expectWorkEmptied(on);
      expect(cleared.logs).toEqual([]);
    },
  );

  it("cacheDir 带尾斜杠：argv 里的路径仍是 <cacheDir>/work", async () => {
    const on = bench();
    leftover(on);
    fakeSudoPath(on);
    const cleared = cleanupOn(on, OMP_MODE, { cacheDir: `${on.cacheDir}/` });

    await cleared.clearWork();

    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.args[5]).toBe(`${on.cacheDir}/work`);
    expect(on.launches[0]?.args).toHaveLength(9);
    expectWorkEmptied(on);
    expect(cleared.logs).toEqual([]);
  });

  it.each<[string, string]>([
    ["以退出码 1 结束", "1"],
    ["被信号结束", "signal"],
  ])("sudo %s：恰一条不带其它键的日志，不抛，本进程的删除照常", async (_case, exit) => {
    const on = bench();
    leftover(on);
    fakeSudoPath(on);
    writeFileSync(join(on.cacheDir, "sudo.exit"), exit);
    const cleared = cleanupOn(on, OMP_MODE);

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect(on.launches).toHaveLength(1);
    expect(sudoRecord(on).entriesAtExit).toEqual(["0123abcd"]);
    expectOneFailureLog(cleared);
    expectWorkEmptied(on);
  });

  it("PATH 含相对项：sudo 没有被启动，同一条日志，本进程的删除照常", async () => {
    const on = bench();
    leftover(on);
    setEnv("PATH", `${on.bin}:relative/bin:${dirname(process.execPath)}:/usr/bin:/bin`);
    const cleared = cleanupOn(on, OMP_MODE);

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect(on.launches).toEqual([]);
    expect(existsSync(join(on.cacheDir, "sudo.record.json"))).toBe(false);
    expectOneFailureLog(cleared);
    expectWorkEmptied(on);
  });

  it("PATH 里没有 sudo（启动失败，没有 pid）：同一条日志，不抛，本进程的删除照常", async () => {
    const on = bench({ sudo: false });
    leftover(on);
    setEnv("PATH", on.bin);
    const cleared = cleanupOn(on, OMP_MODE);

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.child.pid).toBe(undefined);
    expectOneFailureLog(cleared);
    expectWorkEmptied(on);
  });

  it("spawn 同步抛、log 自己也抛：都被吞掉，恰调一次 log，本进程的删除照常", async () => {
    const on = bench();
    leftover(on);
    fakeSudoPath(on);
    let spawned = 0;
    let logged = 0;
    const cleared = cleanupOn(on, OMP_MODE, {
      spawn() {
        spawned += 1;
        throw new Error("spawn EAGAIN");
      },
      log(record) {
        logged += 1;
        expect(JSON.stringify(record)).toBe(WORK_CLEAR_FAILED);
        throw new Error("stderr is closed");
      },
    });

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect([spawned, logged]).toEqual([1, 1]);
    expectWorkEmptied(on);
  });

  it.each<[string, { ompUser?: string; officeBin?: string }]>([
    ["同 uid 模式（只有 officeBin）", { officeBin: FAKE_SOFFICE }],
    ["有 ompUser 而没有 officeBin", { ompUser: "omp" }],
    ["两者都没有", {}],
  ])("%s：没有启动 sudo，没有日志，work 由本进程清空", async (_case, identity) => {
    const on = bench();
    leftover(on);
    leftover(on, "89abcdef");
    writeFileSync(join(on.work, "stray.record.json"), "{}");
    fakeSudoPath(on);
    const cleared = cleanupOn(on, identity);

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect(on.launches).toEqual([]);
    expect(existsSync(join(on.cacheDir, "sudo.record.json"))).toBe(false);
    expect(cleared.logs).toEqual([]);
    expectWorkEmptied(on);
  });

  it("work 下指向外部目录的符号链接被解除，不被跟随：外部目录与里面的文件原样", async () => {
    const on = bench();
    const outside = join(on.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "not ours");
    symlinkSync(outside, join(on.work, "link"));
    const cleared = cleanupOn(on, {});

    await cleared.clearWork();

    expectWorkEmptied(on);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("not ours");
  });

  it.skipIf(isRoot)("两个 0500 的非空目录删不掉：不抛，同级其余条目照删", async () => {
    const on = bench();
    for (const name of ["a-first", "g-second", "m-third", "s-fourth", "z-last"]) {
      mkdirSync(join(on.work, name));
      writeFileSync(join(on.work, name, "keep"), "x");
    }
    // 列目录的次序由文件系统定、与名字无关：按实际次序锁第 2、第 4 项，可删的条目因此在它们的
    // 前面、中间、后面都有——遇到删不掉的那项就停的实现无论按什么次序都会留下后面的。
    const order = readdirSync(on.work);
    expect(order).toHaveLength(5);
    const locked = [String(order[1]), String(order[3])];
    for (const name of locked) {
      chmodSync(join(on.work, name), 0o500);
    }
    const cleared = cleanupOn(on, {});

    await expect(cleared.clearWork()).resolves.toBe(undefined);

    expect(readdirSync(on.work).sort()).toEqual([...locked].sort());
    for (const name of locked) {
      expect(readdirSync(join(on.work, name))).toEqual(["keep"]);
    }
    expect(cleared.logs).toEqual([]);
  });
});

describe("转换缓存：启动清空的超时与关停终止（owner D-26）", () => {
  /** 远短于假 `sudo` 的 30 秒睡眠上限，又留得出它启动并写记录的时间。 */
  const SHORT_TIMEOUT_MS = 1_000;

  function hangingBench(mode: "hang" | "hang-deaf" | "hang-exit0" = "hang"): Bench {
    const on = bench();
    mkdirSync(join(on.work, "0123abcd", "out"), { recursive: true });
    writeFileSync(join(on.work, "0123abcd", "out", "a.pdf"), PDF);
    setEnv("PATH", `${on.bin}:${dirname(process.execPath)}:/usr/bin:/bin`);
    writeFileSync(join(on.cacheDir, "sudo.exit"), mode);
    return on;
  }

  function cleanupOf(on: Bench, clearTimeoutMs?: number) {
    const logs: unknown[] = [];
    const cleanup = createOfficeCleanup({
      cacheDir: on.cacheDir,
      ...OMP_MODE,
      spawn: on.spawn,
      log: (record) => logs.push(record),
      ...(clearTimeoutMs === undefined ? {} : { clearTimeoutMs }),
    });
    return { logs, cleanup };
  }

  async function recordedPid(on: Bench): Promise<number> {
    const path = join(on.cacheDir, "sudo.record.json");
    const deadlineAt = performance.now() + 10_000;
    while (!existsSync(path)) {
      if (performance.now() > deadlineAt) {
        throw new Error("the fake sudo never wrote its record");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return (JSON.parse(readFileSync(path, "utf8")) as SudoRecord).pid;
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  /** 恰启动一次、那个进程已不存在、恰一行日志、`work` 为空且权限位原样。 */
  function expectTerminated(
    on: Bench,
    logs: unknown[],
    pid: number,
    signal: "SIGTERM" | "SIGKILL",
  ): void {
    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.child.pid).toBe(pid);
    expect(on.launches[0]?.child.signalCode).toBe(signal);
    expect(on.launches[0]?.child.exitCode).toBe(null);
    expect(isAlive(pid)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).toBe(WORK_CLEAR_FAILED);
    expect(readdirSync(on.work)).toEqual([]);
    expect(modeOf(on.work)).toBe(0o2770);
  }

  it("挂起的假 sudo，clearWork 在超时后落定：SIGTERM 结束它，恰一行日志，不抛，本进程的删除照常", async () => {
    const on = hangingBench();
    const { logs, cleanup } = cleanupOf(on, SHORT_TIMEOUT_MS);
    const startedAt = performance.now();

    await expect(cleanup.clearWork()).resolves.toBe(undefined);

    const elapsed = performance.now() - startedAt;
    // 不早于超时（计时器允许 1 毫秒的舍入），远早于假 sudo 自己睡醒的 30 秒。
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS - 1);
    expect(elapsed).toBeLessThan(10_000);
    expectTerminated(on, logs, await recordedPid(on), "SIGTERM");
  }, 20_000);

  it("入口不传超时时用的是固定的 10 秒", async () => {
    const on = hangingBench();
    const { logs, cleanup } = cleanupOf(on);
    const startedAt = performance.now();

    await expect(cleanup.clearWork()).resolves.toBe(undefined);

    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(9_999);
    // 上界压在 10 秒 + 2 秒宽限之内：时限被改长（比如 15 秒）或落到 SIGKILL 升级都会越过它。
    expect(elapsed).toBeLessThan(12_000);
    expectTerminated(on, logs, await recordedPid(on), "SIGTERM");
  }, 30_000);

  it("不理会 SIGTERM 的假 sudo：2 秒后改发 SIGKILL，仍只一行日志", async () => {
    const on = hangingBench("hang-deaf");
    const { logs, cleanup } = cleanupOf(on, SHORT_TIMEOUT_MS);
    const startedAt = performance.now();

    await expect(cleanup.clearWork()).resolves.toBe(undefined);

    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS + 2_000 - 2);
    // 1 秒超时 + 2 秒宽限 = 3 秒；宽限被改长（比如 5 秒）就会越过这个上界。
    expect(elapsed).toBeLessThan(5_000);
    expectTerminated(on, logs, await recordedPid(on), "SIGKILL");
  }, 20_000);

  it("被终止的假 sudo 以退出码 0 退出：仍按失败处理，恰一行日志", async () => {
    const on = hangingBench("hang-exit0");
    const { logs, cleanup } = cleanupOf(on, SHORT_TIMEOUT_MS);

    await expect(cleanup.clearWork()).resolves.toBe(undefined);

    const pid = await recordedPid(on);
    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.child.exitCode).toBe(0);
    expect(on.launches[0]?.child.signalCode).toBe(null);
    expect(isAlive(pid)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).toBe(WORK_CLEAR_FAILED);
    expect(readdirSync(on.work)).toEqual([]);
  }, 20_000);

  it("关停终止：假 sudo 仍在运行时调用 stopWorkClear，它被 SIGTERM 结束，清理照常落定，恰一行日志", async () => {
    const on = hangingBench();
    const { logs, cleanup } = cleanupOf(on);
    const startedAt = performance.now();
    const clearing = cleanup.clearWork();
    const pid = await recordedPid(on);
    expect(isAlive(pid)).toBe(true);
    expect(logs).toEqual([]);

    cleanup.stopWorkClear();
    // 第二次调用不再发信号，也不多记一行。
    cleanup.stopWorkClear();

    await expect(clearing).resolves.toBe(undefined);
    // 远早于固定的 10 秒超时：结束它的是终止句柄。
    expect(performance.now() - startedAt).toBeLessThan(8_000);
    expectTerminated(on, logs, pid, "SIGTERM");
  }, 20_000);

  it("先于清空到达的关停不丢：stopWorkClear 之后的 clearWork 不启动 sudo，按失败记恰一行日志，本进程的删除照常", async () => {
    const on = hangingBench();
    // 假 sudo 若被启动，会立刻以 0 退出并留下记录。
    rmSync(join(on.cacheDir, "sudo.exit"));
    const { logs, cleanup } = cleanupOf(on);

    expect(cleanup.stopWorkClear()).toBe(undefined);
    await expect(cleanup.clearWork()).resolves.toBe(undefined);
    expect(cleanup.stopWorkClear()).toBe(undefined);

    expect(on.launches).toEqual([]);
    expect(existsSync(join(on.cacheDir, "sudo.record.json"))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).toBe(WORK_CLEAR_FAILED);
    expect(readdirSync(on.work)).toEqual([]);
    expect(modeOf(on.work)).toBe(0o2770);

    // 不可撤回：再清一次仍不启动，那一次自己再记一行。
    await expect(cleanup.clearWork()).resolves.toBe(undefined);
    expect(on.launches).toEqual([]);
    expect(logs).toHaveLength(2);
  });

  it("清空落定之后才调用 stopWorkClear：不抛，不多记日志，已完成的那次清空不受影响", async () => {
    const on = hangingBench();
    rmSync(join(on.cacheDir, "sudo.exit"));
    const { logs, cleanup } = cleanupOf(on);

    await expect(cleanup.clearWork()).resolves.toBe(undefined);
    expect(cleanup.stopWorkClear()).toBe(undefined);

    expect(on.launches).toHaveLength(1);
    expect(on.launches[0]?.child.exitCode).toBe(0);
    expect(on.launches[0]?.child.signalCode).toBe(null);
    expect(logs).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
  });

  it("同 uid 模式没有 sudo 可终止：stopWorkClear 之前、之后的清空都不启动进程、不记日志", async () => {
    const on = hangingBench();
    const logs: unknown[] = [];
    const cleanup = createOfficeCleanup({
      cacheDir: on.cacheDir,
      officeBin: FAKE_SOFFICE,
      spawn: on.spawn,
      log: (record) => logs.push(record),
    });

    await cleanup.clearWork();
    expect(cleanup.stopWorkClear()).toBe(undefined);
    // 没有那条命令，也就没有「该命令失败」：关停之后的清空同样不记日志。
    await cleanup.clearWork();

    expect(on.launches).toEqual([]);
    expect(logs).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
  });
});
