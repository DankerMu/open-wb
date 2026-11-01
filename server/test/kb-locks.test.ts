/**
 * Issue #1837（任务 7.2 剩余部分）：knowledge-bases「同一知识库的写操作串行」的锁本身、ragflow-backend
 * 的进程级设置锁（design D20）。
 *
 * 经 `createKbLocks` 这一个公开入口测。谁持锁、谁排队、何时放行全由测试手里的 `held` 决定，不靠定时
 * 等待；「立即」一律指只让微任务跑完（`microtasks()`）。等待者计数在调用之后同步读：组 8 的交错用例要
 * 靠它确认 B 已在排队、再发出 A，所以入队不能晚于调用返回。
 */
import { describe, expect, it, vi } from "vitest";
import { createKbLocks } from "../src/kb/locks.js";

type Locks = ReturnType<typeof createKbLocks>;

interface Held {
  work: () => Promise<string>;
  finish: () => void;
  fail: (reason: unknown) => void;
}

/** 一段挂起的工作：开始与结束记进 `trace`，何时结束由测试决定。 */
function held(trace: string[], name: string): Held {
  let finish!: Held["finish"];
  let fail!: Held["fail"];
  const gate = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    finish,
    fail,
    work: async () => {
      trace.push(`${name} 开始`);
      await gate;
      trace.push(`${name} 结束`);
      return name;
    },
  };
}

/** 只跑微任务：定时器与进程事件一个都轮不到，所以其后看到的状态都是「立即」发生的。 */
async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

const BOTH_LOCKS = [
  {
    lock: "每库写锁",
    enter: (locks: Locks, work: () => Promise<string>): Promise<unknown> =>
      locks.write("kb-a", work),
    waiters: (locks: Locks): number => locks.writeWaiters("kb-a"),
  },
  {
    lock: "设置锁",
    enter: (locks: Locks, work: () => Promise<string>): Promise<unknown> => locks.settings(work),
    waiters: (locks: Locks): number => locks.settingsWaiters(),
  },
];

describe.each(BOTH_LOCKS)("$lock按到达次序交锁", ({ enter, waiters }) => {
  it("持锁期间排入三个等待者：放行后执行次序等于排队次序，计数随排队与交锁增减", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const holder = held(trace, "持锁者");
    const first = held(trace, "一");
    const second = held(trace, "二");
    const third = held(trace, "三");

    expect(waiters(locks)).toBe(0);
    const runs = [enter(locks, holder.work)];
    expect(waiters(locks)).toBe(0);
    runs.push(enter(locks, first.work));
    expect(waiters(locks)).toBe(1);
    runs.push(enter(locks, second.work));
    expect(waiters(locks)).toBe(2);
    runs.push(enter(locks, third.work));
    expect(waiters(locks)).toBe(3);

    await microtasks();
    expect(trace).toEqual(["持锁者 开始"]);

    holder.finish();
    await microtasks();
    expect(waiters(locks)).toBe(2);
    expect(trace).toEqual(["持锁者 开始", "持锁者 结束", "一 开始"]);

    first.finish();
    await microtasks();
    expect(waiters(locks)).toBe(1);
    expect(trace).toEqual(["持锁者 开始", "持锁者 结束", "一 开始", "一 结束", "二 开始"]);

    second.finish();
    await microtasks();
    expect(waiters(locks)).toBe(0);

    third.finish();
    await Promise.all(runs);
    expect(waiters(locks)).toBe(0);
    expect(trace).toEqual([
      "持锁者 开始",
      "持锁者 结束",
      "一 开始",
      "一 结束",
      "二 开始",
      "二 结束",
      "三 开始",
      "三 结束",
    ]);
  });

  it("排在中间的等待者抛错：原错误交给它自己，后面的次序不变", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const holder = held(trace, "持锁者");
    const failing = held(trace, "失败者");
    const last = held(trace, "末尾");
    const boom = new Error("下发失败");

    const holding = enter(locks, holder.work);
    const failed = enter(locks, failing.work);
    const ending = enter(locks, last.work);
    holder.finish();
    await holding;
    await microtasks();
    failing.fail(boom);
    await expect(failed).rejects.toBe(boom);
    await microtasks();
    expect(waiters(locks)).toBe(0);
    last.finish();
    await ending;

    expect(trace).toEqual(["持锁者 开始", "持锁者 结束", "失败者 开始", "末尾 开始", "末尾 结束"]);
  });

  it("工作同步抛错同样释放，并以拒绝交给调用方", async () => {
    const locks = createKbLocks();
    const boom = new Error("同步失败");
    const trace: string[] = [];
    const after = held(trace, "其后");

    await expect(
      enter(locks, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const running = enter(locks, after.work);
    await microtasks();
    expect(trace).toEqual(["其后 开始"]);
    after.finish();
    await running;
  });

  it("放行瞬间到达的新请求不插到已排队者之前", async () => {
    // 放行要隔若干个微任务才落到锁上：逐个时机都让一个新来者撞上去。
    for (let turns = 0; turns < 8; turns += 1) {
      const locks = createKbLocks();
      const trace: string[] = [];
      const holder = held(trace, "持锁者");
      const queued = held(trace, "排队者");
      const newcomer = held(trace, "新来者");

      const runs = [enter(locks, holder.work), enter(locks, queued.work)];
      holder.finish();
      for (let turn = 0; turn < turns; turn += 1) {
        await Promise.resolve();
      }
      runs.push(enter(locks, newcomer.work));
      await microtasks();
      expect(trace, `放行后第 ${turns} 个微任务`).toEqual([
        "持锁者 开始",
        "持锁者 结束",
        "排队者 开始",
      ]);

      queued.finish();
      newcomer.finish();
      await Promise.all(runs);
    }
  });
});

describe("每库写锁", () => {
  it("同一知识库的两个写操作串行：后一个等前一个落定才开始，各拿各的结果", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const one = held(trace, "上传");
    const two = held(trace, "移出");

    const first = locks.write("kb-a", one.work);
    const second = locks.write("kb-a", two.work);
    await microtasks();
    expect(trace).toEqual(["上传 开始"]);

    one.finish();
    await expect(first).resolves.toEqual({ outcome: "ok", value: "上传" });
    await microtasks();
    two.finish();
    await expect(second).resolves.toEqual({ outcome: "ok", value: "移出" });

    expect(trace).toEqual(["上传 开始", "上传 结束", "移出 开始", "移出 结束"]);
  });

  it("不同知识库的写操作并行：一个库挂着，另一个库照常开始并落定", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const stuck = held(trace, "甲库");
    const other = held(trace, "乙库");

    const stuckRun = locks.write("kb-a", stuck.work);
    const otherRun = locks.write("kb-b", other.work);
    await microtasks();
    expect(trace).toEqual(["甲库 开始", "乙库 开始"]);
    expect(locks.writeWaiters("kb-a")).toBe(0);
    expect(locks.writeWaiters("kb-b")).toBe(0);

    other.finish();
    await expect(otherRun).resolves.toEqual({ outcome: "ok", value: "乙库" });
    expect(trace).toEqual(["甲库 开始", "乙库 开始", "乙库 结束"]);

    stuck.finish();
    await stuckRun;
  });

  it("等待者计数按库分开", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const holder = held(trace, "持锁者");
    const waiting = held(trace, "等待者");

    const runs = [locks.write("kb-a", holder.work), locks.write("kb-a", waiting.work)];
    expect(locks.writeWaiters("kb-a")).toBe(1);
    expect(locks.writeWaiters("kb-b")).toBe(0);

    holder.finish();
    await microtasks();
    waiting.finish();
    await Promise.all(runs);
  });
});

describe("重建器与写操作", () => {
  it("锁被重建器持有时，写操作立即得到「重建中」，不排队也不执行", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const rebuilder = held(trace, "重建器");
    const write = vi.fn(async () => "不该执行");

    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    await microtasks();

    const refused = locks.write("kb-a", write);
    expect(locks.writeWaiters("kb-a")).toBe(0);
    // 重建器还挂着：这里能等到结果，就说明写操作没有排在它后面。
    await expect(refused).resolves.toEqual({ outcome: "rebuilding" });
    expect(write).not.toHaveBeenCalled();
    expect(trace).toEqual(["重建器 开始"]);

    rebuilder.finish();
    await expect(rebuilding).resolves.toBe("重建器");
  });

  it("重建器只挡它持有的那个库", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const rebuilder = held(trace, "重建器");
    const other = held(trace, "乙库");

    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    const otherRun = locks.write("kb-b", other.work);
    other.finish();
    await expect(otherRun).resolves.toEqual({ outcome: "ok", value: "乙库" });

    rebuilder.finish();
    await rebuilding;
  });

  it("重建器释放后写操作恢复", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const rebuilder = held(trace, "重建器");

    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    await expect(locks.write("kb-a", async () => "早到")).resolves.toEqual({
      outcome: "rebuilding",
    });

    rebuilder.finish();
    await rebuilding;
    await expect(locks.write("kb-a", async () => "晚到")).resolves.toEqual({
      outcome: "ok",
      value: "晚到",
    });
  });

  it("重建器抛错后释放：原错误交给重建器，写操作恢复", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const rebuilder = held(trace, "重建器");
    const boom = new Error("重建失败");

    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    await microtasks();
    rebuilder.fail(boom);
    await expect(rebuilding).rejects.toBe(boom);

    await expect(locks.write("kb-a", async () => "恢复")).resolves.toEqual({
      outcome: "ok",
      value: "恢复",
    });
  });

  it("重建器取锁要等在途写操作结束，排队期间算一个等待者", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const upload = held(trace, "上传");
    const rebuilder = held(trace, "重建器");

    const uploading = locks.write("kb-a", upload.work);
    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    expect(locks.writeWaiters("kb-a")).toBe(1);
    await microtasks();
    expect(trace).toEqual(["上传 开始"]);

    upload.finish();
    await expect(uploading).resolves.toEqual({ outcome: "ok", value: "上传" });
    await microtasks();
    expect(locks.writeWaiters("kb-a")).toBe(0);
    expect(trace).toEqual(["上传 开始", "上传 结束", "重建器 开始"]);

    rebuilder.finish();
    await rebuilding;
  });

  it("排在重建器之前的写操作先执行，不得到「重建中」，取锁后的重判归调用方", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const inFlight = held(trace, "在途写");
    const queued = held(trace, "排队写");
    const rebuilder = held(trace, "重建器");

    const runs = locks.write("kb-a", inFlight.work);
    const queuedRun = locks.write("kb-a", queued.work);
    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    expect(locks.writeWaiters("kb-a")).toBe(2);

    inFlight.finish();
    await runs;
    await microtasks();
    expect(trace).toEqual(["在途写 开始", "在途写 结束", "排队写 开始"]);

    queued.finish();
    await expect(queuedRun).resolves.toEqual({ outcome: "ok", value: "排队写" });
    await microtasks();
    rebuilder.finish();
    await rebuilding;

    expect(trace).toEqual([
      "在途写 开始",
      "在途写 结束",
      "排队写 开始",
      "排队写 结束",
      "重建器 开始",
      "重建器 结束",
    ]);
  });

  it("重建器还在等锁时到达的写操作排在它之后；重建器持有后再到的才被拒绝", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const inFlight = held(trace, "在途写");
    const rebuilder = held(trace, "重建器");
    const behind = held(trace, "排在其后");
    const late = vi.fn(async () => "不该执行");

    const flying = locks.write("kb-a", inFlight.work);
    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    const behindRun = locks.write("kb-a", behind.work);
    expect(locks.writeWaiters("kb-a")).toBe(2);

    inFlight.finish();
    await flying;
    await microtasks();
    expect(trace).toEqual(["在途写 开始", "在途写 结束", "重建器 开始"]);
    expect(locks.writeWaiters("kb-a")).toBe(1);

    await expect(locks.write("kb-a", late)).resolves.toEqual({ outcome: "rebuilding" });
    expect(late).not.toHaveBeenCalled();
    expect(locks.writeWaiters("kb-a")).toBe(1);

    rebuilder.finish();
    await rebuilding;
    await microtasks();
    behind.finish();
    await expect(behindRun).resolves.toEqual({ outcome: "ok", value: "排在其后" });

    expect(trace).toEqual([
      "在途写 开始",
      "在途写 结束",
      "重建器 开始",
      "重建器 结束",
      "排在其后 开始",
      "排在其后 结束",
    ]);
  });
});

describe("设置锁", () => {
  it("两个设置写入串行：后一个等前一个落定才开始，结果原样交回", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const one = held(trace, "甲");
    const two = held(trace, "乙");

    const first = locks.settings(one.work);
    const second = locks.settings(two.work);
    await microtasks();
    expect(trace).toEqual(["甲 开始"]);

    one.finish();
    await expect(first).resolves.toBe("甲");
    await microtasks();
    two.finish();
    await expect(second).resolves.toBe("乙");

    expect(trace).toEqual(["甲 开始", "甲 结束", "乙 开始", "乙 结束"]);
  });

  it("设置锁与写锁互不相干：一把挂着不挡另一把", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const setting = held(trace, "设置");
    const write = held(trace, "写");

    const settingRun = locks.settings(setting.work);
    const writeRun = locks.write("kb-a", write.work);
    await microtasks();
    expect(trace).toEqual(["设置 开始", "写 开始"]);

    setting.finish();
    write.finish();
    await Promise.all([settingRun, writeRun]);
  });
});

describe("锁表回收", () => {
  it("知识库的锁只在用着时占条目：落定后回收，不随知识库个数增长", async () => {
    const locks = createKbLocks();
    expect(locks.writeLockCount()).toBe(0);

    for (let index = 0; index < 100; index += 1) {
      await locks.write(`kb-${index}`, async () => "写");
    }
    await locks.rebuild("kb-rebuilt", async () => "重建");
    expect(locks.writeLockCount()).toBe(0);
  });

  it("还有等待者时条目留着，最后一个落定才回收", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const holder = held(trace, "持锁者");
    const waiting = held(trace, "等待者");

    const runs = [locks.write("kb-a", holder.work), locks.write("kb-a", waiting.work)];
    expect(locks.writeLockCount()).toBe(1);

    holder.finish();
    await runs[0];
    await microtasks();
    expect(locks.writeLockCount()).toBe(1);

    waiting.finish();
    await runs[1];
    expect(locks.writeLockCount()).toBe(0);
  });

  it("抛错的写操作、抛错的重建器与被拒绝的写操作都不留条目", async () => {
    const locks = createKbLocks();
    const trace: string[] = [];
    const rebuilder = held(trace, "重建器");
    const boom = new Error("失败");

    await expect(
      locks.write("kb-a", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(locks.writeLockCount()).toBe(0);

    const rebuilding = locks.rebuild("kb-a", rebuilder.work);
    await locks.write("kb-a", async () => "被拒绝");
    expect(locks.writeLockCount()).toBe(1);

    await microtasks();
    rebuilder.fail(boom);
    await expect(rebuilding).rejects.toBe(boom);
    expect(locks.writeLockCount()).toBe(0);
  });
});
