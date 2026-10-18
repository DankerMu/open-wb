/**
 * Issue #1072：`office-cache.test.ts` 与 `office-queue.test.ts` 共用的搭建——临时缓存目录、临时 spool
 * 与其上的进程内假 sidecar（issue 1505 起；`support/fake-sidecar.ts`，不做任何隔离）。
 *
 * `launches` 是假 sidecar 至今发现的作业（每次读取先同步扫一遍 `jobs/`），是「零作业」「恰一次」
 * 「重新转换」的判据：转换器在 `convert` 返回之前同步建出作业目录与 `in/<名字>`，所以调用一返回
 * 它就看得见。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import {
  type FakeJob,
  type FakeSidecar,
  startFakeSidecar,
  stopFakeSidecars,
} from "./support/fake-sidecar.js";

export { PDF } from "./support/fake-sidecar.js";
/** 26 个 ASCII 字节：键里的 `size` 因此是字面量 `26`。 */
export const BODY = "not a real office document";
/** 输入的修改时间钉成整秒：键里的 `mtimeMs` 因此是字面量 `1700000000000`。 */
export const INPUT_MTIME_S = 1_700_000_000;

export interface Bench {
  root: string;
  cacheDir: string;
  pdf: string;
  /** 部署方建好的 spool（`0700`）与入口建的 `jobs/`（`0700`）。 */
  spool: string;
  jobs: string;
  /** 对这个 spool 应答的假 sidecar（心跳新鲜）。 */
  sidecar: FakeSidecar;
  /** 假 sidecar 至今发现的作业，按发现的次序。 */
  readonly launches: FakeJob[];
  /** 在「工作空间」里写一个输入文件并把修改时间钉成整秒，返回绝对路径。 */
  input(name: string): string;
}

const roots: string[] = [];
/** 用例结束时要关掉的转换器。 */
export const closers: Array<{ close(): Promise<void> }> = [];
/** 用例里有 `000` 与 `0500` 的目录：先放开权限再删。 */
function unlock(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      unlock(join(dir, entry.name));
    }
  }
}

/** 在测试文件顶层调用一次：关转换器、停假 sidecar、跑 `settled`、还原探针、删临时目录。 */
export function useOfficeBenches(settled?: () => void): void {
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((closer) => closer.close()));
    stopFakeSidecars();
    try {
      settled?.();
    } finally {
      vi.restoreAllMocks();
      for (const root of roots.splice(0)) {
        unlock(root);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

/** 入口建好的布局（缓存根 `2750`、`pdf` `0700`；spool 与 `jobs/` `0700`），假 sidecar 已在应答。 */
export function bench(): Bench {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-cache-")));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const pdf = join(cacheDir, "pdf");
  const spool = join(root, "spool");
  const jobs = join(spool, "jobs");
  for (const dir of [cacheDir, pdf, spool, jobs, join(root, "ws")]) {
    mkdirSync(dir, 0o700);
  }
  chmodSync(cacheDir, 0o2750);
  const sidecar = startFakeSidecar(spool);
  return {
    root,
    cacheDir,
    pdf,
    spool,
    jobs,
    sidecar,
    get launches() {
      return sidecar.jobs();
    },
    input(name) {
      const path = join(root, "ws", name);
      writeFileSync(path, BODY);
      utimesSync(path, INPUT_MTIME_S, INPUT_MTIME_S);
      return path;
    },
  };
}
