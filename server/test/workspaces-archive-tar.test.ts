import { constants, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { archiveFormat, listArchive } from "../src/workspaces/archive.js";
import {
  archiveOnDisk,
  DEFAULTS,
  emptyMembers,
  GNU_MAGIC,
  LONG_LINK,
  list,
  TAR_END,
  THREE_MEMBERS,
  tarFile,
  tarHeader,
  tickingClock,
  UNSUPPORTED,
} from "./workspaces-archive-helpers.js";

// The tar walker's edges beyond the spec scenarios in `workspaces-archive.test.ts`: exact limits,
// header forms and every kind of corruption. Limits are literals from the spec.
const EXTENSION_LIMIT = 65_536;

describe("tar 遍历器：上限的边界", () => {
  it("恰有上限那么多成员的包也报 truncated（到上限即停，不探下一个头）；少一个成员则不报", async () => {
    const atLimit = await list("x.tar", Buffer.concat([...emptyMembers(3), TAR_END]), {
      maxEntries: 3,
      now: () => 0,
    });
    expect(atLimit.listing.entries).toHaveLength(3);
    expect(atLimit.listing.truncated).toBe(true);

    const below = await list("x.tar", Buffer.concat([...emptyMembers(2), TAR_END]), {
      maxEntries: 3,
      now: () => 0,
    });
    expect(below.listing.entries).toHaveLength(2);
    expect(below.listing.truncated).toBe(false);
  });

  it("扩展记录的声明长度恰 65536 字节时读入，65537 字节时不读", async () => {
    const atLimit = await list(
      "edge.tar",
      Buffer.concat([
        tarFile(LONG_LINK, Buffer.concat([Buffer.from("edge-name"), Buffer.alloc(65_527)]), {
          typeflag: "L",
        }),
        tarFile("short"),
        TAR_END,
      ]),
    );
    expect(atLimit.listing.entries).toEqual([{ path: "edge-name", type: "file", size: 0 }]);
    expect(atLimit.listing.truncated).toBe(false);
    expect(atLimit.file.maxLength()).toBe(EXTENSION_LIMIT);

    const over = await list(
      "edge.tar",
      Buffer.concat([
        tarFile("first"),
        tarFile(LONG_LINK, Buffer.concat([Buffer.from("edge-name"), Buffer.alloc(65_528)]), {
          typeflag: "L",
        }),
        tarFile("short"),
        TAR_END,
      ]),
    );
    expect(over.listing.entries.map((entry) => entry.path)).toEqual(["first"]);
    expect(over.listing.truncated).toBe(true);
    expect(over.file.maxLength()).toBe(512);
  });

  it("时限恰到 5000 毫秒即停；4999 毫秒时照常读完", async () => {
    const bytes = Buffer.concat([...emptyMembers(2), TAR_END]);
    for (const [elapsed, count] of [
      [4999, 2],
      [5000, 1],
    ] as const) {
      const file = await archiveOnDisk("edge.tar", bytes);
      let clock = 0;
      const readAt = (position: number, length: number) => {
        clock = elapsed;
        return file.readAt(position, length);
      };
      const listing = await listArchive("tar", "edge.tar", readAt, {
        maxEntries: 1000,
        now: () => clock,
      });
      expect(listing.entries, String(elapsed)).toHaveLength(count);
      expect(listing.truncated).toBe(count === 1);
    }
  });
});

describe("tar.gz：解压不出字节的输入也受时限约束", () => {
  // A gzip header, optionally one deflate stream flushed without its final block, then empty
  // stored blocks: valid input that never ends and inflates to nothing more.
  const stalling = (member: Buffer) =>
    Buffer.concat([
      Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]),
      member.length === 0
        ? member
        : deflateRawSync(member, { finishFlush: constants.Z_SYNC_FLUSH }),
      Buffer.alloc(200 * 1024, Buffer.from([0, 0, 0, 0xff, 0xff])),
    ]);

  it.each([
    ["一个成员之后", stalling(tarFile("only.txt")), [{ path: "only.txt", type: "file", size: 0 }]],
    ["一开始就", stalling(Buffer.alloc(0)), []],
  ])(
    "%s是解压为零字节的 200 KiB 输入 → 到时返回已读到的项并置 truncated，只取了第一块压缩字节",
    async (_label, bytes, entries) => {
      const { file, listing } = await list("stall.tgz", bytes, {
        maxEntries: 1000,
        now: tickingClock(1000),
      });
      expect(listing).toEqual({ format: "tar.gz", entries, truncated: true });
      expect(file.positions).toEqual([0]);
    },
  );
});

describe("tar 遍历器：头的形态", () => {
  it("prefix 只在 magic 恰为 ustar\\0 时拼到 name 前面；GNU magic 下该区域不是 prefix", async () => {
    const { listing } = await list(
      "prefix.tar",
      Buffer.concat([
        tarHeader({ name: "leaf.txt", prefix: "some/long/dir" }),
        tarHeader({ name: "bare.txt" }),
        tarHeader({ name: "gnu.txt", prefix: "0000000000\u000012345", magic: GNU_MAGIC }),
        tarHeader({ name: "v7.txt", prefix: "junk", magic: "" }),
        TAR_END,
      ]),
    );
    expect(listing.entries.map((entry) => entry.path)).toEqual([
      "some/long/dir/leaf.txt",
      "bare.txt",
      "gnu.txt",
      "v7.txt",
    ]);
  });

  it("不合法的 UTF-8 替换为 U+FFFD；目录之外的类型（符号链接等）一律是 file", async () => {
    const { listing } = await list(
      "odd.tar",
      Buffer.concat([
        tarFile(Buffer.from([0x61, 0xff, 0x62]), "", { typeflag: "2" }),
        tarFile("old-style", "", { typeflag: "\u0000" }),
        TAR_END,
      ]),
    );
    expect(listing.entries).toEqual([
      { path: "a�b", type: "file", size: 0 },
      { path: "old-style", type: "file", size: 0 },
    ]);
  });
});

describe("tar 遍历器：损坏", () => {
  const junk = Buffer.from(Array.from({ length: 1024 }, (_, index) => (index * 31 + 7) % 251));
  const badChecksum = tarHeader({ name: "bad.txt" });
  badChecksum.write("x", 0, "latin1");
  const base256 = Buffer.alloc(12);
  base256.writeUInt8(0x80, 0);
  base256.writeUInt8(5, 11);

  const withSize = (rawSize: Buffer) => Buffer.concat([tarHeader({ name: "b", rawSize }), TAR_END]);
  const paxOnly = (records: string) =>
    Buffer.concat([tarFile("p", records, { typeflag: "x" }), TAR_END]);
  const cutLongName = Buffer.concat([
    tarHeader({ name: LONG_LINK, typeflag: "L", size: 600 }),
    Buffer.alloc(100, "n"),
  ]);

  it.each<[string, string, Buffer]>([
    ["随机 1 KiB 的 junk.tar", "junk.tar", junk],
    ["内容不是 gzip 的 x.tgz", "x.tgz", THREE_MEMBERS],
    ["0 字节的 empty.tar", "empty.tar", Buffer.alloc(0)],
    ["0 字节的 empty.tgz", "empty.tgz", Buffer.alloc(0)],
    ["不足 512 字节的头", "short.tar", THREE_MEMBERS.subarray(0, 300)],
    ["校验和不符的头", "sum.tar", Buffer.concat([badChecksum, TAR_END])],
    ["base-256 的 size", "b256.tar", withSize(base256)],
    ["空的 size", "nosize.tar", withSize(Buffer.alloc(12))],
    ["size 里有非八进制字符", "size.tar", withSize(Buffer.from("0000000009\u0000 "))],
    ["读不全的 L 记录", "cutl.tar", cutLongName],
    ["没有换行结尾的 pax 记录", "pax1.tar", paxOnly("12 path=abc ")],
    ["长度不是十进制数的 pax 记录", "pax2.tar", paxOnly("1x path=abc\n")],
    ["长度超出扩展头的 pax 记录", "pax3.tar", paxOnly("99 path=abc\n")],
    ["没有等号的 pax 记录", "pax4.tar", paxOnly("9 pathab\n")],
    ["没有空格的 pax 记录", "pax5.tar", paxOnly("9path=ab\n")],
  ])("一项都读不出 → 不支持：%s", async (_label, name, bytes) => {
    await expect(list(name, bytes)).rejects.toMatchObject(UNSUPPORTED);
  });

  it("只有结束块的包是空列表，不是不支持", async () => {
    for (const [name, bytes] of [
      ["none.tar", TAR_END],
      ["none.tar.gz", gzipSync(TAR_END)],
    ] as const) {
      expect((await list(name, bytes)).listing, name).toEqual({
        format: archiveFormat(name),
        entries: [],
        truncated: false,
      });
    }
  });

  it("读出若干项之后才损坏（坏校验和、没有结束块、gzip 流被截断或后跟无关字节）→ 已读到的项并置 truncated", async () => {
    const afterTwo = await list(
      "sum.tar",
      Buffer.concat([...emptyMembers(2), badChecksum, TAR_END]),
    );
    expect(afterTwo.listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1"]);
    expect(afterTwo.listing.truncated).toBe(true);

    const noEnd = await list("noend.tar", Buffer.concat(emptyMembers(2)));
    expect(noEnd.listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1"]);
    expect(noEnd.listing.truncated).toBe(true);

    // How many members come out before a gzip error depends on zlib's block boundaries, so the
    // count is only bracketed; what is pinned is that the listed ones are a prefix, in order.
    const whole = gzipSync(Buffer.concat(emptyMembers(3000)));
    expect(whole.length).toBeGreaterThan(4096);
    for (const [name, bytes] of [
      ["cut.tar.gz", whole.subarray(0, Math.floor(whole.length / 2))],
      ["tail.tgz", Buffer.concat([whole, Buffer.alloc(300_000, "j")])],
    ] as const) {
      const { listing } = await list(name, bytes, { maxEntries: 5000, now: () => 0 });
      const count = listing.entries.length;
      expect(count, name).toBeGreaterThan(0);
      expect(count, name).toBeLessThanOrEqual(3000);
      expect(listing.entries.map((entry) => entry.path)).toEqual(
        Array.from({ length: count }, (_, index) => `m${index}`),
      );
      expect(listing.truncated).toBe(true);
    }
  });

  it("读函数自己的失败原样抛出，不当作包损坏", async () => {
    const failure = new Error("EIO");
    const failing = () => Promise.reject(failure);
    await expect(listArchive("tar", "x.tar", failing, DEFAULTS)).rejects.toBe(failure);
    await expect(listArchive("tar.gz", "x.tgz", failing, DEFAULTS)).rejects.toBe(failure);

    const file = await archiveOnDisk("x.tgz", gzipSync(Buffer.concat(emptyMembers(2))));
    const failsLater = (position: number, length: number) =>
      position === 0 ? file.readAt(position, length) : Promise.reject(failure);
    await expect(listArchive("tar.gz", "x.tgz", failsLater, DEFAULTS)).rejects.toBe(failure);
  });
});
