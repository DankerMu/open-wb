import { readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveFormat, listArchive } from "../src/workspaces/archive.js";
import { tempDir } from "./core-db-helpers.js";
import { spyBodyIo } from "./workspace-file-helpers.js";
import {
  archiveOnDisk,
  DEFAULTS,
  emptyMembers,
  GNU_MAGIC,
  LONG_LINK,
  list,
  paxRecord,
  TAR_END,
  THREE_MEMBERS,
  tarFile,
  tarHeader,
  tickingClock,
  UNSUPPORTED,
  ZIP_THREE_RECORDS,
  zipArchive,
  zipCentral,
} from "./workspaces-archive-helpers.js";

// Literals on purpose: the limits and the expected listings come from the spec (workspaces
//「压缩包列表」), not from the module under test. The walker's own edges (exact limits, header
// forms, every kind of corruption) are in `workspaces-archive-tar.test.ts`.
const EXTENSION_LIMIT = 65_536;
const NAME_LIMIT = 4096;
const THREE_ENTRIES = [
  { path: "a.txt", type: "file", size: 5 },
  { path: "dir/", type: "dir", size: 0 },
  { path: "dir/b.md", type: "file", size: 7 },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("压缩包列表：三种格式的列表", () => {
  it.each([
    ["x.tar", "tar"],
    ["x.tar.gz", "tar.gz"],
    ["x.tgz", "tar.gz"],
    ["X.TAR.GZ", "tar.gz"],
    ["Backup.TGZ", "tar.gz"],
    ["notes.txt.gz", "gz"],
    ["OLD.TAR", "tar"],
    ["x.zip", "zip"],
    ["X.ZIP", "zip"],
    ["readme.md", null],
    ["tar", null],
  ])("archiveFormat(%s) 按小写文件名判定为 %s", (name, format) => {
    expect(archiveFormat(name)).toBe(format);
  });

  it("x.zip、x.tar、x.tar.gz、x.tgz 列出同样的三项，包所在目录与临时目录没有新增文件", async () => {
    const dir = tempDir();
    const emptyTmp = tempDir();
    const tar = await archiveOnDisk("x.tar", THREE_MEMBERS, dir);
    const tarGz = await archiveOnDisk("x.tar.gz", gzipSync(THREE_MEMBERS), dir);
    const tgz = await archiveOnDisk("x.tgz", gzipSync(THREE_MEMBERS), dir);
    const zip = await archiveOnDisk("x.zip", zipArchive(ZIP_THREE_RECORDS), dir);
    const before = readdirSync(dir);
    vi.stubEnv("TMPDIR", emptyTmp);

    expect(await listArchive("tar", "x.tar", tar.readAt, DEFAULTS)).toEqual({
      format: "tar",
      entries: THREE_ENTRIES,
      truncated: false,
    });
    expect(await listArchive("zip", "x.zip", zip.readAt, { ...DEFAULTS, size: zip.size })).toEqual({
      format: "zip",
      entries: THREE_ENTRIES,
      truncated: false,
    });
    expect(zip.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    for (const [name, file] of [
      ["x.tar.gz", tarGz],
      ["x.tgz", tgz],
    ] as const) {
      expect(await listArchive("tar.gz", name, file.readAt, DEFAULTS), name).toEqual({
        format: "tar.gz",
        entries: THREE_ENTRIES,
        truncated: false,
      });
      expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    }

    // Only the four headers were read: member bodies of an uncompressed tar are stepped over.
    expect(tar.positions).toEqual([0, 1024, 1536, 2560]);
    expect(tar.maxLength()).toBe(512);
    expect(readdirSync(emptyTmp)).toEqual([]);
    expect(readdirSync(dir)).toEqual(before);
  });

  it("单个 gz 恰一项：去掉结尾 .gz 的文件名（保留大小写）、大小未知，不读任何字节", async () => {
    const { file, listing } = await list("notes.txt.gz", gzipSync("some notes"));
    expect(listing).toEqual({
      format: "gz",
      entries: [{ path: "notes.txt", type: "file", size: null }],
      truncated: false,
    });
    expect(file.positions).toEqual([]);

    const notGzip = await list("Report.CSV.GZ", Buffer.from("not gzip at all"));
    expect(notGzip.listing.entries).toEqual([{ path: "Report.CSV", type: "file", size: null }]);
    expect(notGzip.file.positions).toEqual([]);
  });
});

describe("压缩包列表：上限与长文件名", () => {
  it("1500 个成员的 big.tar.gz 恰 1000 项并置 truncated", async () => {
    const { file, listing } = await list(
      "big.tar.gz",
      gzipSync(Buffer.concat([...emptyMembers(1500), TAR_END])),
    );
    expect(listing.entries).toHaveLength(1000);
    expect(listing.entries[0]).toEqual({ path: "m0", type: "file", size: 0 });
    expect(listing.entries[999]).toEqual({ path: "m999", type: "file", size: 0 });
    expect(listing.truncated).toBe(true);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("1500 个成员的 big.zip 恰 1000 项并置 truncated，第 1001 个目录项不读，单次读取不超过 65536 字节", async () => {
    // Fixed-width names: every record is 46 + 5 bytes, so record N begins at 51 * N.
    const records = Array.from({ length: 1500 }, (_, index) =>
      zipCentral({ name: `m${String(index).padStart(4, "0")}`, size: index }),
    );
    const bytes = zipArchive(records);
    expect(bytes).toHaveLength(1500 * 51 + 22);
    expect(bytes.length).toBeGreaterThan(65_577);
    const { file, listing } = await list("big.zip", bytes);
    expect(listing.entries).toHaveLength(1000);
    expect(listing.entries[0]).toEqual({ path: "m0000", type: "file", size: 0 });
    expect(listing.entries[999]).toEqual({ path: "m0999", type: "file", size: 999 });
    expect(listing.format).toBe("zip");
    expect(listing.truncated).toBe(true);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    expect(file.positions).toContain(51 * 999);
    expect(file.positions).not.toContain(51 * 1000);
  });

  it("上限 3 时 5 个成员的 x.tar 恰 3 项并置 truncated，到上限后不再读下一个头", async () => {
    const { file, listing } = await list("x.tar", Buffer.concat([...emptyMembers(5), TAR_END]), {
      maxEntries: 3,
      now: () => 0,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1", "m2"]);
    expect(listing.truncated).toBe(true);
    expect(file.positions).toEqual([0, 512, 1024]);
  });

  it("GNU 长文件名记录给出的 200 字符路径完整出现在 path 里，记录本身不是成员", async () => {
    const longPath = `${"deep/".repeat(39)}leaf.txt`;
    expect(longPath).toHaveLength(203);
    const { listing } = await list(
      "long.tar",
      Buffer.concat([
        tarFile(LONG_LINK, `${longPath}\u0000`, { typeflag: "L", magic: GNU_MAGIC }),
        tarFile(longPath.slice(0, 100), "abc", { magic: GNU_MAGIC }),
        tarFile("next.txt", "", { magic: GNU_MAGIC }),
        TAR_END,
      ]),
    );
    expect(listing).toEqual({
      format: "tar",
      entries: [
        { path: longPath, type: "file", size: 3 },
        { path: "next.txt", type: "file", size: 0 },
      ],
      truncated: false,
    });
  });

  it("pax path 记录给出的中文路径完整出现在 path 里；x、g、K 记录都不是成员，pax 的 path 优先于 L", async () => {
    const chinese = "资料/二〇二六年/会议纪要（终稿）.md";
    const bytes = Buffer.concat([
      tarFile("pax_global_header", paxRecord("comment", "global"), { typeflag: "g" }),
      tarFile(
        "PaxHeaders/x",
        paxRecord("mtime", "1700000000.5") + paxRecord("path", chinese) + paxRecord("size", "99"),
        { typeflag: "x" },
      ),
      tarFile("ascii-fallback.md", "12345678"),
      tarFile(LONG_LINK, "link-target\u0000", { typeflag: "K" }),
      tarFile(LONG_LINK, "from-long-name\u0000", { typeflag: "L" }),
      tarFile("PaxHeaders/y", paxRecord("path", "来自pax/"), { typeflag: "x" }),
      tarFile("fallback-dir/", "", { typeflag: "5" }),
      tarFile("plain.txt"),
      TAR_END,
    ]);
    for (const name of ["pax.tar", "pax.tgz"]) {
      const { listing } = await list(name, name === "pax.tar" ? bytes : gzipSync(bytes));
      expect(listing.entries, name).toEqual([
        { path: chinese, type: "file", size: 8 },
        { path: "来自pax/", type: "dir", size: 0 },
        { path: "plain.txt", type: "file", size: 0 },
      ]);
      expect(listing.truncated).toBe(false);
    }
  });
});

describe("压缩包列表：声明超大的长文件名记录", () => {
  it("evil.tar：1 KiB 的文件声明 4 GiB 的 L 记录 → 不支持，头之外一个字节都不读", async () => {
    const bytes = Buffer.concat([
      tarHeader({ name: LONG_LINK, typeflag: "L", size: 4 * 1024 ** 3 }),
      Buffer.alloc(512, "a"),
    ]);
    expect(bytes).toHaveLength(1024);
    const file = await archiveOnDisk("evil.tar", bytes);
    await expect(listArchive("tar", "evil.tar", file.readAt, DEFAULTS)).rejects.toMatchObject(
      UNSUPPORTED,
    );
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    expect(file.positions).toEqual([0]);
  });

  it("evil2.tar：两个成员之后声明 1 GiB 的 pax 扩展头 → 恰两项并置 truncated（tar.gz 同样）", async () => {
    const bytes = Buffer.concat([
      tarFile("one.txt", "1"),
      tarFile("two.txt", "22"),
      tarHeader({ name: "PaxHeaders/z", typeflag: "x", size: 1024 ** 3 }),
      Buffer.from(paxRecord("path", "never-read.txt")),
    ]);
    for (const name of ["evil2.tar", "evil2.tgz"]) {
      const { file, listing } = await list(name, name === "evil2.tar" ? bytes : gzipSync(bytes));
      expect(listing.entries, name).toEqual([
        { path: "one.txt", type: "file", size: 1 },
        { path: "two.txt", type: "file", size: 2 },
      ]);
      expect(listing.truncated).toBe(true);
      expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    }
  });

  it.each([
    ["L 记录", (name: string) => tarFile(LONG_LINK, `${name}\u0000`, { typeflag: "L" })],
    [
      "pax path",
      (name: string) => tarFile("PaxHeaders/n", paxRecord("path", name), { typeflag: "x" }),
    ],
  ])(
    "long2.tar：%s 给出 5000 字节名字的成员不计入 → 恰一项并置 truncated；恰 4096 字节的计入",
    async (_kind, record) => {
      const long = await list(
        "long2.tar",
        Buffer.concat([
          tarFile("ok.txt", "x"),
          record("n".repeat(5000)),
          tarFile("short"),
          TAR_END,
        ]),
      );
      expect(long.listing.entries).toEqual([{ path: "ok.txt", type: "file", size: 1 }]);
      expect(long.listing.truncated).toBe(true);
      expect(long.file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);

      const fits = await list(
        "long2.tar",
        Buffer.concat([
          record("n".repeat(NAME_LIMIT)),
          tarFile("short"),
          record("n".repeat(NAME_LIMIT + 1)),
          tarFile("short"),
          TAR_END,
        ]),
      );
      expect(fits.listing.entries).toEqual([
        { path: "n".repeat(NAME_LIMIT), type: "file", size: 0 },
      ]);
      expect(fits.listing.truncated).toBe(true);
      for (const entry of [...long.listing.entries, ...fits.listing.entries]) {
        expect(Buffer.byteLength(entry.path)).toBeLessThanOrEqual(NAME_LIMIT);
      }
    },
  );

  it("long.zip：两个正常成员之后成员名 5000 字节的成员不计入 → 恰两项并置 truncated，其后的成员不列", async () => {
    const { file, listing } = await list(
      "long.zip",
      zipArchive([
        zipCentral({ name: "one.txt", size: 1 }),
        zipCentral({ name: "two.txt", size: 2 }),
        zipCentral({ name: "n".repeat(5000), size: 3 }),
        zipCentral({ name: "after.txt", size: 4 }),
      ]),
    );
    expect(listing).toEqual({
      format: "zip",
      entries: [
        { path: "one.txt", type: "file", size: 1 },
        { path: "two.txt", type: "file", size: 2 },
      ],
      truncated: true,
    });
    for (const entry of listing.entries) {
      expect(Buffer.byteLength(entry.path)).toBeLessThanOrEqual(NAME_LIMIT);
    }
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("slow.tar：未压缩的 tar 在时钟越过 5 秒后返回已读到的三项并置 truncated", async () => {
    const members = Array.from({ length: 5 }, (_, index) => tarFile(`m${index}`, "12345"));
    const file = await archiveOnDisk("slow.tar", Buffer.concat([...members, TAR_END]));
    let clock = 1_000_000;
    // The third member's header sits at 2048: reading it is what takes the clock past the limit.
    const readAt = (position: number, length: number) => {
      clock += position === 2048 ? 6000 : 0;
      return file.readAt(position, length);
    };
    const listing = await listArchive("tar", "slow.tar", readAt, {
      maxEntries: 1000,
      now: () => clock,
      size: 0,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(["m0", "m1", "m2"]);
    expect(listing.truncated).toBe(true);
    expect(file.positions).toEqual([0, 1024, 2048]);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("bomb.tgz：跳过 8 MiB 成员正文的途中时钟越过 5 秒 → 恰一项并置 truncated", async () => {
    const bytes = gzipSync(
      Buffer.concat([
        tarFile("zeros.bin", Buffer.alloc(8 * 1024 * 1024)),
        tarFile("after.txt", "x"),
        TAR_END,
      ]),
    );
    const { file, listing } = await list("bomb.tgz", bytes, {
      maxEntries: 1000,
      now: tickingClock(1000),
    });
    expect(listing.entries).toEqual([{ path: "zeros.bin", type: "file", size: 8_388_608 }]);
    expect(listing.truncated).toBe(true);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });
});

describe("压缩包列表：gzip 流之后的字节与没有正文的成员", () => {
  const JUNK_10 = Buffer.alloc(10, "j");
  const JUNK_300000 = Buffer.alloc(300_000, "j");

  it.each([
    ["tail.tgz：后跟 10 个非零字节", "tail.tgz", JUNK_10],
    ["tail2.tgz：后跟 300000 个非零字节", "tail2.tgz", JUNK_300000],
    ["后跟 10 个零字节", "zeros.tar.gz", Buffer.alloc(10)],
  ])(
    "%s → 恰三项、truncated:false，与不带尾部字节时相同；尾部一个字节都不多读",
    async (_label, name, tail) => {
      const bare = await list(name, gzipSync(THREE_MEMBERS));
      const { file, listing } = await list(name, Buffer.concat([gzipSync(THREE_MEMBERS), tail]));
      expect(listing).toEqual({ format: "tar.gz", entries: THREE_ENTRIES, truncated: false });
      expect(listing).toEqual(bare.listing);
      expect(file.positions).toEqual([0]);
      expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
    },
  );

  it("bigtail.tgz：3000 个成员后跟非零字节（上限放宽到 5000）→ 恰 3000 项、truncated:false", async () => {
    const whole = gzipSync(Buffer.concat([...emptyMembers(3000), TAR_END]));
    const { file, listing } = await list("bigtail.tgz", Buffer.concat([whole, JUNK_300000]), {
      maxEntries: 5000,
      now: () => 0,
    });
    expect(listing.entries.map((entry) => entry.path)).toEqual(
      Array.from({ length: 3000 }, (_, index) => `m${index}`),
    );
    expect(listing.truncated).toBe(false);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("单个 gz 后跟非零字节：仍恰一项，不读任何字节", async () => {
    const { file, listing } = await list(
      "notes.txt.gz",
      Buffer.concat([gzipSync("some notes"), JUNK_300000]),
    );
    expect(listing).toEqual({
      format: "gz",
      entries: [{ path: "notes.txt", type: "file", size: null }],
      truncated: false,
    });
    expect(file.positions).toEqual([]);
  });

  it("links.tar：头里大小 1024 的目录、大小 2048 的硬链接、after.txt 三个头彼此紧邻 → 恰三项，size 取头里的值（tar.gz 同样）", async () => {
    const bytes = Buffer.concat([
      tarHeader({ name: "sized-dir/", typeflag: "5", size: 1024 }),
      tarHeader({ name: "hard-link", typeflag: "1", size: 2048 }),
      tarFile("after.txt", "tail"),
      TAR_END,
    ]);
    expect(bytes).toHaveLength(3 * 512 + 512 + 1024);
    for (const name of ["links.tar", "links.tgz"]) {
      const { listing } = await list(name, name === "links.tar" ? bytes : gzipSync(bytes));
      expect(listing, name).toEqual({
        format: archiveFormat(name),
        entries: [
          { path: "sized-dir/", type: "dir", size: 1024 },
          { path: "hard-link", type: "file", size: 2048 },
          { path: "after.txt", type: "file", size: 4 },
        ],
        truncated: false,
      });
    }
  });
});

describe("压缩包列表：多成员 gzip", () => {
  // The first stream has no tar end blocks: `b.txt` and the end blocks are in the second one.
  const first = gzipSync(tarFile("a.txt", "hello"));
  const second = gzipSync(Buffer.concat([tarFile("b.txt", "world!"), TAR_END]));
  const A_ENTRY = { path: "a.txt", type: "file", size: 5 };
  const B_ENTRY = { path: "b.txt", type: "file", size: 6 };

  it.each([
    ["multi.tgz：两个流首尾相接", "multi.tgz", Buffer.alloc(0)],
    ["multi-tail.tgz：其后再跟 10 个非零字节", "multi-tail.tgz", Buffer.alloc(10, "j")],
  ])("%s → 恰 a.txt、b.txt 两项，truncated:false", async (_label, name, tail) => {
    const { file, listing } = await list(name, Buffer.concat([first, second, tail]));
    expect(listing).toEqual({ format: "tar.gz", entries: [A_ENTRY, B_ENTRY], truncated: false });
    expect(file.positions).toEqual([0]);
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("blocks.tgz：一个 tar 每 512 字节压成一个 gzip 流 → 恰三个成员，truncated:false", async () => {
    const streams = Array.from({ length: THREE_MEMBERS.length / 512 }, (_, index) =>
      gzipSync(THREE_MEMBERS.subarray(index * 512, (index + 1) * 512)),
    );
    expect(streams).toHaveLength(7);
    const { file, listing } = await list("blocks.tgz", Buffer.concat(streams));
    expect(listing).toEqual({ format: "tar.gz", entries: THREE_ENTRIES, truncated: false });
    expect(file.maxLength()).toBeLessThanOrEqual(EXTENSION_LIMIT);
  });

  it("multi-bad.tgz：第二个流的头魔数对、压缩方法不是 8 → 恰 a.txt 一项并置 truncated，与只有第一个流时相同", async () => {
    const bad = Buffer.from(second);
    expect(bad.readUInt16BE(0)).toBe(0x1f8b);
    bad.writeUInt8(9, 2);
    const bare = await list("multi-bad.tgz", first);
    const { file, listing } = await list("multi-bad.tgz", Buffer.concat([first, bad]));
    expect(listing).toEqual({ format: "tar.gz", entries: [A_ENTRY], truncated: true });
    expect(listing).toEqual(bare.listing);
    expect(file.positions).toEqual([0]);
  });
});

describe("压缩包列表：恶意成员名只是数据", () => {
  it("../、绝对路径、含 <script> 的名字原样出现在 path 里，列表过程不碰文件系统", async () => {
    const names = ["../../etc/passwd", "/abs/x", "<script>alert(1)</script>.txt", "a/./b//c/../d"];
    const bytes = Buffer.concat([...names.map((name) => tarFile(name, "x")), TAR_END]);
    const tar = await archiveOnDisk("names.tar", bytes);
    const tgz = await archiveOnDisk("names.tgz", gzipSync(bytes));
    // A zip name may carry a backslash too: it is neither turned into `/` nor refused.
    const zipNames = [...names, "..\\..\\win\\x.txt", "C:/drive/x"];
    const zip = await archiveOnDisk(
      "names.zip",
      zipArchive(zipNames.map((name) => zipCentral({ name, size: 1 }))),
    );
    const spies = spyBodyIo();
    const zipListing = await listArchive("zip", "names.zip", zip.readAt, {
      ...DEFAULTS,
      size: zip.size,
    });

    const listings = [
      await listArchive("tar", "names.tar", tar.readAt, DEFAULTS),
      await listArchive("tar.gz", "names.tgz", tgz.readAt, DEFAULTS),
    ];

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(zipListing.entries.map((entry) => entry.path)).toEqual(zipNames);
    expect(zipListing.truncated).toBe(false);
    for (const listing of listings) {
      expect(listing.entries.map((entry) => entry.path)).toEqual(names);
      expect(listing.truncated).toBe(false);
    }
  });
});

describe("压缩包列表：损坏", () => {
  it("fake.zip：内容不是 zip → 不支持", async () => {
    await expect(list("fake.zip", Buffer.from("this is not a zip at all\n"))).rejects.toMatchObject(
      UNSUPPORTED,
    );
    await expect(list("fake.zip", THREE_MEMBERS)).rejects.toMatchObject(UNSUPPORTED);
  });

  it("cut.tar：切在第二个头中间 → 一项；切在最后一个成员正文中间 → 含该成员；都置 truncated", async () => {
    const midHeader = await list("cut.tar", THREE_MEMBERS.subarray(0, 1024 + 100));
    expect(midHeader.listing).toEqual({
      format: "tar",
      entries: [{ path: "a.txt", type: "file", size: 5 }],
      truncated: true,
    });

    const midBody = Buffer.concat([
      tarFile("a.txt", "hello"),
      tarHeader({ name: "big.bin", size: 4096 }),
      Buffer.alloc(1000, "z"),
    ]);
    for (const name of ["cut.tar", "cut.tgz"]) {
      const { listing } = await list(name, name === "cut.tar" ? midBody : gzipSync(midBody));
      expect(listing.entries, name).toEqual([
        { path: "a.txt", type: "file", size: 5 },
        { path: "big.bin", type: "file", size: 4096 },
      ]);
      expect(listing.truncated).toBe(true);
    }
  });
});
