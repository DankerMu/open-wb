/**
 * 办公文档转换的并发上限、排队与去重（office-preview「并发上限与排队」；design D17）。
 *
 * 只管「一个键的任务何时开始、何时被中止」：不碰文件系统，不启动进程，任务由调用方给（实际是
 * `office-cache.ts` 的「转换 + 改名进缓存」）。同一个键的并发调用合成一组，共用一次任务与一个
 * 结果，只占一个运行或排队位置；运行中的组数不超过 `concurrency`，排队的组数不超过 8，按入队次序
 * 启动。准入是同步的：`run()` 返回之前，这个调用要么已经加入某一组，要么已经启动了任务，要么已经
 * 入队或被拒绝——到达次序就是调用次序，中间没有 `await`。
 *
 * 交给任务的中止信号是每组一个的内部信号，不是任何调用方的：某个调用方中止只让它自己立即以
 * `aborted` 落定；全部调用方都中止时，排队的组出队、不启动，运行中的组才中止任务。运行中的组的
 * 名额在任务落定时才放，不在中止那一刻放——此时进程可能还没退出。
 */
import { OfficeConvertError } from "./office.js";

/** 排队的组数上限；写死，不是配置项。 */
const QUEUE_LIMIT = 8;

type OfficeTask = (signal: AbortSignal) => Promise<string>;

interface Group {
  key: string;
  task: OfficeTask;
  /** 交给任务的中止信号：只在最后一个调用方也中止时，或 `close()` 时触发。 */
  controller: AbortController;
  /** 还没有中止的调用方个数。 */
  callers: number;
  state: "queued" | "running" | "settled";
  shared: Promise<string>;
  resolve(path: string): void;
  reject(reason: unknown): void;
}

function aborted(): OfficeConvertError {
  return new OfficeConvertError("aborted");
}

function createGroup(key: string, task: OfficeTask): Group {
  let resolve: Group["resolve"] = () => undefined;
  let reject: Group["reject"] = () => undefined;
  const shared = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // 调用方全部中止之后没有人等这个结果：它的失败不该冒成未处理的拒绝。
  shared.catch(() => undefined);
  const controller = new AbortController();
  return { key, task, controller, callers: 0, state: "queued", shared, resolve, reject };
}

export function createOfficeQueue(options: { concurrency: number }): {
  /**
   * `key` 已有一组时加入它（不占新位置，也不会是 `busy`），`task` 被忽略；否则有空位即同步调用
   * `task`，没有空位就入队，排队已满则以 `busy` 拒绝。`signal` 中止时这个调用立即以 `aborted` 落定。
   */
  run(key: string, task: OfficeTask, signal?: AbortSignal): Promise<string>;
  /** 排队的组全部以 `aborted` 拒绝、不启动；运行中的组中止任务。其后的 `run` 以 `aborted` 拒绝。 */
  close(): void;
} {
  const { concurrency } = options;
  // 0 会让每个调用永远排队。
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
  /** 键 → 还能加入的那一组。运行中而调用方已全部中止的组不在这里，但仍在 `running` 里占着名额。 */
  const joinable = new Map<string, Group>();
  const waiting: Group[] = [];
  const running = new Set<Group>();
  let closed = false;

  function forget(group: Group): void {
    // 同一个键可能已经另开了一组：只删自己。
    if (joinable.get(group.key) === group) {
      joinable.delete(group.key);
    }
  }

  /** 名额只在这里放：任务落定（成败都算），随后按入队次序启动下一组，最后才通知调用方。 */
  function start(group: Group): void {
    group.state = "running";
    running.add(group);
    const release = (): void => {
      group.state = "settled";
      running.delete(group);
      forget(group);
      startWaiting();
    };
    // 在 executor 里调用：任务同步执行到它的第一个 await，同步抛出的也变成拒绝。
    new Promise<string>((resolve) => {
      resolve(group.task(group.controller.signal));
    }).then(
      (path) => {
        release();
        group.resolve(path);
      },
      (reason: unknown) => {
        release();
        group.reject(reason);
      },
    );
  }

  function startWaiting(): void {
    while (running.size < concurrency) {
      const next = waiting.shift();
      if (next === undefined) {
        return;
      }
      start(next);
    }
  }

  /** 新开一组；排队已满时返回 `undefined`。 */
  function admit(key: string, task: OfficeTask): Group | undefined {
    const free = running.size < concurrency;
    if (!free && waiting.length >= QUEUE_LIMIT) {
      return undefined;
    }
    const group = createGroup(key, task);
    joinable.set(key, group);
    if (free) {
      start(group);
    } else {
      waiting.push(group);
    }
    return group;
  }

  /** 一个调用方中止之后。组已经落定（结果只是还没送到它手上）时什么都不做。 */
  function leave(group: Group): void {
    if (group.state === "settled") {
      return;
    }
    group.callers -= 1;
    if (group.callers > 0) {
      return;
    }
    // 没有人等了：其后同键的调用另开一组，不挂在这一组上。
    forget(group);
    if (group.state === "running") {
      // 名额不在这里放：等任务落定（进程退出）。
      group.controller.abort();
      return;
    }
    group.state = "settled";
    waiting.splice(waiting.indexOf(group), 1);
    group.reject(aborted());
  }

  function join(group: Group, signal?: AbortSignal): Promise<string> {
    group.callers += 1;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(aborted());
        leave(group);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      group.shared.then(
        (path) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(path);
        },
        (reason: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      );
    });
  }

  return {
    run(key, task, signal) {
      if (closed || signal?.aborted === true) {
        return Promise.reject(aborted());
      }
      const group = joinable.get(key) ?? admit(key, task);
      if (group === undefined) {
        return Promise.reject(new OfficeConvertError("busy"));
      }
      return join(group, signal);
    },
    close() {
      closed = true;
      for (const group of waiting.splice(0)) {
        group.state = "settled";
        forget(group);
        group.reject(aborted());
      }
      for (const group of running) {
        group.controller.abort();
      }
    },
  };
}
