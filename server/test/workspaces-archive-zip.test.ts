import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { listArchive } from "../src/workspaces/archive.js";
import {
  archiveOnDisk,
  DEFAULTS,
  list,
  UNSUPPORTED,
  ZIP_THREE_RECORDS,
  zipArchive,
  zipCentral,
} from "./workspaces-archive-helpers.js";

// The edges of the zip listing: what is taken from a central directory record, the limits, and
// every way a directory can lie or break off. The spec's own scenarios (x.zip, big.zip, long.zip,
// fake.zip, hostile names) are in `workspaces-archive.test.ts`. Literals on purpose.
const READ_LIMIT = 65_536;
const NAME_LIMIT = 4096;
const THREE_ENTRIES = [
  { path: "a.txt", type: "file", size: 5 },
  { path: "dir/", type: "dir", size: 0 },
  { path: "dir/b.md", type: "file", size: 7 },
];
const plain = (name: string, size = 0) => zipCentral({ name, size });
/** One extra field: a 2-byte id, a 2-byte data length, the data. */
function extraField(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}
function uint64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

describe("zip 列表：从中央目录项里取什么", () => {
  it("stored 成员的 compressedSize 与 uncompressedSize 不等仍被列出", async () => {
    const { listing } = await list(
      "sizes.zip",
      zipArchive([
        zipCentral({ name: "stored.bin", size: 100, compressedSize: 3, method: 0 }),
        plain("next.txt", 1),
      ]),
    );
    expect(listing).toEqual({
      format: "zip",
      entries: [
        { path: "stored.bin", type: "file", size: 100 },
        { path: "next.txt", type: "file", size: 1 },
      ],
      truncated: false,
    });
  });

  it("size 是未压缩大小：deflate 成员压缩后 12 字节、原文 4000 字节 → 4000", async () => {
    const { listing } = await list(
      "deflated.zip",
      zipArchive([zipCentral({ name: "text.txt", size: 4000, compressedSize: 12, method: 8 })]),
    );
    expect(listing.entries).toEqual([{ path: "text.txt", type: "file", size: 4000 }]);
  });

  it("只有以 / 结尾的名字是 dir：零字节文件、带目录属性位而名字不以 / 结尾的都是 file，有大小的 sub/ 是 dir", async () => {
    const { listing } = await list(
      "kinds.zip",
      zipArchive([
        plain("empty.txt"),
        zipCentral({ name: "marked-dir", attributes: 0x10 }),
        zipCentral({ name: "sub/", size: 9 }),
        zipCentral({ name: "unix-dir", attributes: 0o040755 * 65_536 }),
      ]),
    );
    expect(listing.entries).toEqual([
      { path: "empty.txt", type: "file", size: 0 },
      { path: "marked-dir", type: "file", size: 0 },
      { path: "sub/", type: "dir", size: 9 },
      { path: "unix-dir", type: "file", size: 0 },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("名字按 UTF-8 解码，不看位 11：未置位的中文名原样，置位的同样", async () => {
    const chinese = "资料/会议纪要（终稿）.md";
    const { listing } = await list(
      "utf8.zip",
      zipArchive([
        zipCentral({ name: chinese, size: 8 }),
        zipCentral({ name: chinese, size: 9, flags: 0x800 }),
      ]),
    );
    expect(listing.entries).toEqual([
      { path: chinese, type: "file", size: 8 },
      { path: chinese, type: "file", size: 9 },
    ]);
  });

  it("不合法的 UTF-8 字节各成为 U+FFFD：ff fe 41 → \\ufffd\\ufffdA", async () => {
    const { listing } = await list(
      "bad-utf8.zip",
      zipArchive([zipCentral({ name: Buffer.from([0xff, 0xfe, 0x41]) })]),
    );
    expect(listing.entries).toEqual([{ path: "��A", type: "file", size: 0 }]);
  });

  it("Info-ZIP Unicode Path 扩展字段（0x7075）不替换名字", async () => {
    const name = Buffer.from("a.txt");
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(name));
    const unicodePath = extraField(
      0x7075,
      Buffer.concat([Buffer.from([1]), crc, Buffer.from("other/名字.txt")]),
    );
    const { listing } = await list(
      "unicode-path.zip",
      zipArchive([zipCentral({ name, size: 5, extra: unicodePath })]),
    );
    expect(listing.entries).toEqual([{ path: "a.txt", type: "file", size: 5 }]);
  });

  it("zip64 扩展字段给出的大小超过 2^53 时是失精度的 number", async () => {
    const { listing } = await list(
      "zip64.zip",
      zipArchive([
        zipCentral({
          name: "huge.bin",
          size: 0xffffffff,
          compressedSize: 1,
          extra: extraField(0x0001, uint64(0xffffffffffffffffn)),
        }),
        zipCentral({
          name: "five-gib.bin",
          size: 0xffffffff,
          compressedSize: 1,
          extra: extraField(0x0001, uint64(5n * 1024n ** 3n)),
        }),
      ]),
    );
    expect(listing.entries).toEqual([
      { path: "huge.bin", type: "file", size: 18_446_744_073_709_552_000 },
      { path: "five-gib.bin", type: "file", size: 5_368_709_120 },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("zip 不读时钟：读时钟即抛错的 now 之下照常列出", async () => {
    const { listing } = await list("clock.zip", zipArchive(ZIP_THREE_RECORDS), {
      maxEntries: 1000,
      now: () => {
        throw new Error("the zip listing read the clock");
      },
    });
    expect(listing).toEqual({ format: "zip", entries: THREE_ENTRIES, truncated: false });
  });
});

describe("zip 列表：上限", () => {
  it("上限 3 时 5 个成员恰 3 项并置 truncated，第 4 个目录项不读；恰 3 个成员的包同样置 truncated", async () => {
    // Records of 46 + 2 bytes at 0, 48, 96, 144, 192. The first read is the search for the end
    // record: the whole 262-byte file, from 0.
    const names = ["m0", "m1", "m2", "m3", "m4"];
    const options = { maxEntries: 3, now: () => 0 };
    const five = await list("five.zip", zipArchive(names.map((name) => plain(name))), options);
    expect(five.listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1", "m2"]);
    expect(five.listing.truncated).toBe(true);
    expect(five.file.positions).toEqual([0, 0, 46, 48, 94, 96, 142]);

    const three = await list(
      "three.zip",
      zipArchive(names.slice(0, 3).map((name) => plain(name))),
      options,
    );
    expect(three.listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1", "m2"]);
    expect(three.listing.truncated).toBe(true);
  });

  it("成员名恰 4096 字节的计入，4097 字节的不计入并停读；按字节计而不是按字符", async () => {
    const fits = "n".repeat(NAME_LIMIT);
    const { listing } = await list(
      "edge.zip",
      zipArchive([plain(fits), plain("n".repeat(NAME_LIMIT + 1)), plain("after.txt")]),
    );
    expect(listing.entries).toEqual([{ path: fits, type: "file", size: 0 }]);
    expect(listing.truncated).toBe(true);

    const chinese = "字".repeat(1365);
    const over = "字".repeat(1366);
    expect(Buffer.byteLength(chinese)).toBe(4095);
    expect(Buffer.byteLength(over)).toBe(4098);
    const bytes = await list("bytes.zip", zipArchive([plain(chinese), plain(over), plain("z")]));
    expect(bytes.listing.entries).toEqual([{ path: chinese, type: "file", size: 0 }]);
    expect(bytes.listing.truncated).toBe(true);
  });

  it("第一个成员的名字就超过 4096 字节 → 不支持", async () => {
    await expect(
      list("long-first.zip", zipArchive([plain("n".repeat(5000)), plain("after.txt")])),
    ).rejects.toMatchObject(UNSUPPORTED);
  });

  it("扩展字段 65532 字节、注释 65535 字节的胖目录项照常列出，单次读取不超过 65536 字节", async () => {
    const fat = zipCentral({
      name: "fat.txt",
      size: 6,
      extra: extraField(0x7777, Buffer.alloc(65_528, "e")),
      comment: Buffer.alloc(65_535, "c"),
    });
    expect(fat).toHaveLength(46 + 7 + 65_532 + 65_535);
    const { file, listing } = await list("fat.zip", zipArchive([fat, plain("after.txt", 1)]));
    expect(listing).toEqual({
      format: "zip",
      entries: [
        { path: "fat.txt", type: "file", size: 6 },
        { path: "after.txt", type: "file", size: 1 },
      ],
      truncated: false,
    });
    expect(file.maxLength()).toBeLessThanOrEqual(READ_LIMIT);
  });

  it("成员前有 100000 字节前缀、目录偏移已修正 → 恰三项，前缀一个字节都不读", async () => {
    const bytes = zipArchive(ZIP_THREE_RECORDS, { prefix: Buffer.alloc(100_000, "p") });
    const { file, listing } = await list("prefixed.zip", bytes);
    expect(listing).toEqual({ format: "zip", entries: THREE_ENTRIES, truncated: false });
    expect(file.positions).not.toContain(0);
    // The search for the end record covers the last 65577 bytes and nothing before them.
    expect(Math.min(...file.positions)).toBe(bytes.length - 65_577);
    expect(file.maxLength()).toBeLessThanOrEqual(READ_LIMIT);
  });
});

describe("zip 列表：按声明如实返回", () => {
  it("22 字节的空 zip → 没有成员，truncated:false", async () => {
    const bytes = zipArchive([]);
    expect(bytes).toHaveLength(22);
    const { listing } = await list("empty.zip", bytes);
    expect(listing).toEqual({ format: "zip", entries: [], truncated: false });
  });

  it("条目数虚低 → 只列声明的那么多，truncated:false；声明 0 → 没有成员", async () => {
    const low = await list("low.zip", zipArchive(ZIP_THREE_RECORDS, { count: 1 }));
    expect(low.listing).toEqual({
      format: "zip",
      entries: [{ path: "a.txt", type: "file", size: 5 }],
      truncated: false,
    });
    const zero = await list("zero.zip", zipArchive(ZIP_THREE_RECORDS, { count: 0 }));
    expect(zero.listing).toEqual({ format: "zip", entries: [], truncated: false });
  });

  it("条目数虚高 → 目录里实有的三项并置 truncated；目录是空的 → 不支持", async () => {
    const high = await list("high.zip", zipArchive(ZIP_THREE_RECORDS, { count: 7 }));
    expect(high.listing).toEqual({ format: "zip", entries: THREE_ENTRIES, truncated: true });
    await expect(list("high-empty.zip", zipArchive([], { count: 2 }))).rejects.toMatchObject(
      UNSUPPORTED,
    );
  });
});

describe("zip 列表：损坏", () => {
  it.each([
    ["0 字节的文件", Buffer.alloc(0)],
    ["21 字节、不够一个结束记录", zipArchive([]).subarray(0, 21)],
    ["结束记录之后多出 4 个字节", zipArchive(ZIP_THREE_RECORDS, { tail: Buffer.alloc(4, "t") })],
    [
      "自解压包：前缀 1000 字节而目录偏移没有算上它",
      zipArchive(ZIP_THREE_RECORDS, { prefix: Buffer.alloc(1000, "p"), offset: 0 }),
    ],
    ["目录偏移越过文件末尾", zipArchive(ZIP_THREE_RECORDS, { offset: 5000 })],
    ["目录被截掉、结束记录也不在了", zipArchive(ZIP_THREE_RECORDS).subarray(0, 60)],
    ["第一个成员带强加密位", zipArchive([zipCentral({ name: "a.txt", flags: 0x40 })])],
    [
      "第一个成员的扩展字段声明的长度越过扩展区",
      zipArchive([zipCentral({ name: "a.txt", extra: Buffer.from([1, 0, 0xff, 0xff, 0, 0]) })]),
    ],
    ["分卷包（盘号 1）", diskOne(zipArchive(ZIP_THREE_RECORDS))],
  ])("%s → 不支持", async (_label, bytes) => {
    await expect(list("broken.zip", bytes)).rejects.toMatchObject(UNSUPPORTED);
  });

  it("zip64 结束记录把目录偏移指到 2^60 → 不支持，不向文件之外发起读取", async () => {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeBigUInt64LE(3n, 24);
    end64.writeBigUInt64LE(3n, 32);
    end64.writeBigUInt64LE(2n ** 60n, 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(1, 16);
    const directory = Buffer.concat(ZIP_THREE_RECORDS);
    locator.writeBigUInt64LE(BigInt(directory.length), 8);
    const bytes = Buffer.concat([directory, end64, locator, zipArchive([])]);
    const { size, readAt, positions } = await archiveOnDisk("far.zip", bytes);
    await expect(
      listArchive("zip", "far.zip", readAt, { ...DEFAULTS, size }),
    ).rejects.toMatchObject(UNSUPPORTED);
    // The end record, then the zip64 end record; the directory "at 2^60" is never asked for.
    expect(positions).toEqual([0, directory.length]);

    // The same archive with the offset where the directory is lists it: the zip64 path is read.
    end64.writeBigUInt64LE(0n, 48);
    const near = await list("near.zip", Buffer.concat([directory, end64, locator, zipArchive([])]));
    expect(near.listing).toEqual({ format: "zip", entries: THREE_ENTRIES, truncated: false });
  });

  it("中央目录在第二项中间被截断、结束记录仍声明三项 → 恰一项并置 truncated", async () => {
    // Cut inside the 46 fixed bytes, and after two of the hundred bytes of the name.
    const second = plain("d".repeat(100), 3);
    for (const kept of [20, 46 + 2]) {
      const bytes = zipArchive([plain("a.txt", 5), second.subarray(0, kept)], { count: 3 });
      const { listing } = await list("cut.zip", bytes);
      expect(listing, String(kept)).toEqual({
        format: "zip",
        entries: [{ path: "a.txt", type: "file", size: 5 }],
        truncated: true,
      });
    }
  });

  it("第三个成员带强加密位 → 前两项并置 truncated", async () => {
    const { listing } = await list(
      "encrypted.zip",
      zipArchive([
        plain("one.txt", 1),
        plain("two.txt", 2),
        zipCentral({ name: "x", flags: 0x40 }),
      ]),
    );
    expect(listing.entries.map((entry) => entry.path)).toEqual(["one.txt", "two.txt"]);
    expect(listing.truncated).toBe(true);
  });
});

describe("zip 列表：读函数", () => {
  // Records of 46 + 7 bytes: `one.txt` at 0, `two.txt` at 53 (its name at 99), `six.txt` at 106.
  const bytes = zipArchive([plain("one.txt", 1), plain("two.txt", 2), plain("six.txt", 6)]);

  it("读到的字节比要的少（文件在列出途中变短）→ 按损坏处理，不把没读到的部分当成名字", async () => {
    const file = await archiveOnDisk("shrunk.zip", bytes);
    const options = { ...DEFAULTS, size: file.size };
    const shortAt = (position: number, kept: number) => async (at: number, length: number) => {
      const data = await file.readAt(at, length);
      return at === position ? data.subarray(0, kept) : data;
    };

    // The name of the second member comes back three bytes long instead of seven.
    expect(await listArchive("zip", "shrunk.zip", shortAt(99, 3), options)).toEqual({
      format: "zip",
      entries: [{ path: "one.txt", type: "file", size: 1 }],
      truncated: true,
    });
    // Its 46-byte record comes back empty.
    expect(await listArchive("zip", "shrunk.zip", shortAt(53, 0), options)).toEqual({
      format: "zip",
      entries: [{ path: "one.txt", type: "file", size: 1 }],
      truncated: true,
    });
    // The very first read, the search for the end record from 0, is short: nothing was listed.
    await expect(listArchive("zip", "shrunk.zip", shortAt(0, 10), options)).rejects.toMatchObject(
      UNSUPPORTED,
    );
  });

  it("读函数失败原样抛出：第一次读就失败，与读出两项之后失败", async () => {
    const file = await archiveOnDisk("io.zip", bytes);
    const options = { ...DEFAULTS, size: file.size };
    const boom = new Error("EIO: i/o error, read");

    await expect(listArchive("zip", "io.zip", () => Promise.reject(boom), options)).rejects.toBe(
      boom,
    );

    const failAtThird = (position: number, length: number) =>
      position === 106 ? Promise.reject(boom) : file.readAt(position, length);
    await expect(listArchive("zip", "io.zip", failAtThird, options)).rejects.toBe(boom);
    expect(file.positions).toEqual([0, 0, 46, 53, 99]);

    const throwsSync = (position: number, length: number) => {
      if (position === 53) {
        throw boom;
      }
      return file.readAt(position, length);
    };
    await expect(listArchive("zip", "io.zip", throwsSync, options)).rejects.toBe(boom);
  });

  it("读函数给得比要的多 → 只取要的那么多", async () => {
    const file = await archiveOnDisk("generous.zip", bytes);
    const generous = async (position: number, length: number) =>
      Buffer.concat([await file.readAt(position, length), Buffer.alloc(64, "x")]);
    const listing = await listArchive("zip", "generous.zip", generous, {
      ...DEFAULTS,
      size: file.size,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["one.txt", "two.txt", "six.txt"]);
    expect(listing.truncated).toBe(false);
  });
});

/** The same archive with "number of this disk" set to 1 in its end record. */
function diskOne(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  copy.writeUInt16LE(1, copy.length - 22 + 4);
  return copy;
}
