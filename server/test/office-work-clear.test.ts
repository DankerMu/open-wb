/**
 * Issue #1072（任务 14.3，含分摊的 14.5 / 14.6 条款）：office-preview「转换缓存」里启动时对 `work`
 * 的清空，含场景「OMP_USER 模式下启动时清空 work」（owner D-24）。
 *
 * `sudo` 是临时 bin 目录里指向 `fixtures/fake-sudo-find.mjs` 的符号链接，靠 `PATH` 首项命中——真的
 * `sudo` 与 `find` 一次都不执行（搭建见 `office-cache-helpers.ts`）。假 `sudo` 自己什么都不删，只
 * 记录收到的 argv、环境、工作目录与前后两次看到的 `work` 条目。期望的 argv 与日志串是照规格抄的
 * 字面量，不引用源码常量。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
