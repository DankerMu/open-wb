/**
 * Issue #1302（任务 14.7）：office-preview「转换器调用契约」场景「输出复制的字节上界」。
 *
 * 对着 `fixtures/fake-soffice.mjs` 真实 spawn。「取得大小之后」这个时刻由 `FileHandle.prototype.stat`
 * 上的探针给出：它先调原函数，认出这是输出文件（设备号与 inode 相同）之后、把结果交还转换器之前
 * 同步改动文件——追加与截短因此落在 `fstat` 与第一次读取之间，没有竞态，也不需要源码里的 seam。
 * 同一个句柄上的 `read` 被逐次记下，是「没有读取输出的内容」的判据。上限与 PDF 字节是照规格抄的
 * 字面量，不引用源码常量。
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficeConverter, OfficeConvertError } from "../src/preview/office.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-soffice.mjs", import.meta.url));
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
/** 200 MiB。 */
const LIMIT = 209_715_200;
/** 恰到上限的一例真的要写出 200 MiB 的零（本机实测 0.12–0.27 秒）；时限给慢盘留余量。 */
const BIG_COPY_TEST_MS = 60_000;

interface Watch {
  /** 转换器对输出文件取得的 `size`，按次序。 */
  sizes: number[];
  /** 输出文件那个句柄上 `read` 被调用的次数。 */
  reads(): number;
}

type Converter = ReturnType<typeof createOfficeConverter>;

const roots: string[] = [];
const converters: Converter[] = [];

afterEach(async () => {
  await Promise.all(converters.splice(0).map((converter) => converter.close()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 建好缓存目录、转换一个名为 `name` 的输入。`afterFstat` 在转换器取得输出的大小之后、读取之前
 * 被同步调用一次，参数是输出文件的路径。
 */
async function convertWatched(
  name: string,
  afterFstat?: (produced: string) => void,
): Promise<{ pdf: string; watch: Watch; attempt: Promise<string> }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "office-output-")));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const pdf = join(cacheDir, "pdf");
  for (const dir of [cacheDir, pdf, join(cacheDir, "work"), join(root, "ws")]) {
    mkdirSync(dir, 0o700);
  }
  const input = join(root, "ws", name);
  writeFileSync(input, "not a real office document");

  let produced: string | undefined;
  const converter = createOfficeConverter({
    officeBin: FAKE,
    cacheDir,
    timeoutMs: 20_000,
    spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
      // 作业目录就是子进程的 cwd；输出名是输入名去掉最后一个扩展名。
      produced = join(String(options.cwd), "out", `${name.slice(0, name.lastIndexOf("."))}.pdf`);
      return spawn(command, [...args], options);
    },
  });
  converters.push(converter);

  const probe = await open(FAKE);
  const proto = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const realStat = proto.stat as (this: FileHandle) => Promise<Stats>;
  const realRead = proto.read as (this: FileHandle, ...args: unknown[]) => Promise<unknown>;
  const sizes: number[] = [];
  const readOn: FileHandle[] = [];
  let outputHandle: FileHandle | undefined;
  vi.spyOn(proto, "stat").mockImplementation(async function (this: FileHandle) {
    const stats = await realStat.call(this);
    const onDisk =
      produced === undefined ? undefined : statSync(produced, { throwIfNoEntry: false });
    if (produced !== undefined && onDisk?.ino === stats.ino && onDisk.dev === stats.dev) {
      outputHandle = this;
      sizes.push(stats.size);
      if (sizes.length === 1) {
        afterFstat?.(produced);
      }
    }
    return stats;
  } as FileHandle["stat"]);
  vi.spyOn(proto, "read").mockImplementation(function (this: FileHandle, ...args: unknown[]) {
    readOn.push(this);
    return realRead.apply(this, args);
  } as FileHandle["read"]);

  const watch: Watch = {
    sizes,
    reads: () => readOn.filter((handle) => handle === outputHandle).length,
  };
  return { pdf, watch, attempt: converter.convert(input) };
}

/** 失败的种类与 message；成功落定时拿到的是路径字符串，过不了 `instanceof`。 */
async function failureOf(attempt: Promise<string>): Promise<{ kind: string; message: string }> {
  const error: unknown = await attempt.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(OfficeConvertError);
  const { kind, message } = error as OfficeConvertError;
  return { kind, message };
}

describe("转换器调用契约：输出复制的字节上界", () => {
  it("取得大小之后又被追加的字节不进结果：结果恰是那一刻的前缀", async () => {
    const { pdf, watch, attempt } = await convertWatched("a.docx", (produced) => {
      appendFileSync(produced, "appended after fstat\n".repeat(4096));
    });

    const result = await attempt;

    expect(watch.sizes).toEqual([PDF.length]);
    // 探针看得见这个句柄上的读取：超限一例的「0 次」不是因为探针是瞎的。
    expect(watch.reads()).toBeGreaterThan(0);
    expect(lstatSync(result).size).toBe(PDF.length);
    expect(readFileSync(result, "utf8")).toBe(PDF);
    expect(readdirSync(pdf)).toEqual([basename(result)]);
  });

  it("输出是 200 MiB + 1 字节的稀疏文件：failed，一个字节都不读，pdf/ 没有新增文件", async () => {
    const { pdf, watch, attempt } = await convertWatched("a@sparse-over.docx");

    expect(await failureOf(attempt)).toEqual({ kind: "failed", message: "failed" });
    expect(watch.sizes).toEqual([LIMIT + 1]);
    expect(watch.reads()).toBe(0);
    expect(readdirSync(pdf)).toEqual([]);
  });

  it.each([
    ["少 1 字节", PDF.length - 1],
    ["一半", Math.floor(PDF.length / 2)],
    ["0 字节", 0],
  ])(
    "取得大小之后、读取之前输出被截短到%s：failed，pdf/ 不留下这次复制的文件",
    async (_case, keep) => {
      const { pdf, watch, attempt } = await convertWatched("a.docx", (produced) => {
        truncateSync(produced, keep);
      });

      expect(await failureOf(attempt)).toEqual({ kind: "failed", message: "failed" });
      expect(watch.sizes).toEqual([PDF.length]);
      expect(readdirSync(pdf)).toEqual([]);
    },
  );

  it(
    "输出是恰 200 MiB 的稀疏文件：成功，结果文件恰 200 MiB",
    async () => {
      const { pdf, watch, attempt } = await convertWatched("a@sparse-limit.docx");

      const result = await attempt;

      expect(watch.sizes).toEqual([LIMIT]);
      const stats = lstatSync(result);
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBe(LIMIT);
      expect(stats.mode & 0o7777).toBe(0o600);
      expect(readdirSync(pdf)).toEqual([basename(result)]);
    },
    BIG_COPY_TEST_MS,
  );
});
