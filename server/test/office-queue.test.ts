/**
 * Issue #1073（任务 14.2，含分摊的 14.5 / 14.6 条款）：office-preview「并发上限与排队」——并发上限、
 * 排队上限 8、按缓存键去重、中止与出队、名额的释放。
 *
 * 经 `createOfficeCache` 这一个公开入口测，转换对着 `fixtures/fake-soffice.mjs` 真实 spawn。`@gate`
 * 的假进程写好输出后一直等 `<输入路径>.release` 出现才退出，所以「谁在运行、谁在排队」由测试定。
 * 准入是同步的：`convert()` 返回时该启动的已经记在 `launches` 里，「至多 2 个」「零启动」直接断言它，
 * 不靠定时等待；「立即」一律指只让微任务跑完（`microtasks()`），其间没有任何进程事件。期望的缓存
 * 路径照规格的键字面拼，不引用源码。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficeConverter, OfficeConvertError } from "../src/preview/office.js";
import { createOfficeCache } from "../src/preview/office-cache.js";
import { createOfficeQueue } from "../src/preview/office-queue.js";
import {
  type Bench,
  bench,
  closers,
  FAKE_SOFFICE,
  PDF,
  setEnv,
  useOfficeBenches,
} from "./office-cache-helpers.js";
import { useSetprivStub } from "./support/setpriv.js";

const BAD_CONCURRENCY = "concurrency must be a positive integer";
/** 等一个被杀的假进程真的退出；夹具自己要 30 秒才退，所以到时还在就是没被杀。 */
const GONE_WITHIN = { timeout: 6_000, interval: 10 };

interface Rig extends Bench {
  /** 每次启动那一刻，此前启动的假进程里还没退出的个数。 */
  runningAtLaunch: number[];
}

/** 一次 `convert` 调用的现状：`pending`、失败的种类，或成功落定的路径。 */
interface Call {
  promise: Promise<string>;
  state: string;
}

const rigs: Rig[] = [];

// 先注册的后执行：`useOfficeBenches` 的钩子关掉转换器之后，这里核对没有留下任何假进程。
afterEach(() => {
  const alive = rigs.splice(0).flatMap((on) => on.launches.filter(({ child }) => isRunning(child)));
  for (const { child } of alive) {
    child.kill("SIGKILL");
  }
  expect(alive.map(({ child }) => child.pid)).toEqual([]);
});
useSetprivStub();
useOfficeBenches();

function isRunning(child: { exitCode: number | null; signalCode: string | null }): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function rig(layout?: { sudo: boolean }): Rig {
  const on = Object.assign(bench(layout), { runningAtLaunch: [] as number[] });
  const spawnRecorded = on.spawn;
  on.spawn = (command, args, options) => {
    on.runningAtLaunch.push(on.launches.filter(({ child }) => isRunning(child)).length);
    return spawnRecorded(command, args, options);
  };
  rigs.push(on);
  return on;
}

function cacheOn(
  on: Rig,
  options: { concurrency: number; timeoutMs?: number; ompUser?: string },
): ReturnType<typeof createOfficeCache> {
  const converter = createOfficeConverter({
    officeBin: FAKE_SOFFICE,
    cacheDir: on.cacheDir,
    timeoutMs: options.timeoutMs ?? 20_000,
    spawn: on.spawn,
    ...(options.ompUser === undefined ? {} : { ompUser: options.ompUser }),
  });
  const cache = createOfficeCache({
    cacheDir: on.cacheDir,
    converter,
    concurrency: options.concurrency,
  });
  closers.push(cache);
  return cache;
}

/** 规格的键照字面拼：`bench.input` 写的是 26 字节、修改时间钉在 1700000000 秒。 */
function slotOf(on: Rig, input: string): string {
  const key = createHash("sha256").update(`${input}\0${"1700000000000"}\0${"26"}`, "utf8");
  return join(on.pdf, `${key.digest("hex")}.pdf`);
}

function watch(promise: Promise<string>): Call {
  const call: Call = { promise, state: "pending" };
  promise.then(
    (path) => {
      call.state = path;
    },
    (reason: unknown) => {
      call.state = reason instanceof OfficeConvertError ? reason.kind : "not an OfficeConvertError";
    },
  );
  return call;
}

function states(calls: Call[]): string[] {
  return calls.map((call) => call.state);
}

/** 只跑微任务：定时器与进程事件一个都轮不到，所以其后看到的状态都是「立即」发生的。 */
async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

function release(...inputs: string[]): void {
  for (const input of inputs) {
    writeFileSync(`${input}.release`, "");
  }
}

/** 每次启动的输入路径（argv 的最后一项），按启动次序。 */
function launched(on: Rig): Array<string | undefined> {
  return on.launches.map(({ args }) => args.at(-1));
}

function jobDirs(on: Rig): string[] {
  return readdirSync(on.work, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function gates(on: Rig, names: string[]): string[] {
  return names.map((name) => on.input(`${name}@gate.docx`));
}

const EIGHT = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"];

describe("并发上限与排队：不超过上限并按序启动", { timeout: 20_000 }, () => {
  it("并发 2、五个不同输入：同时运行至多 2 个，放行一个恰启动下一个，启动次序等于到达次序", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 2 });
    const inputs = gates(on, ["1", "2", "3", "4", "5"]);

    const calls = inputs.map((input) => watch(cache.convert(input)));

    // 五次调用刚返回，没有让出过事件循环。
    expect(launched(on)).toEqual(inputs.slice(0, 2));
    // 放行的次序不等于到达次序：后启动的先结束，接上来的仍是到达最早的那个。
    for (const [step, index] of [1, 0, 2, 4, 3].entries()) {
      release(inputs[index] as string);
      expect(await calls[index]?.promise).toBe(slotOf(on, inputs[index] as string));
      // 名额先放、下一个先启动，然后才通知调用方：这里不用等。
      expect(launched(on)).toEqual(inputs.slice(0, Math.min(5, step + 3)));
    }
    // 第一个启动时没有别的在跑，其后每一个启动时恰有一个在跑：任一时刻至多 2 个。
    expect(on.runningAtLaunch).toEqual([0, 1, 1, 1, 1]);
    expect(states(calls)).toEqual(inputs.map((input) => slotOf(on, input)));
    expect(jobDirs(on)).toEqual([]);
  });

  it.each<[kind: string, name: string, timeoutMs: number]>([
    ["timeout", "a@sleep.docx", 2_000],
    ["failed", "a@exit1.docx", 20_000],
  ])(
    "超时与非 0 退出之后名额已释放：下一个立即启动（同 uid）——%s",
    async (kind, name, timeoutMs) => {
      const on = rig();
      const cache = cacheOn(on, { concurrency: 1, timeoutMs });
      const failing = on.input(name);
      const next = on.input("b@gate.docx");

      const first = watch(cache.convert(failing));
      const second = watch(cache.convert(next));
      expect(on.launches).toHaveLength(1);
      await first.promise.catch(() => undefined);

      // 第一个的失败刚通知到这里，第二个已经启动了。
      expect(first.state).toBe(kind);
      expect(launched(on)).toEqual([failing, next]);
      release(next);
      expect(await second.promise).toBe(slotOf(on, next));
    },
  );

  it("运行中的组全部中止：名额等被杀的进程落定才放，此前下一个没有启动", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const abort = new AbortController();
    const next = on.input("b@gate.docx");
    const first = watch(cache.convert(on.input("a@sleep.docx"), abort.signal));
    const second = watch(cache.convert(next));
    const dying = on.launches[0]?.child;
    let launchesAtExit: number | undefined;
    // 排在转换器自己的 exit 监听之后、它引出的微任务之前。
    dying?.once("exit", () => {
      launchesAtExit = on.launches.length;
    });

    abort.abort();
    await microtasks();

    // 调用方立即落定，进程此刻还没退出：名额还占着。
    expect(first.state).toBe("aborted");
    expect(dying?.exitCode).toBe(null);
    expect(on.launches).toHaveLength(1);
    await vi.waitFor(() => expect(on.launches).toHaveLength(2), GONE_WITHIN);
    expect(dying?.signalCode).toBe("SIGKILL");
    expect(launchesAtExit).toBe(1);
    release(next);
    expect(await second.promise).toBe(slotOf(on, next));
  });

  it("OMP_USER 模式：假 sudo 被 SIGKILL 后名额已释放，随后的转换立即启动", async () => {
    const on = rig({ sudo: false });
    symlinkSync(FAKE_SOFFICE, join(on.bin, "sudo"));
    setEnv("PATH", `${on.bin}:${dirname(process.execPath)}:/usr/bin:/bin`);
    const cache = cacheOn(on, { concurrency: 1, timeoutMs: 3_000, ompUser: "omp" });
    const next = on.input("b.docx");

    const first = watch(cache.convert(on.input("a@spawn-sleep.docx")));
    const second = watch(cache.convert(next));
    expect(on.launches).toHaveLength(1);
    await first.promise.catch(() => undefined);

    const job = String(on.launches[0]?.options.cwd);
    const record = JSON.parse(
      readFileSync(join(on.work, `${basename(job)}.record.json`), "utf8"),
    ) as { childPid: number };
    try {
      expect(first.state).toBe("timeout");
      // 两次转换各恰启动一次假 sudo；第二次在第一次落定的同时就启动了。
      expect(on.launches.map(({ command }) => command)).toEqual(["sudo", "sudo"]);
      expect(on.launches[0]?.child.signalCode).toBe("SIGKILL");
      // 假 sudo 派生的进程没有随它结束（D-25 残余的同 uid 等价物）：它不占名额。
      expect(() => process.kill(record.childPid, 0)).not.toThrow();
      expect(await second.promise).toBe(slotOf(on, next));
    } finally {
      process.kill(record.childPid, "SIGKILL");
    }
  });
});

describe("并发上限与排队：队满", { timeout: 20_000 }, () => {
  it("并发 1、一个运行八个排队：第十个立即 busy，零启动、不建作业目录，先前九个成功", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const inputs = gates(on, ["run", ...EIGHT]);
    const calls = inputs.map((input) => watch(cache.convert(input)));
    expect(launched(on)).toEqual([inputs[0]]);
    const dirs = jobDirs(on);
    expect(dirs).toHaveLength(1);

    const tenth = watch(cache.convert(on.input("tenth@gate.docx")));
    await microtasks();

    expect(tenth.state).toBe("busy");
    expect(states(calls)).toEqual(inputs.map(() => "pending"));
    expect(on.launches).toHaveLength(1);
    expect(jobDirs(on)).toEqual(dirs);

    release(...inputs);
    expect(await Promise.all(calls.map((call) => call.promise))).toEqual(
      inputs.map((input) => slotOf(on, input)),
    );
    expect(launched(on)).toEqual(inputs);
    expect(readdirSync(on.pdf).sort()).toEqual(inputs.map((i) => basename(slotOf(on, i))).sort());
  });

  it("队满时加入已在排队或运行的键：不是 busy，不占新位置", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const [running, ...queued] = gates(on, ["run", ...EIGHT.slice(0, 7)]) as [string, ...string[]];
    const last = queued[6] as string;
    const calls = [running, ...queued].map((input) => watch(cache.convert(input)));
    // 七组在排队。对最后一组再调三次、对运行中的再调一次：排队的仍是七组。
    const joined = [last, last, last, running].map((input) => watch(cache.convert(input)));
    const [eighth, ninth] = gates(on, ["eighth", "ninth"]) as [string, string];

    const admitted = watch(cache.convert(eighth));
    const refused = watch(cache.convert(ninth));
    // 现在八组，满了：加入已有的键照常。
    const joinedWhenFull = [running, queued[0] as string, eighth].map((input) =>
      watch(cache.convert(input)),
    );
    await microtasks();

    expect(refused.state).toBe("busy");
    expect(states([...calls, ...joined, admitted, ...joinedWhenFull])).toEqual(
      new Array(16).fill("pending"),
    );
    expect(on.launches).toHaveLength(1);

    release(running, ...queued, eighth);
    await Promise.all([admitted, ...calls].map((call) => call.promise));
    await microtasks();
    // 每个键恰启动一次，加入者拿到的就是同组的那个路径。
    expect(launched(on)).toEqual([running, ...queued, eighth]);
    expect(states(joined)).toEqual([last, last, last, running].map((i) => slotOf(on, i)));
    expect(states(joinedWhenFull)).toEqual(
      [running, queued[0] as string, eighth].map((i) => slotOf(on, i)),
    );
  });

  it("已缓存的输入在队满时照常命中，不是 busy、零启动", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const cached = on.input("cached.docx");
    expect(await cache.convert(cached)).toBe(slotOf(on, cached));
    const calls = gates(on, ["run", ...EIGHT]).map((input) => watch(cache.convert(input)));
    expect(on.launches).toHaveLength(2);

    const hit = watch(cache.convert(cached));
    const refused = watch(cache.convert(on.input("over@gate.docx")));
    await microtasks();

    expect(hit.state).toBe(slotOf(on, cached));
    // 队确实满着：上一行不是因为还有空位。
    expect(refused.state).toBe("busy");
    expect(states(calls)).toEqual(new Array(9).fill("pending"));
    expect(on.launches).toHaveLength(2);
  });

  it("排队中的调用被中止：立即 aborted，不启动、不建作业目录，腾出的位置可再用", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const [running, ...queued] = gates(on, ["run", ...EIGHT]) as [string, ...string[]];
    const abort = new AbortController();
    const head = watch(cache.convert(running));
    // 被中止的是排在最前面的那个：不出队的话，放行之后下一个启动的就是它。
    const calls = queued.map((input, at) =>
      watch(cache.convert(input, at === 0 ? abort.signal : undefined)),
    );

    abort.abort();
    await microtasks();

    expect(states(calls)).toEqual(["aborted", ...new Array(7).fill("pending")]);
    const [late, over] = gates(on, ["late", "over"]) as [string, string];
    const admitted = watch(cache.convert(late));
    const refused = watch(cache.convert(over));
    await microtasks();
    // 腾出的恰是一个位置。
    expect(admitted.state).toBe("pending");
    expect(refused.state).toBe("busy");
    expect(on.launches).toHaveLength(1);
    expect(jobDirs(on)).toHaveLength(1);

    release(running, ...queued, late);
    await Promise.all([head, admitted, ...calls.slice(1)].map((call) => call.promise));
    expect(launched(on)).toEqual([running, ...queued.slice(1), late]);
    expect(calls[0]?.state).toBe("aborted");
  });
});

describe("并发上限与排队：同一输入只转一次", { timeout: 20_000 }, () => {
  it("同一输入并发三次：恰启动一次、同一路径；一个中止其余两个成功，进程没被杀", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 2 });
    const input = on.input("a@gate.docx");
    // 中止的是开出这一组的那个调用：把它的 signal 直接交给转换器的实现会在这里杀掉进程。
    const opener = new AbortController();
    const calls = [
      watch(cache.convert(input, opener.signal)),
      watch(cache.convert(input)),
      watch(cache.convert(input, new AbortController().signal)),
    ];
    expect(on.launches).toHaveLength(1);
    // 三个调用只占一个位置：并发 2 之下另一个输入不用排队。
    const other = on.input("other@gate.docx");
    const beside = watch(cache.convert(other));
    expect(launched(on)).toEqual([input, other]);

    opener.abort();
    await microtasks();
    expect(states(calls)).toEqual(["aborted", "pending", "pending"]);

    release(input, other);
    expect(await Promise.all([calls[1]?.promise, calls[2]?.promise, beside.promise])).toEqual([
      slotOf(on, input),
      slotOf(on, input),
      slotOf(on, other),
    ]);
    const child = on.launches[0]?.child;
    await vi.waitFor(() => expect(child?.exitCode).toBe(0), GONE_WITHIN);
    expect(child?.signalCode).toBe(null);
    expect(on.launches).toHaveLength(2);
    expect(readFileSync(slotOf(on, input), "utf8")).toBe(PDF);
    expect(readdirSync(on.pdf).sort()).toEqual(
      [basename(slotOf(on, input)), basename(slotOf(on, other))].sort(),
    );
  });

  it("同键三个调用全部中止：进程被 SIGKILL、pdf/ 为空，随后同一输入重新启动并成功", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 2 });
    const input = on.input("a@gate.docx");
    const aborts = [new AbortController(), new AbortController(), new AbortController()];
    const calls = aborts.map((abort) => watch(cache.convert(input, abort.signal)));
    expect(on.launches).toHaveLength(1);

    for (const abort of aborts) {
      abort.abort();
    }
    // 同一拍里再来的同键调用另开一组，不挂在将死的那一组上。
    const again = watch(cache.convert(input));
    expect(on.launches).toHaveLength(2);
    await microtasks();
    expect(states([...calls, again])).toEqual(["aborted", "aborted", "aborted", "pending"]);

    const dying = on.launches[0]?.child;
    await vi.waitFor(() => expect(dying?.signalCode).toBe("SIGKILL"), GONE_WITHIN);
    expect(readdirSync(on.pdf)).toEqual([]);

    release(input);
    expect(await again.promise).toBe(slotOf(on, input));
    expect(launched(on)).toEqual([input, input]);
    expect(readdirSync(on.pdf)).toEqual([basename(slotOf(on, input))]);
  });
});

describe("并发上限与排队：关停与参数", { timeout: 20_000 }, () => {
  it("close()：排队的全部 aborted 且零启动，运行中的被终止，其后 convert 为 aborted", async () => {
    const on = rig();
    const cache = cacheOn(on, { concurrency: 1 });
    const [running, ...queued] = gates(on, ["run", "q1", "q2", "q3"]) as [string, ...string[]];
    const head = watch(cache.convert(running));
    // 最后一组有两个调用方。
    const calls = [...queued, queued[2] as string].map((input) => watch(cache.convert(input)));
    const child = on.launches[0]?.child;

    const closing = cache.close();
    await microtasks();

    // 排队的在 close() 调用的同一拍里就落定了：运行中的那个进程此刻还没退出。
    expect(states(calls)).toEqual(["aborted", "aborted", "aborted", "aborted"]);
    expect(head.state).toBe("pending");
    expect(child?.exitCode).toBe(null);
    expect(child?.signalCode).toBe(null);

    await closing;

    // close() 返回时排队者已全部落定，运行中的进程已经退出。
    expect(states([head, ...calls])).toEqual(new Array(5).fill("aborted"));
    expect(child?.signalCode).toBe("SIGKILL");
    expect(on.launches).toHaveLength(1);
    expect(jobDirs(on)).toEqual([]);

    const after = watch(cache.convert(on.input("after.docx")));
    await microtasks();
    expect(after.state).toBe("aborted");
    expect(on.launches).toHaveLength(1);
    expect(readdirSync(on.pdf)).toEqual([]);
  });

  it("concurrency 为 0、负数、小数：构造即抛固定 message", () => {
    const on = rig();
    const converter = createOfficeConverter({ cacheDir: on.cacheDir, timeoutMs: 1_000 });

    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => createOfficeCache({ cacheDir: on.cacheDir, converter, concurrency })).toThrow(
        new Error(BAD_CONCURRENCY),
      );
    }
  });

  it("队列自身：close() 之后与 signal 已中止的 run 都是 aborted，任务一次都没被调用", async () => {
    const queue = createOfficeQueue({ concurrency: 1 });
    const task = vi.fn(async () => "/never");

    const aborted = watch(queue.run("k1", task, AbortSignal.abort()));
    queue.close();
    queue.close();
    const closed = watch(queue.run("k2", task));
    await microtasks();

    expect(states([aborted, closed])).toEqual(["aborted", "aborted"]);
    expect(task).not.toHaveBeenCalled();
  });

  it("队列自身：close() 中止运行中任务的信号；排队的组以 aborted 落定，它的任务没被调用", async () => {
    const queue = createOfficeQueue({ concurrency: 1 });
    let given: AbortSignal | undefined;
    const head = watch(
      queue.run("k1", (signal) => {
        given = signal;
        return new Promise<string>(() => undefined);
      }),
    );
    const task = vi.fn(async () => "/never");
    const queued = watch(queue.run("k2", task));
    expect(given?.aborted).toBe(false);

    queue.close();
    await microtasks();

    expect(given?.aborted).toBe(true);
    // 运行中的调用方等任务自己落定，队列不替它落定。
    expect(states([head, queued])).toEqual(["pending", "aborted"]);
    expect(task).not.toHaveBeenCalled();
  });

  it("队列自身：组已落定、结果还没送到时它的调用方中止——排在后面的组照常启动", async () => {
    const queue = createOfficeQueue({ concurrency: 1 });
    const abort = new AbortController();
    let finishFirst: (path: string) => void = () => undefined;
    const first = watch(
      queue.run("k1", () => new Promise<string>((done) => (finishFirst = done)), abort.signal),
    );
    // 第二组的任务在第一组放出名额的那一拍里被同步调用：那时第一组的结果还没有送到调用方。
    const second = watch(
      queue.run("k2", async () => {
        abort.abort();
        return "/second";
      }),
    );
    const third = watch(queue.run("k3", async () => "/third"));

    finishFirst("/first");
    await microtasks();

    expect(states([first, second, third])).toEqual(["aborted", "/second", "/third"]);
  });
});
