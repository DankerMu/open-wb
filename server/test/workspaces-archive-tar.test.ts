import { constants, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { archiveFormat, listArchive } from "../src/workspaces/archive.js";
import {
  archiveOnDisk,
  DEFAULTS,
  EMPTY_MEMBER,
  emptyMembers,
  GNU_MAGIC,
  gzipMember,
  LONG_LINK,
  list,
  noise,
  paxRecord,
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

  it("成员名的 4096 上限按字节计而不是按字符：1365 个汉字（4095 字节）计入，1366 个（4098 字节）不计入", async () => {
    const fits = "字".repeat(1365);
    const over = "字".repeat(1366);
    expect(Buffer.byteLength(fits)).toBe(4095);
    expect(Buffer.byteLength(over)).toBe(4098);
    const { listing } = await list(
      "bytes.tar",
      Buffer.concat([
        tarFile("PaxHeaders/a", paxRecord("path", fits), { typeflag: "x" }),
        tarFile("short"),
        tarFile("PaxHeaders/b", paxRecord("path", over), { typeflag: "x" }),
        tarFile("short"),
        TAR_END,
      ]),
    );
    expect(listing.entries).toEqual([{ path: fits, type: "file", size: 0 }]);
    expect(listing.truncated).toBe(true);
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
        size: 0,
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

describe("tar.gz：gzip 流的头、流尾与流之后的字节", () => {
  const JUNK = Buffer.alloc(300_000, "j");
  const THREE_PATHS = ["a.txt", "dir/", "dir/b.md"];
  const paths = (listing: { entries: { path: string }[] }) =>
    listing.entries.map((entry) => entry.path);

  it("多成员 gzip（两个流首尾相接）：第一个流已到结束块则不读第二个流，没到则接着读；无关字节不是流", async () => {
    const second = gzipSync(Buffer.concat([tarFile("second.txt", "2"), TAR_END]));
    const complete = await list("multi.tgz", Buffer.concat([gzipSync(THREE_MEMBERS), second]));
    expect(paths(complete.listing)).toEqual(THREE_PATHS);
    expect(complete.listing.truncated).toBe(false);

    // The first stream has no end blocks: alone it is two members and a missing header; with the
    // second stream after it the walk goes on into that one and finds its end blocks.
    const first = gzipSync(Buffer.concat(emptyMembers(2)));
    const bare = await list("multi.tgz", first);
    const TWO = [
      { path: "m0", type: "file", size: 0 },
      { path: "m1", type: "file", size: 0 },
    ];
    expect(bare.listing).toEqual({ format: "tar.gz", entries: TWO, truncated: true });
    const open = await list("multi.tgz", Buffer.concat([first, second]));
    expect(open.listing).toEqual({
      format: "tar.gz",
      entries: [...TWO, { path: "second.txt", type: "file", size: 1 }],
      truncated: false,
    });

    // The walk asks for a third header and what follows the stream is no gzip header: none of it
    // is fed to the inflater or fetched, however much of it there is.
    const junk = await list("multi.tgz", Buffer.concat([first, JUNK]));
    expect(junk.listing).toEqual(bare.listing);
    expect(junk.file.positions).toEqual([0]);
    expect(open.file.positions).toEqual([0]);
  });

  it("压缩流跨多次读取、后跟无关字节：读到流尾为止，每次读取不超过 65536 字节", async () => {
    const whole = gzipSync(
      Buffer.concat([tarFile("noise.bin", noise(200_000)), tarFile("after.txt", "x"), TAR_END]),
    );
    expect(whole.length).toBeGreaterThan(3 * EXTENSION_LIMIT);
    expect(whole.length).toBeLessThan(4 * EXTENSION_LIMIT);
    const { file, listing } = await list("wide.tgz", Buffer.concat([whole, JUNK]));
    expect(listing).toEqual({
      format: "tar.gz",
      entries: [
        { path: "noise.bin", type: "file", size: 200_000 },
        { path: "after.txt", type: "file", size: 1 },
      ],
      truncated: false,
    });
    expect(file.positions).toEqual([0, 65_536, 131_072, 196_608]);
    expect(file.maxLength()).toBe(EXTENSION_LIMIT);
  });

  it("带尾部字节的包同样受时限约束：跳过 8 MiB 正文途中到时 → 恰一项并置 truncated", async () => {
    const bytes = gzipSync(
      Buffer.concat([
        tarFile("zeros.bin", Buffer.alloc(8 * 1024 * 1024)),
        tarFile("after.txt", "x"),
        TAR_END,
      ]),
    );
    const { file, listing } = await list("bombtail.tgz", Buffer.concat([bytes, JUNK]), {
      maxEntries: 1000,
      now: tickingClock(1000),
    });
    expect(listing.entries).toEqual([{ path: "zeros.bin", type: "file", size: 8_388_608 }]);
    expect(listing.truncated).toBe(true);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("带尾部字节的包到上限即停", async () => {
    const whole = gzipSync(Buffer.concat([...emptyMembers(5), TAR_END]));
    const { listing } = await list("captail.tgz", Buffer.concat([whole, JUNK]), {
      maxEntries: 3,
      now: () => 0,
    });
    expect(paths(listing)).toEqual(["m0", "m1", "m2"]);
    expect(listing.truncated).toBe(true);
  });

  it("gzip 头的可选字段（FEXTRA、FNAME、FCOMMENT、FHCRC）被跳过，gzip(1) 写的带文件名的头同样可读", async () => {
    const full = gzipMember(THREE_MEMBERS, {
      extra: Buffer.from("extra-field"),
      name: "x.tar",
      comment: "made by hand",
      headerCrc: true,
    });
    for (const bytes of [
      full,
      Buffer.concat([full, JUNK]),
      gzipMember(THREE_MEMBERS, { name: "x.tar" }),
      gzipMember(THREE_MEMBERS),
    ]) {
      const { listing } = await list("fields.tgz", bytes);
      expect(paths(listing)).toEqual(THREE_PATHS);
      expect(listing.truncated).toBe(false);
    }
  });

  it("流尾的 CRC 与长度恰好跨在两次读取之间：照常核对，后跟无关字节也不多列不少列", async () => {
    // FEXTRA is sized so that the 8 trailer bytes start 4 bytes before the 65536 boundary.
    const bare = gzipMember(THREE_MEMBERS);
    const straddling = gzipMember(THREE_MEMBERS, {
      extra: Buffer.alloc(EXTENSION_LIMIT - 4 - 2 - (bare.length - 8)),
    });
    expect(straddling.length).toBe(EXTENSION_LIMIT + 4);
    for (const bytes of [straddling, Buffer.concat([straddling, JUNK])]) {
      const { file, listing } = await list("straddle.tgz", bytes);
      expect(paths(listing)).toEqual(THREE_PATHS);
      expect(listing.truncated).toBe(false);
      expect(file.positions).toEqual([0, 65_536]);
      expect(file.maxLength()).toBe(EXTENSION_LIMIT);
    }
  });

  // A deflate block of the reserved type 3: zlib refuses it wherever it stands.
  const BAD_BLOCK = Buffer.from([0x07, 0xff, 0xff, 0xff, 0xff, 0xff]);

  it("deflate 数据在第一片之后才不合法 → 此前各片解出的成员照常列出并置 truncated（后跟无关字节同样）", async () => {
    const broken = Buffer.concat([
      gzipSync(THREE_MEMBERS).subarray(0, 10),
      deflateRawSync(Buffer.concat([tarFile("noise.bin", noise(4096)), tarFile("after.txt")]), {
        finishFlush: constants.Z_SYNC_FLUSH,
      }),
      BAD_BLOCK,
    ]);
    expect(broken.length).toBeGreaterThan(4096);
    for (const bytes of [broken, Buffer.concat([broken, JUNK])]) {
      const { listing } = await list("broken.tgz", bytes);
      expect(listing).toEqual({
        format: "tar.gz",
        entries: [{ path: "noise.bin", type: "file", size: 4096 }],
        truncated: true,
      });
    }
  });

  const flipped = (bytes: Buffer, at: number) => {
    const copy = Buffer.from(bytes);
    copy.writeUInt8(copy.readUInt8(at) ^ 1, at);
    return copy;
  };
  const gz = gzipSync(THREE_MEMBERS);
  const withHeaderCrc = gzipMember(THREE_MEMBERS, { headerCrc: true });
  const reserved = Buffer.from(gz);
  reserved.writeUInt8(0x20, 3);
  // Fixed part 10 + FEXTRA length 2 + 65524: the deflate data starts exactly at 65536.
  const filling = gzipMember(THREE_MEMBERS, { extra: Buffer.alloc(EXTENSION_LIMIT - 12) });
  // FNAME is flagged and the seven bytes after the fixed part are all there is: none of them is a NUL.
  const unnamed = Buffer.from([
    0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67,
  ]);

  it.each<[string, Buffer]>([
    ["流尾的 CRC-32 不符", flipped(gz, gz.length - 8)],
    ["流尾的长度不符", flipped(gz, gz.length - 4)],
    ["流尾的 CRC-32 不符，后跟无关字节", Buffer.concat([flipped(gz, gz.length - 8), JUNK])],
    ["压缩方法不是 deflate", flipped(gz, 2)],
    ["头里置了保留标志位", reserved],
    ["FHCRC 不符", flipped(withHeaderCrc, 10)],
    ["FNAME 没有结尾的 NUL", unnamed],
    ["FEXTRA 的长度读不全", Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 3, 9])],
    ["FEXTRA 声明的长度超出文件", Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 3, 9, 0, 1])],
    ["deflate 数据一开始就不合法", Buffer.concat([gz.subarray(0, 10), BAD_BLOCK])],
    ["只有 10 字节的头", gz.subarray(0, 10)],
    ["头恰好占满第一次读取的 65536 字节", filling],
    ["不足 10 字节", gz.subarray(0, 9)],
  ])("gzip 流自身损坏、一项都读不出 → 不支持：%s", async (_label, bytes) => {
    await expect(list("bad.tgz", bytes)).rejects.toMatchObject(UNSUPPORTED);
  });

  it("流尾的 8 个字节不全（切掉末 3 字节）而结束块已读到 → 照常列出，不置 truncated", async () => {
    const { listing } = await list("short-trailer.tgz", gz.subarray(0, gz.length - 3));
    expect(paths(listing)).toEqual(THREE_PATHS);
    expect(listing.truncated).toBe(false);
  });
});

describe("tar.gz：多成员 gzip 的边界", () => {
  const JUNK = Buffer.alloc(300_000, "j");
  // `a.txt` without end blocks, then `b.txt` with them: the tar ends only inside a second stream.
  const A_TAR = tarFile("a.txt", "hello");
  const B_TAR = Buffer.concat([tarFile("b.txt", "world!"), TAR_END]);
  const A = gzipSync(A_TAR);
  const B = gzipSync(B_TAR);
  const A_ENTRY = { path: "a.txt", type: "file", size: 5 };
  const B_ENTRY = { path: "b.txt", type: "file", size: 6 };
  const ONLY_A = { format: "tar.gz", entries: [A_ENTRY], truncated: true };
  const BOTH = { format: "tar.gz", entries: [A_ENTRY, B_ENTRY], truncated: false };
  const increasing = (positions: number[]) =>
    positions.every((position, index) => index === 0 || position > (positions[index - 1] ?? 0));

  // A tar without end blocks whose deflate data is a whole number of 1024-byte slices: the body
  // length is searched for, since the compressed length does not follow from it.
  const alignedTar = () => {
    for (let length = 2500; length < 6000; length += 1) {
      const tar = Buffer.concat([tarFile("pad.bin", noise(length)), tarFile("after.txt")]);
      if (deflateRawSync(tar).length % 1024 === 0) {
        return { tar, length };
      }
    }
    throw new Error("no body length aligns the deflate data to 1024 bytes");
  };

  it("deflate 数据恰在 1024 字节的片边界结束（流尾整个落在下一片）：有无 300000 个尾部字节列表相同，尾部不读；后跟第二个流则接着读", async () => {
    const { tar, length } = alignedTar();
    const member = gzipMember(tar);
    // 10 header bytes, the deflate data, 8 trailer bytes: the slices start right after the header.
    expect((member.length - 10 - 8) % 1024).toBe(0);
    expect(member.length).toBeLessThan(EXTENSION_LIMIT);
    const entries = [
      { path: "pad.bin", type: "file", size: length },
      { path: "after.txt", type: "file", size: 0 },
    ];
    const bare = await list("aligned.tgz", member);
    expect(bare.listing).toEqual({ format: "tar.gz", entries, truncated: true });
    expect(bare.file.positions).toEqual([0]);
    const tailed = await list("aligned.tgz", Buffer.concat([member, JUNK]));
    expect(tailed.listing).toEqual(bare.listing);
    expect(tailed.file.positions).toEqual([0]);

    const continued = await list("aligned.tgz", Buffer.concat([member, B, JUNK]));
    expect(continued.listing).toEqual({
      format: "tar.gz",
      entries: [...entries, B_ENTRY],
      truncated: false,
    });
    expect(continued.file.positions).toEqual([0]);
    // Trailer and second stream together are less than one slice, and the file ends with them.
    const last = await list("aligned.tgz", Buffer.concat([member, B]));
    expect(last.listing).toEqual(continued.listing);
  });

  it("50 个空的 gzip 流（各 20 字节、解出零字节）被逐个越过，其后的流照常列出", async () => {
    expect(EMPTY_MEMBER).toHaveLength(20);
    const chain = Buffer.alloc(50 * 20, EMPTY_MEMBER);
    const { file, listing } = await list("empties.tgz", Buffer.concat([chain, A, chain, B]));
    expect(listing).toEqual(BOTH);
    expect(file.positions).toEqual([0]);
  });

  it.each([
    ["一开始就是", Buffer.alloc(0), []],
    ["一个成员之后是", A, [A_ENTRY]],
  ])(
    "%s 100000 个空的 gzip 流 → 到时返回已读到的项并置 truncated，只取了第一块压缩字节",
    async (_label, lead, entries) => {
      const chain = Buffer.alloc(100_000 * 20, EMPTY_MEMBER);
      const { file, listing } = await list("chain.tgz", Buffer.concat([lead, chain, B]), {
        maxEntries: 1000,
        now: tickingClock(1000),
      });
      expect(listing).toEqual({ format: "tar.gz", entries, truncated: true });
      expect(file.positions).toEqual([0]);
    },
  );

  it.each([
    ["头的 10 个字节有 5 个在第一次读取里", 65_531, [0, 65_531]],
    ["头只有第一个字节在第一次读取里", 65_535, [0, 65_535]],
    ["头恰从第二次读取的开头起", 65_536, [0, 65_536]],
    ["前一个流的流尾跨在两次读取之间", 65_540, [0, 65_536]],
  ])(
    "下一个流的头跨在 65536 字节的读取边界上（%s）→ 从该流的偏移另读一次，不回头、不超 65536",
    async (_label, boundary, positions) => {
      // FEXTRA is sized so that the first stream, trailer included, ends at `boundary`.
      const first = gzipMember(A_TAR, {
        extra: Buffer.alloc(boundary - 2 - gzipMember(A_TAR).length),
      });
      expect(first).toHaveLength(boundary);
      const second = gzipMember(B_TAR, { extra: Buffer.from("subfield"), name: "b.tar" });
      const { file, listing } = await list("straddle.tgz", Buffer.concat([first, second, JUNK]));
      expect(listing).toEqual(BOTH);
      expect(file.positions).toEqual(positions);
      expect(file.maxLength()).toBe(EXTENSION_LIMIT);
    },
  );

  it("跨多次读取的 400 多个流：读取位置严格递增（不重放），每次不超过 65536 字节", async () => {
    const tar = Buffer.concat([
      tarFile("noise.bin", noise(200_000)),
      tarFile("after.txt"),
      TAR_END,
    ]);
    const streams = Array.from({ length: tar.length / 512 }, (_, index) =>
      gzipSync(tar.subarray(index * 512, (index + 1) * 512)),
    );
    const bytes = Buffer.concat(streams);
    expect(bytes.length).toBeGreaterThan(3 * EXTENSION_LIMIT);
    const { file, listing } = await list("blocks.tgz", bytes);
    expect(listing).toEqual({
      format: "tar.gz",
      entries: [
        { path: "noise.bin", type: "file", size: 200_000 },
        { path: "after.txt", type: "file", size: 0 },
      ],
      truncated: false,
    });
    expect(file.positions[0]).toBe(0);
    expect(increasing(file.positions)).toBe(true);
    // Every read but a re-read at a straddling header moves on by 65536: no read per stream.
    expect(file.positions.length).toBeLessThanOrEqual(
      2 * Math.ceil(bytes.length / EXTENSION_LIMIT),
    );
    expect(file.maxLength()).toBe(EXTENSION_LIMIT);
  });

  const header = (flags: number, ...rest: number[]) =>
    Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3, ...rest]);
  const reserved = Buffer.from(B);
  reserved.writeUInt8(0x40, 3);
  const badHeaderCrc = gzipMember(B_TAR, { headerCrc: true });
  badHeaderCrc.writeUInt8(badHeaderCrc.readUInt8(10) ^ 1, 10);

  it.each<[string, Buffer]>([
    ["1024 个零字节（按块补齐的填充）", Buffer.alloc(1024)],
    ["300000 个零字节", Buffer.alloc(300_000)],
    ["只有魔数的第一个字节", Buffer.from([0x1f])],
    ["不足 10 字节的头", header(0).subarray(0, 9)],
    ["恰 10 字节的头，其后没有数据", header(0)],
    ["FNAME 没有结尾的 NUL", header(8, 0x61, 0x62, 0x63)],
    ["FEXTRA 声明的长度超出文件", header(4, 9, 0, 1)],
    ["头里置了保留标志位的完整的流", reserved],
    ["FHCRC 不符的完整的流", badHeaderCrc],
  ])("完整的流之后不构成合法 gzip 头的字节被忽略，不多读：%s", async (_label, tail) => {
    const bare = await list("tail.tgz", A);
    expect(bare.listing).toEqual(ONLY_A);
    const open = await list("tail.tgz", Buffer.concat([A, tail]));
    expect(open.listing).toEqual(ONLY_A);
    expect(open.file.positions).toEqual([0]);

    const closed = await list("tail.tgz", Buffer.concat([A, B, tail]));
    expect(closed.listing).toEqual(BOTH);
    expect(closed.file.positions).toEqual([0]);
  });

  it.each([
    ["紧跟在第一次读取里的流之后", gzipMember(A_TAR).length + 2],
    ["恰从第二次读取的开头起", 65_536],
  ])(
    "下一个流的头在一次 65536 字节的读取里结束不了（FNAME 70000 字节没有 NUL，%s）→ 忽略，至多为它另读一次",
    async (_label, at) => {
      const first = gzipMember(A_TAR, { extra: Buffer.alloc(at - 2 - gzipMember(A_TAR).length) });
      const endless = Buffer.concat([header(8), Buffer.alloc(70_000, "n")]);
      const { file, listing } = await list("endless.tgz", Buffer.concat([first, endless]));
      expect(listing).toEqual(ONLY_A);
      expect(file.positions).toEqual([0, at]);
    },
  );

  it("第二个流在 deflate 数据中途被截断 → 此前解出的成员照常列出并置 truncated", async () => {
    const second = gzipSync(
      Buffer.concat([tarFile("b.txt", "world!"), tarFile("noise.bin", noise(8192)), TAR_END]),
    );
    expect(second.length).toBeGreaterThan(8192);
    const { listing } = await list("cut.tgz", Buffer.concat([A, second.subarray(0, 4096)]));
    expect(listing).toEqual({
      format: "tar.gz",
      entries: [A_ENTRY, B_ENTRY, { path: "noise.bin", type: "file", size: 8192 }],
      truncated: true,
    });
  });

  it("流尾的 CRC-32 不符的流之后不接着读下一个流", async () => {
    const flip = (bytes: Buffer) => {
      const copy = Buffer.from(bytes);
      copy.writeUInt8(copy.readUInt8(copy.length - 8) ^ 1, copy.length - 8);
      return copy;
    };
    // The first stream's own listing is refused as before; `b.txt` does not stand in for it.
    await expect(list("crc.tgz", Buffer.concat([flip(A), B]))).rejects.toMatchObject(UNSUPPORTED);
    // The second stream's members are dropped with its bad trailer, the third is not read.
    const third = gzipSync(Buffer.concat([tarFile("c.txt"), TAR_END]));
    const { listing } = await list(
      "crc.tgz",
      Buffer.concat([A, flip(gzipSync(tarFile("b.txt"))), third]),
    );
    expect(listing).toEqual(ONLY_A);
  });

  it("条目上限在第二个流里达到 → 到上限即停并置 truncated", async () => {
    const first = gzipSync(Buffer.concat(emptyMembers(2)));
    const second = gzipSync(Buffer.concat([...emptyMembers(5), TAR_END]));
    const { listing } = await list("cap.tgz", Buffer.concat([first, second]), {
      maxEntries: 4,
      now: () => 0,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1", "m0", "m1"]);
    expect(listing.truncated).toBe(true);
  });
});

describe("tar 遍历器：没有正文的成员", () => {
  it.each([
    ["1", "硬链接", "file"],
    ["2", "符号链接", "file"],
    ["3", "字符设备", "file"],
    ["4", "块设备", "file"],
    ["5", "目录", "dir"],
    ["6", "FIFO", "file"],
  ] as const)(
    "类型 %s（%s）头里的大小 1536 不跳过任何字节：下一个头紧随其后（tar.gz 同样）",
    async (typeflag, _kind, type) => {
      const bytes = Buffer.concat([
        tarHeader({ name: "bodyless", typeflag, size: 1536 }),
        tarFile("after.txt", "x"),
        TAR_END,
      ]);
      for (const name of ["kinds.tar", "kinds.tgz"]) {
        const { listing } = await list(name, name === "kinds.tar" ? bytes : gzipSync(bytes));
        expect(listing.entries, name).toEqual([
          { path: "bodyless", type, size: 1536 },
          { path: "after.txt", type: "file", size: 1 },
        ]);
        expect(listing.truncated).toBe(false);
      }
    },
  );

  it.each([
    ["0", "普通文件"],
    ["\u0000", "旧式普通文件"],
    ["7", "连续文件"],
    ["S", "未知类型"],
  ])("类型 %j（%s）有正文：按头里的大小跳过", async (typeflag) => {
    const body = Buffer.concat([tarHeader({ name: "inside-body.txt" }), Buffer.alloc(100, "b")]);
    const { file, listing } = await list(
      "bodies.tar",
      Buffer.concat([tarFile("with-body", body, { typeflag }), tarFile("after.txt"), TAR_END]),
    );
    expect(listing.entries).toEqual([
      { path: "with-body", type: "file", size: 612 },
      { path: "after.txt", type: "file", size: 0 },
    ]);
    expect(listing.truncated).toBe(false);
    expect(file.positions).toEqual([0, 1536, 2048]);
  });
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

describe("tar 遍历器：扩展记录给出的名字", () => {
  const paths = async (...blocks: Buffer[]) => {
    const { listing } = await list("names.tar", Buffer.concat([...blocks, TAR_END]));
    expect(listing.truncated).toBe(false);
    return listing.entries.map((entry) => entry.path);
  };

  it("pax 全局头 g 里的 path 记录不作用于后面的成员：path 是成员头自己的名字", async () => {
    expect(
      await paths(
        tarFile("pax_global_header", paxRecord("path", "ignored-global.txt"), { typeflag: "g" }),
        tarFile("own-name.txt", "abc"),
      ),
    ).toEqual(["own-name.txt"]);
  });

  it("GNU 的 K（长链接目标）记录紧挨着成员、中间没有 L 或 x：path 是成员头自己的名字", async () => {
    expect(
      await paths(
        tarFile(LONG_LINK, "link-target\u0000", { typeflag: "K" }),
        tarFile("own-name.txt", "", { typeflag: "2" }),
      ),
    ).toEqual(["own-name.txt"]);
  });

  it("同一个成员的 pax x 记录排在 GNU L 记录之前时，仍是 pax 的 path 优先", async () => {
    expect(
      await paths(
        tarFile("PaxHeaders/x", paxRecord("path", "from-pax.txt"), { typeflag: "x" }),
        tarFile(LONG_LINK, "from-long-name.txt\u0000", { typeflag: "L" }),
        tarFile("from-header.txt"),
        tarFile("next.txt"),
      ),
    ).toEqual(["from-pax.txt", "next.txt"]);
  });

  it("一个 pax 扩展头里有两条 path 记录时取后一条", async () => {
    expect(
      await paths(
        tarFile("PaxHeaders/x", paxRecord("path", "first.txt") + paxRecord("path", "second.txt"), {
          typeflag: "x",
        }),
        tarFile("from-header.txt"),
      ),
    ).toEqual(["second.txt"]);
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

  it("读出若干项之后才损坏（坏校验和、没有结束块、gzip 流被截断或中途损坏）→ 已读到的项并置 truncated；完整的流后跟无关字节不算损坏", async () => {
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
    // `whole` is a complete archive, end blocks included, and lists as one: what the two cases
    // below report is caused by the cut and by the overwritten bytes alone.
    const whole = gzipSync(Buffer.concat([...emptyMembers(3000), TAR_END]));
    expect(whole.length).toBeGreaterThan(4096);
    const intact = await list("whole.tgz", whole, { maxEntries: 5000, now: () => 0 });
    expect(intact.listing.entries).toHaveLength(3000);
    expect(intact.listing.truncated).toBe(false);
    const middle = Math.floor(whole.length / 2);
    const garbled = Buffer.from(whole);
    garbled.fill(0xff, middle, middle + 64);
    for (const [name, bytes] of [
      ["cut.tar.gz", whole.subarray(0, middle)],
      ["garbled.tgz", garbled],
      ["garbled-tail.tgz", Buffer.concat([garbled, Buffer.alloc(300_000, "j")])],
    ] as const) {
      const { listing } = await list(name, bytes, { maxEntries: 5000, now: () => 0 });
      const count = listing.entries.length;
      expect(count, name).toBeGreaterThan(0);
      expect(count, name).toBeLessThan(3000);
      expect(listing.entries.map((entry) => entry.path)).toEqual(
        Array.from({ length: count }, (_, index) => `m${index}`),
      );
      expect(listing.truncated).toBe(true);
    }

    // Bytes after the complete stream are not part of it: the same listing as without them.
    const tail = await list("tail.tgz", Buffer.concat([whole, Buffer.alloc(300_000, "j")]), {
      maxEntries: 5000,
      now: () => 0,
    });
    expect(tail.listing).toEqual(intact.listing);
  });

  it("读函数自己的失败原样抛出，不当作包损坏", async () => {
    const failure = new Error("EIO");
    const failing = () => Promise.reject(failure);
    await expect(listArchive("tar", "x.tar", failing, DEFAULTS)).rejects.toBe(failure);
    await expect(listArchive("tar.gz", "x.tgz", failing, DEFAULTS)).rejects.toBe(failure);

    // The body does not compress: the stream runs past the first 65536 bytes, so a second read is due.
    const bytes = gzipSync(
      Buffer.concat([...emptyMembers(2), tarFile("noise.bin", noise(100_000))]),
    );
    expect(bytes.length).toBeGreaterThan(EXTENSION_LIMIT);
    const file = await archiveOnDisk("x.tgz", bytes);
    const failsLater = (position: number, length: number) =>
      position === 0 ? file.readAt(position, length) : Promise.reject(failure);
    await expect(listArchive("tar.gz", "x.tgz", failsLater, DEFAULTS)).rejects.toBe(failure);
  });
});
