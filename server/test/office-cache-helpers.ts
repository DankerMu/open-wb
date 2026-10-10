/**
 * Issue #1072：`office-cache.test.ts` 与 `office-work-clear.test.ts` 共用的搭建——临时缓存目录、
 * 记录型 spawn 包装器与环境变量的还原。
 *
 * 包装器记录每次启动的命令、argv、选项与 `ChildProcess`，是「零启动」「恰一次」「argv 逐项相等」的
 * 判据。裸名命令只许在测试自己的 bin 目录里解析（子进程环境的 `PATH` 首项必须是它）：真的 `sudo`
 * 一次都不执行，被拒绝的命令记下来，`afterEach` 断言没有一次拒绝。
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, vi } from "vitest";

export const FAKE_SOFFICE = fileURLToPath(new URL("./fixtures/fake-soffice.mjs", import.meta.url));
const FAKE_SUDO = fileURLToPath(new URL("./fixtures/fake-sudo-find.mjs", import.meta.url));
/** 假 soffice 正常转换写出的全部字节（与夹具各持一份字面量）。 */
export const PDF =
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
/** 26 个 ASCII 字节：键里的 `size` 因此是字面量 `26`。 */
export const BODY = "not a real office document";
/** 输入的修改时间钉成整秒：键里的 `mtimeMs` 因此是字面量 `1700000000000`。 */
export const INPUT_MTIME_S = 1_700_000_000;

interface Launch {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: ChildProcess;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface Bench {
  root: string;
  cacheDir: string;
  work: string;
  pdf: string;
  /** 临时 bin 目录；`sudo: false` 时是空的。 */
  bin: string;
  launches: Launch[];
  /** 下一次启动换成 `node -e <脚本> <参数…>`（「失败不入缓存」用），只换一次。 */
  standIn: string[] | undefined;
  spawn: Spawn;
  /** 在「工作空间」里写一个输入文件并把修改时间钉成整秒，返回绝对路径。 */
  input(name: string): string;
}

const roots: string[] = [];
/** 用例结束时要关掉的转换器。 */
export const closers: Array<{ close(): Promise<void> }> = [];
/** 包装器拒绝过的命令；非空说明有用例差点解析到测试 bin 目录之外。 */
const refused: string[] = [];
/** 每次改动之前的值，按改动次序；还原时倒着放回去。 */
const envBefore: Array<[key: string, value: string | undefined]> = [];

function putEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

/** 改一个环境变量（`undefined` 即删除）；用例结束时由 `useOfficeBenches` 的钩子还原。 */
export function setEnv(key: string, value: string | undefined): void {
  envBefore.push([key, process.env[key]]);
  putEnv(key, value);
}

/** 用例里有 `000` 与 `0500` 的目录：先放开权限再删。 */
function unlock(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      unlock(join(dir, entry.name));
    }
  }
}

/** 在测试文件顶层调用一次：关转换器、还原环境与探针、删临时目录、断言没有被拒绝的启动。 */
export function useOfficeBenches(): void {
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((closer) => closer.close()));
    for (const [key, value] of envBefore.splice(0).reverse()) {
      putEnv(key, value);
    }
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      unlock(root);
      rmSync(root, { recursive: true, force: true });
    }
    expect(refused.splice(0)).toEqual([]);
  });
}

/** 缓存目录的三层由入口（15.1）建；这里照它的权限位建出来。 */
export function bench(layout: { sudo: boolean } = { sudo: true }): Bench {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-cache-")));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const work = join(cacheDir, "work");
  const pdf = join(cacheDir, "pdf");
  const bin = join(root, "bin");
  for (const dir of [cacheDir, pdf, work, bin, join(root, "ws")]) {
    mkdirSync(dir, 0o700);
  }
  chmodSync(cacheDir, 0o2750);
  chmodSync(work, 0o2770);
  if (layout.sudo) {
    symlinkSync(FAKE_SUDO, join(bin, "sudo"));
  }
  const launches: Launch[] = [];
  const made: Bench = {
    root,
    cacheDir,
    work,
    pdf,
    bin,
    launches,
    standIn: undefined,
    spawn(command, args, options) {
      // 裸名只许在测试的 bin 目录里解析：子进程环境的 PATH 首项必须是它。
      if (!command.includes("/") && (options.env?.PATH ?? "").split(":")[0] !== bin) {
        refused.push(command);
        throw new Error(`refusing to resolve ${command} outside the test bin dir`);
      }
      const standIn = made.standIn;
      made.standIn = undefined;
      const child =
        standIn === undefined
          ? spawn(command, [...args], options)
          : spawn(process.execPath, ["-e", ...standIn], options);
      launches.push({ command, args, options, child });
      return child;
    },
    input(name) {
      const path = join(root, "ws", name);
      writeFileSync(path, BODY);
      utimesSync(path, INPUT_MTIME_S, INPUT_MTIME_S);
      return path;
    },
  };
  return made;
}
