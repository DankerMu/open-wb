/**
 * 线程池占满时的离线恢复（#1795 评审 F1）：`mounts-manager-recovery.test.ts` 以 `UV_THREADPOOL_SIZE=1`
 * 起这个子进程，参数是一段 JSON（见下文 `input`）。它在本进程里装起真 manager（Node 的类型剥离直接
 * 读 `server/src` 的 `.ts`，下面的解析钩子把相对导入的 `.js` 落到 `.ts`），对着假 rclone / 假
 * `fusermount3` / 假 mountinfo 恢复出一个 `sftp` 挂载，然后：
 *
 * 1. `fs.promises.open` 一个没有写端的 FIFO——它在唯一的线程池线程上阻塞，等同一次卡住的 FUSE 请求；
 *    之后发起的一次 `fs.promises.stat` 200 ms 内不返回，即证明线程池已被占满（`poolBlocked`）。
 * 2. 经 manager 的适配器发起一次永不返回的调用（注入的 `mountFs`），200 ms 期限一到 manager 判离线。
 * 3. 至多等 15 s（只是上限：两件事一成即停；满载的测试机上起一个假 `fusermount3` 要几秒）：rclone 已被结束
 *    （`rcloneDead`）且假 `fusermount3` 已记下 `-uz`（`unmounted`）即恢复完成。
 *
 * 结果以一行 JSON 写到标准输出；无论成败都先以写端打开 FIFO 放回那个线程，再退出。
 */
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

/**
 * `{managerPath, record, mountsDir, state, root, bin, mountinfo, rcloneBin, fusermountBin, fifo}`：
 * `record` 是父进程登记好的挂载行（私有目录与 `rclone.conf` 已备好）。
 */
const input = JSON.parse(process.argv[2] ?? "{}");
const { createMountManager } = await import(input.managerPath);

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 只用同步读：线程池被占着，这里的轮询不能排到它后面。 */
const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

const errors = [];
const manager = createMountManager({
  store: { listAll: () => [input.record], getSource: () => undefined },
  audit: { emit: () => undefined },
  mountsDir: input.mountsDir,
  workspaceRootOf: () => input.root,
  protectedRoots: [],
  onError: (error) => errors.push(String(error)),
  rcloneBin: input.rcloneBin,
  fusermountBin: input.fusermountBin,
  mountinfoPath: input.mountinfo,
  path: input.bin,
  resolveHost: async () => [{ address: "10.0.0.7" }],
  probeExec: async () => true,
  connect: async () => true,
  ensureSharedDir: (absPath) => mkdirSync(absPath),
  mountFs: {
    lstat: () => new Promise(() => undefined),
    readdir: () => new Promise(() => undefined),
    open: () => new Promise(() => undefined),
    mkdir: () => new Promise(() => undefined),
    rename: () => new Promise(() => undefined),
  },
  mountFsDeadlineMs: 200,
});

const result = { online: false, poolBlocked: false, offline: false, rcloneDead: false };
await manager.restoreAll();
result.online = manager.statusOf(input.record.id) === "online";
const rclonePid = lines(join(input.state, "fake-rclone-calls.jsonl")).find(
  (call) => call.argv[1] === "mount",
)?.pid;
const mountPoint = join(input.root, input.record.name);

// 1. The one pool thread blocks in open(2) on a FIFO with no writer.
const blocking = open(input.fifo, "r");
let statDone = false;
void stat(input.state).then(() => {
  statDone = true;
});
await sleep(200);
result.poolBlocked = !statDone;

// 2. A call in the mount that never returns; its deadline makes the mount offline.
const call = manager.fs.lstat(input.record.id, join(mountPoint, "a.md")).catch((error) => error);
const refused = await call;
result.refused = refused?.code;
result.offline = manager.statusOf(input.record.id) === "offline";

// 3. The recovery: rclone gone and `-uz` run, all while the pool stays blocked.
const unmountedAt = () =>
  lines(join(input.bin, "fusermount3-calls.jsonl")).filter((line) => line.argv[1] === mountPoint);
const waitUntil = Date.now() + 15_000;
while (Date.now() < waitUntil) {
  if (rclonePid !== undefined && !alive(rclonePid) && unmountedAt().length > 0) {
    break;
  }
  await sleep(20);
}
result.rcloneDead = rclonePid !== undefined && !alive(rclonePid);
result.unmounted = unmountedAt();
result.stillBlocked = !statDone;
result.errors = errors;
process.stdout.write(`${JSON.stringify(result)}\n`);

// Release the thread: a writer for the FIFO (non-blocking; a reader is waiting in open).
let writer;
try {
  writer = openSync(input.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
} catch {
  writer = openSync(input.fifo, constants.O_WRONLY);
}
closeSync(writer);
await blocking.then((handle) => handle.close()).catch(() => undefined);
process.exit(0);
