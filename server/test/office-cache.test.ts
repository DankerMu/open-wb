/**
 * Issue #1072（任务 14.3，含分摊的 14.5 / 14.6 条款）：office-preview「转换缓存」——键、命中、
 * 复制、失败不入缓存与 `pdf` 的周期清理。启动时对 `work` 的清空在 `office-work-clear.test.ts`。
 *
 * 转换对着 `fixtures/fake-soffice.mjs` 真实 spawn；注入的 spawn 包装器（`office-cache-helpers.ts`）
 * 记录每次启动，是「零启动」「重新启动」的判据。期望的键与 PDF 字节是照规格抄的字面量，不引用
 * 源码常量，也不拿 `officeCacheKey` 的返回值当期望。
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOfficeConverter, OfficeConvertError } from "../src/preview/office.js";
import {
  createOfficeCache,
  createOfficeCleanup,
  officeCacheKey,
} from "../src/preview/office-cache.js";
import {
  type Bench,
  BODY,
  bench,
  closers,
  FAKE_SOFFICE,
  INPUT_MTIME_S,
  PDF,
  useOfficeBenches,
} from "./office-cache-helpers.js";

const DAY_MS = 86_400_000;
const BAD_PATHS = "cacheDir and officeBin must be absolute paths";
const isRoot = process.geteuid?.() === 0;

useOfficeBenches();

/** 规格的键，照字面拼：`<路径的 UTF-8> 0x00 <mtimeMs 十进制> 0x00 <size 十进制>` 的 sha256。 */
function literalKey(path: string, mtimeMs: string, size: string): string {
  const preimage = Buffer.concat([
    Buffer.from(path, "utf8"),
    Buffer.from([0]),
    Buffer.from(mtimeMs, "ascii"),
    Buffer.from([0]),
    Buffer.from(size, "ascii"),
  ]);
  return createHash("sha256").update(preimage).digest("hex");
}

function cacheOn(on: Bench, overrides: { officeBin?: string | null; timeoutMs?: number } = {}) {
  const { officeBin = FAKE_SOFFICE, timeoutMs = 20_000 } = overrides;
  const converter = createOfficeConverter({
    ...(officeBin === null ? {} : { officeBin }),
    cacheDir: on.cacheDir,
    timeoutMs,
    spawn: on.spawn,
  });
  const cache = createOfficeCache({ cacheDir: on.cacheDir, converter });
  closers.push(cache);
  return cache;
}

/** 失败的种类；成功落定时拿到的是路径字符串，过不了 `instanceof`。 */
async function kindOf(attempt: Promise<string>): Promise<string> {
  const outcome: unknown = await attempt.catch((reason: unknown) => reason);
  expect(outcome).toBeInstanceOf(OfficeConvertError);
  return (outcome as OfficeConvertError).kind;
}

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("转换缓存：命中、失效与复制", () => {
  it("结果在 pdf/<键>.pdf，键等于照规格字面算出的值；第二次调用零启动、同路径、修改时间被更新", async () => {
    const on = bench();
    const input = on.input("报告 v2.docx");
    const key = literalKey(input, "1700000000000", "26");
    const cache = cacheOn(on);

    const first = await cache.convert(input);

    expect(cache.available).toBe(true);
    expect(first).toBe(join(on.pdf, `${key}.pdf`));
    expect(await officeCacheKey(input)).toBe(key);
    expect(readdirSync(on.pdf)).toEqual([`${key}.pdf`]);
    expect(readFileSync(first, "utf8")).toBe(PDF);
    expect(on.launches).toHaveLength(1);

    const dayAgo = (Date.now() - DAY_MS) / 1000;
    utimesSync(first, dayAgo, dayAgo);
    const before = Date.now();
    const second = await cache.convert(input);

    expect(second).toBe(first);
    expect(on.launches).toHaveLength(1);
    // 一天前与「刚才」之间差着 86400 秒；2 秒的余量只是给文件系统的时间粒度。
    expect(lstatSync(first).mtimeMs).toBeGreaterThan(before - 2_000);
  });

  it("缓存文件是本进程新建的副本：0600、属本进程，inode 不是作业目录里的那个输出", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const probe = await open(FAKE_SOFFICE);
    const proto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const fstat = proto.stat as (this: FileHandle) => Promise<Stats>;
    /** 转换器对作业输出 `fstat` 的那一刻它的 inode：此时作业目录还在，副本随后才建。 */
    const jobOutputInodes: number[] = [];
    vi.spyOn(proto, "stat").mockImplementation(async function (this: FileHandle) {
      const seen = await fstat.call(this);
      const job = String(on.launches.at(-1)?.options.cwd);
      const output = lstatSync(join(job, "out", "a.pdf"), { throwIfNoEntry: false });
      if (output?.ino === seen.ino && output.dev === seen.dev) {
        jobOutputInodes.push(seen.ino);
      }
      return seen;
    } as FileHandle["stat"]);

    const result = await cacheOn(on).convert(input);

    expect(jobOutputInodes).toHaveLength(1);
    const cached = lstatSync(result);
    expect(cached.isFile()).toBe(true);
    expect(cached.ino).not.toBe(jobOutputInodes[0]);
    expect(cached.mode & 0o7777).toBe(0o600);
    expect(cached.uid).toBe(process.geteuid?.());
    expect(readFileSync(result, "utf8")).toBe(PDF);
  });

  it.each<[string, (on: Bench, first: string) => [path: string, mtimeMs: string, size: string]]>([
    [
      "只改大小（改写后把修改时间设回原值）",
      (_on, first) => {
        writeFileSync(first, `${BODY}!`);
        utimesSync(first, INPUT_MTIME_S, INPUT_MTIME_S);
        return [first, "1700000000000", "27"];
      },
    ],
    [
      "只改修改时间",
      (_on, first) => {
        utimesSync(first, INPUT_MTIME_S + 1, INPUT_MTIME_S + 1);
        return [first, "1700000001000", "26"];
      },
    ],
    [
      // 1/64 秒 = 15.625 毫秒：微秒与纳秒粒度的文件系统上都精确，键里的小数原样写入、不取整。
      "把修改时间改成带小数毫秒的值",
      (_on, first) => {
        utimesSync(first, INPUT_MTIME_S + 0.015625, INPUT_MTIME_S + 0.015625);
        expect(lstatSync(first).mtimeMs).toBe(1_700_000_000_015.625);
        return [first, "1700000000015.625", "26"];
      },
    ],
    ["同大小同修改时间的另一路径", (on) => [on.input("b.docx"), "1700000000000", "26"]],
  ])("%s：重新启动进程，结果是另一个键的文件", async (_case, change) => {
    const on = bench();
    const input = on.input("a.docx");
    const cache = cacheOn(on);
    const first = await cache.convert(input);
    expect(first).toBe(join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`));

    const [path, mtimeMs, size] = change(on, input);
    const second = await cache.convert(path);

    expect(on.launches).toHaveLength(2);
    expect(second).toBe(join(on.pdf, `${literalKey(path, mtimeMs, size)}.pdf`));
    expect(second).not.toBe(first);
    expect(readdirSync(on.pdf).sort()).toEqual([basename(first), basename(second)].sort());
  });

  it("输入是指向另一个文件的符号链接：键取自链接自己的 lstat，不是目标的大小与修改时间", async () => {
    const on = bench();
    const target = on.input("a.docx");
    const link = join(on.root, "ws", "link.docx");
    // 相对目标 `a.docx`：链接自己的 size 是 6；修改时间用不跟随链接的 lutimes 钉住。
    symlinkSync("a.docx", link);
    lutimesSync(link, INPUT_MTIME_S + 1, INPUT_MTIME_S + 1);
    expect(lstatSync(target).mtimeMs).toBe(1_700_000_000_000);
    expect(lstatSync(target).size).toBe(26);
    const key = literalKey(link, "1700000001000", "6");

    expect(await officeCacheKey(link)).toBe(key);
    expect(await cacheOn(on).convert(link)).toBe(join(on.pdf, `${key}.pdf`));

    expect(on.launches).toHaveLength(1);
    expect(readdirSync(on.pdf)).toEqual([`${key}.pdf`]);
  });

  it("键的位置上是 0 字节文件：不算命中，重新转换", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const slot = join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`);
    writeFileSync(slot, "");

    expect(await cacheOn(on).convert(input)).toBe(slot);

    expect(on.launches).toHaveLength(1);
    expect(readFileSync(slot, "utf8")).toBe(PDF);
  });

  it("键的位置上是指向非空文件的符号链接：不算命中，重新转换；链接被换掉，目标原样", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const slot = join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`);
    const elsewhere = join(on.root, "elsewhere.pdf");
    writeFileSync(elsewhere, "not ours");
    utimesSync(elsewhere, INPUT_MTIME_S, INPUT_MTIME_S);
    symlinkSync(elsewhere, slot);

    expect(await cacheOn(on).convert(input)).toBe(slot);

    expect(on.launches).toHaveLength(1);
    expect(lstatSync(slot).isFile()).toBe(true);
    expect(readFileSync(slot, "utf8")).toBe(PDF);
    expect(readFileSync(elsewhere, "utf8")).toBe("not ours");
    expect(lstatSync(elsewhere).mtimeMs).toBe(INPUT_MTIME_S * 1000);
  });

  it("同一个键的两次并发未命中各转一次，落定为同一路径，pdf/ 里只有这一个文件", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const cache = cacheOn(on);

    const [one, two] = await Promise.all([cache.convert(input), cache.convert(input)]);

    expect(one).toBe(join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`));
    expect(two).toBe(one);
    expect(on.launches).toHaveLength(2);
    expect(readdirSync(on.pdf)).toEqual([basename(one)]);
    expect(readFileSync(one, "utf8")).toBe(PDF);
  });

  it("已缓存的输入：close() 之后与 signal 已中止时都是 aborted，不返回命中、零启动", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const cache = cacheOn(on);
    await cache.convert(input);
    const aborted = new AbortController();
    aborted.abort();

    expect(await kindOf(cache.convert(input, aborted.signal))).toBe("aborted");
    // 没中止的 signal 不挡命中：上一行的 aborted 不是「带了 signal 就失败」。
    expect(await cache.convert(input, new AbortController().signal)).toBe(
      join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`),
    );
    await cache.close();
    expect(await kindOf(cache.convert(input))).toBe("aborted");
    expect(on.launches).toHaveLength(1);
  });

  it("未配置 officeBin：available 为 false，对不存在的输入也是 unavailable，零启动", async () => {
    const on = bench();
    const cache = cacheOn(on, { officeBin: null });

    expect(cache.available).toBe(false);
    expect(await kindOf(cache.convert(join(on.root, "ws", "missing.docx")))).toBe("unavailable");
    expect(on.launches).toEqual([]);
    expect(readdirSync(on.pdf)).toEqual([]);
  });

  it("相对路径的输入：failed，不按 cwd 解析——cwd 下真有这个文件、它的键上还放着缓存文件", async () => {
    const on = bench();
    const trap = relative(process.cwd(), on.input("a.docx"));
    expect(trap.startsWith("/")).toBe(false);
    expect(lstatSync(trap).size).toBe(26);
    const planted = join(on.pdf, `${literalKey(trap, "1700000000000", "26")}.pdf`);
    writeFileSync(planted, PDF);

    expect(await kindOf(cacheOn(on).convert(trap))).toBe("failed");

    expect(on.launches).toEqual([]);
    expect(readdirSync(on.pdf)).toEqual([basename(planted)]);
  });

  it("输入不存在：failed，零启动，work 与 pdf 下都没有新增", async () => {
    const on = bench();

    expect(await kindOf(cacheOn(on).convert(join(on.root, "ws", "missing.docx")))).toBe("failed");

    expect(on.launches).toEqual([]);
    expect(readdirSync(on.work)).toEqual([]);
    expect(readdirSync(on.pdf)).toEqual([]);
  });

  it("改名进键的位置失败（那里是非空目录）：failed，随机名的副本不留在 pdf/", async () => {
    const on = bench();
    const input = on.input("a.docx");
    const slot = join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`);
    mkdirSync(slot);
    writeFileSync(join(slot, "keep"), "x");

    expect(await kindOf(cacheOn(on).convert(input))).toBe("failed");

    expect(on.launches).toHaveLength(1);
    expect(readdirSync(on.pdf)).toEqual([basename(slot)]);
    expect(readdirSync(slot)).toEqual(["keep"]);
  });

  it("cacheDir 不是绝对路径：两个工厂都同步抛固定 message；清理工厂对相对的 officeBin 同样", () => {
    const on = bench();
    const converter = createOfficeConverter({ cacheDir: on.cacheDir, timeoutMs: 1_000 });

    expect(() => createOfficeCache({ cacheDir: "var/preview-cache", converter })).toThrow(
      new Error(BAD_PATHS),
    );
    expect(() => createOfficeCleanup({ cacheDir: "var/preview-cache" })).toThrow(
      new Error(BAD_PATHS),
    );
    expect(() => createOfficeCleanup({ cacheDir: on.cacheDir, officeBin: "./soffice" })).toThrow(
      new Error(BAD_PATHS),
    );
  });
});

describe("转换缓存：失败不入缓存", () => {
  /**
   * 第一次启动的替身：先在作业目录里写出完好的 PDF（D-25 的真实形状——被终止的作业留下完整的
   * 输出），写一个「已写完」的标记，再按模式退出 1 或一直睡。
   */
  const WRITE_THEN_FAIL = [
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'mkdirSync("out");',
    `writeFileSync("out/a.pdf", ${JSON.stringify(PDF)});`,
    'writeFileSync(process.argv[2], "written");',
    'if (process.argv[1] === "exit1") { process.exit(1); }',
    "setTimeout(() => {}, 30000);",
  ].join("\n");

  it.each<[kind: string, mode: string, timeoutMs: number]>([
    ["failed", "exit1", 20_000],
    ["timeout", "sleep", 1_000],
    ["aborted", "sleep", 20_000],
  ])(
    "写出完好 PDF 之后以 %s 结束：pdf/ 为空；同一输入再转换启动了进程并成功",
    async (kind, mode, timeoutMs) => {
      const on = bench();
      const input = on.input("a.docx");
      const written = join(on.root, "written");
      const cache = cacheOn(on, { timeoutMs });
      const controller = new AbortController();
      on.standIn = [WRITE_THEN_FAIL, mode, written];

      const attempt = kindOf(cache.convert(input, controller.signal));
      if (kind === "aborted") {
        await until("the stand-in to write its PDF", () => existsSync(written));
        controller.abort();
      }

      expect(await attempt).toBe(kind);
      // 替身确实把 PDF 写出来了：下面的「为空」不是因为根本没有输出可收。
      expect(existsSync(written)).toBe(true);
      expect(on.launches).toHaveLength(1);
      expect(readdirSync(on.pdf)).toEqual([]);

      const result = await cache.convert(input);

      expect(on.launches).toHaveLength(2);
      expect(on.launches[1]?.command).toBe(FAKE_SOFFICE);
      expect(result).toBe(join(on.pdf, `${literalKey(input, "1700000000000", "26")}.pdf`));
      expect(readFileSync(result, "utf8")).toBe(PDF);
      expect(readdirSync(on.pdf)).toEqual([basename(result)]);
    },
  );
});

describe("转换缓存：周期清理", () => {
  /** 整秒，`utimes` 设得准；界上的那个文件的修改时间恰等于 `NOW − 7 天`。 */
  const NOW = 1_800_000_000_000;

  /** 访问时间缺省与修改时间相同；另给时是为了让「按访问时间判」的实现判反。 */
  function aged(path: string, ageMs: number, atimeAgeMs = ageMs): void {
    utimesSync(path, (NOW - atimeAgeMs) / 1000, (NOW - ageMs) / 1000);
  }

  it("删掉修改时间早于 7 天的普通文件：8 天前与 7 天又 1 秒前的删，恰 7 天与 6 天又 1 秒前的留", async () => {
    const on = bench();
    // 第三列是访问时间：界两侧的两个文件各放在界的另一侧。没有后缀的旧文件同样是普通文件。
    const ages: Array<[string, number, number?]> = [
      ["eight-days.pdf", 8 * DAY_MS],
      ["eight-days-no-suffix", 8 * DAY_MS],
      ["just-over.pdf", 7 * DAY_MS + 1_000, DAY_MS],
      ["on-the-limit.pdf", 7 * DAY_MS, 8 * DAY_MS],
      ["six-days.pdf", 6 * DAY_MS + 1_000],
    ];
    for (const [name, age, atimeAge] of ages) {
      writeFileSync(join(on.pdf, name), PDF);
      aged(join(on.pdf, name), age, atimeAge);
    }
    expect(lstatSync(join(on.pdf, "just-over.pdf")).atimeMs).toBe(NOW - DAY_MS);
    expect(lstatSync(join(on.pdf, "on-the-limit.pdf")).atimeMs).toBe(NOW - 8 * DAY_MS);

    await expect(createOfficeCleanup({ cacheDir: on.cacheDir }).sweepPdf(NOW)).resolves.toBe(
      undefined,
    );

    expect(readdirSync(on.pdf).sort()).toEqual(["on-the-limit.pdf", "six-days.pdf"]);
  });

  it("修改时间很旧的子目录与指向外部旧文件的符号链接都留着，外部文件原样", async () => {
    const on = bench();
    const outside = join(on.root, "outside.pdf");
    writeFileSync(outside, "not ours");
    aged(outside, 30 * DAY_MS);
    symlinkSync(outside, join(on.pdf, "link.pdf"));
    mkdirSync(join(on.pdf, "dir.pdf"));
    writeFileSync(join(on.pdf, "dir.pdf", "inner.pdf"), PDF);
    aged(join(on.pdf, "dir.pdf", "inner.pdf"), 30 * DAY_MS);
    aged(join(on.pdf, "dir.pdf"), 30 * DAY_MS);

    await createOfficeCleanup({ cacheDir: on.cacheDir }).sweepPdf(NOW);

    expect(readdirSync(on.pdf).sort()).toEqual(["dir.pdf", "link.pdf"]);
    expect(lstatSync(join(on.pdf, "link.pdf")).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(on.pdf, "dir.pdf"))).toEqual(["inner.pdf"]);
    expect(readFileSync(outside, "utf8")).toBe("not ours");
  });

  it.skipIf(isRoot)("pdf 目录不可读：不抛，里面的旧文件原样留着", async () => {
    const on = bench();
    writeFileSync(join(on.pdf, "old.pdf"), PDF);
    aged(join(on.pdf, "old.pdf"), 8 * DAY_MS);
    chmodSync(on.pdf, 0o000);

    await expect(createOfficeCleanup({ cacheDir: on.cacheDir }).sweepPdf(NOW)).resolves.toBe(
      undefined,
    );

    chmodSync(on.pdf, 0o700);
    expect(readdirSync(on.pdf)).toEqual(["old.pdf"]);
  });

  it("pdf 与 work 都不存在：两个清理函数都不抛", async () => {
    const on = bench();
    rmSync(on.pdf, { recursive: true });
    rmSync(on.work, { recursive: true });
    const cleanup = createOfficeCleanup({ cacheDir: on.cacheDir });

    await expect(cleanup.sweepPdf(NOW)).resolves.toBe(undefined);
    await expect(cleanup.clearWork()).resolves.toBe(undefined);
    expect(readdirSync(on.cacheDir)).toEqual([]);
  });
});
