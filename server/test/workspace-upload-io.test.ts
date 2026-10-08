/**
 * workspaces/upload — the streamed-storage IO of the upload endpoint (s1g task 11.1, design D11
 * steps 7 and 8; spec workspaces「文件上传」). Real temporary directories, no HTTP: routing,
 * ownership, the sandbox and the audit are the route's (task 11.2).
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { storeUpload } from "../src/workspaces/upload.js";

const tmpDirs: string[] = [];
const CHUNK = 64 * 1024;
const NO_LIMIT = 1024 * 1024;
const ENDLESS_STALL = 32 * 1024 * 1024;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The directory the route hands over: resolved, so that paths compare equal on macOS. */
function uploadsDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "upload-io-")));
  tmpDirs.push(dir);
  return dir;
}

function bytes(...chunks: (string | Buffer)[]): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

function store(dir: string, name: string, content: string, maxBytes = NO_LIMIT) {
  return storeUpload({ dir, name, source: bytes(content), maxBytes });
}

function names(dir: string): string[] {
  return readdirSync(dir).sort();
}

function text(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

/**
 * Never ends: every `read` hands out one more chunk and counts it. Past `ENDLESS_STALL` it hands
 * out nothing more and still does not end, so that a reader that fails to stop hangs (and the
 * test times out) instead of filling the disk.
 */
function endless(): { source: Readable; pulled: () => number } {
  let pulled = 0;
  const chunk = Buffer.alloc(CHUNK, 0x61);
  const source = new Readable({
    highWaterMark: CHUNK,
    read() {
      if (pulled >= ENDLESS_STALL) {
        return;
      }
      pulled += chunk.length;
      this.push(chunk);
    },
  });
  return { source, pulled: () => pulled };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function expectHttpError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).code).toBe(code);
}

async function modeUnderUmask(umask: number): Promise<number> {
  const dir = uploadsDir();
  const previous = process.umask(umask);
  try {
    await store(dir, "a.txt", "abc");
  } finally {
    process.umask(previous);
  }
  return lstatSync(join(dir, "a.txt")).mode & 0o7777;
}

describe("workspaces/upload storeUpload: naming", () => {
  it("stores the bytes under the given name and leaves nothing else in the directory", async () => {
    const dir = uploadsDir();

    const stored = await storeUpload({
      dir,
      name: "报告.pdf",
      source: bytes("ab", "c"),
      maxBytes: NO_LIMIT,
    });

    expect(stored).toEqual({ name: "报告.pdf", size: 3 });
    expect(names(dir)).toEqual(["报告.pdf"]);
    expect(text(dir, "报告.pdf")).toBe("abc");
    expect(lstatSync(join(dir, "报告.pdf")).isFile()).toBe(true);
  });

  it.each([
    ["a.pdf", "a (1).pdf", "a (2).pdf"],
    ["README", "README (1)", "README (2)"],
    [".env", ".env (1)", ".env (2)"],
    ["archive.tar.gz", "archive.tar (1).gz", "archive.tar (2).gz"],
  ])("numbers a taken %s as %s, then %s, each with its own bytes", async (name, second, third) => {
    const dir = uploadsDir();

    const stored = [
      await store(dir, name, "first"),
      await store(dir, name, "second!"),
      await store(dir, name, "third!!!"),
    ];

    expect(stored).toEqual([
      { name, size: 5 },
      { name: second, size: 7 },
      { name: third, size: 8 },
    ]);
    expect(names(dir)).toEqual([name, second, third].sort());
    expect(text(dir, name)).toBe("first");
    expect(text(dir, second)).toBe("second!");
    expect(text(dir, third)).toBe("third!!!");
  });

  it("gives two concurrent uploads of one name the name and its (1), each complete", async () => {
    const dir = uploadsDir();
    const one = "1".repeat(3 * CHUNK + 1);
    const two = "2".repeat(5 * CHUNK + 7);

    const stored = await Promise.all([store(dir, "b.txt", one), store(dir, "b.txt", two)]);

    expect(stored.map((entry) => entry.name).sort()).toEqual(["b (1).txt", "b.txt"]);
    expect(names(dir)).toEqual(["b (1).txt", "b.txt"]);
    const [first, second] = stored;
    expect(first?.size).toBe(one.length);
    expect(second?.size).toBe(two.length);
    expect(text(dir, first?.name ?? "")).toBe(one);
    expect(text(dir, second?.name ?? "")).toBe(two);
  });

  it("does not follow a live symbolic link at the name: link and target stay, upload is (1)", async () => {
    const dir = uploadsDir();
    const outside = uploadsDir();
    const target = join(outside, "target.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "a.txt"));

    const stored = await store(dir, "a.txt", "new");

    expect(stored).toEqual({ name: "a (1).txt", size: 3 });
    expect(lstatSync(join(dir, "a.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "a.txt"))).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(names(outside)).toEqual(["target.txt"]);
    expect(names(dir)).toEqual(["a (1).txt", "a.txt"]);
    expect(text(dir, "a (1).txt")).toBe("new");
  });

  it("does not follow a dangling symbolic link at the name: nothing appears at its target", async () => {
    const dir = uploadsDir();
    const outside = uploadsDir();
    const target = join(outside, "missing.txt");
    symlinkSync(target, join(dir, "a.txt"));

    const stored = await store(dir, "a.txt", "new");

    expect(stored).toEqual({ name: "a (1).txt", size: 3 });
    expect(lstatSync(join(dir, "a.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "a.txt"))).toBe(target);
    expect(names(outside)).toEqual([]);
    expect(names(dir)).toEqual(["a (1).txt", "a.txt"]);
    expect(text(dir, "a (1).txt")).toBe("new");
  });

  it("takes the last free candidate, (999)", async () => {
    const dir = uploadsDir();
    writeFileSync(join(dir, "f.txt"), "");
    for (let n = 1; n <= 998; n += 1) {
      writeFileSync(join(dir, `f (${n}).txt`), "");
    }

    const stored = await store(dir, "f.txt", "last");

    expect(stored).toEqual({ name: "f (999).txt", size: 4 });
    expect(text(dir, "f (999).txt")).toBe("last");
    expect(names(dir)).toHaveLength(1000);
  });

  it("rejects with conflict when all 1000 candidates are taken, leaving no file behind", async () => {
    const dir = uploadsDir();
    writeFileSync(join(dir, "f.txt"), "");
    for (let n = 1; n <= 999; n += 1) {
      writeFileSync(join(dir, `f (${n}).txt`), "");
    }
    const before = names(dir);

    const error = await rejection(store(dir, "f.txt", "one too many"));

    expectHttpError(error, "conflict");
    expect(names(dir)).toEqual(before);
    expect(before).toHaveLength(1000);
    expect(before).not.toContain("f (1000).txt");
    expect(text(dir, "f (999).txt")).toBe("");
  });

  it.each([
    ["an empty name", ""],
    ["a nested name", "sub/a.txt"],
    ["a name that climbs out", "../a.txt"],
  ])("throws for %s before touching the disk or the source", async (_label, name) => {
    const parent = uploadsDir();
    const dir = join(parent, "uploads");
    mkdirSync(dir);
    mkdirSync(join(dir, "sub"));
    const source = bytes("abc");

    const error = await rejection(storeUpload({ dir, name, source, maxBytes: NO_LIMIT }));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect(names(dir)).toEqual(["sub"]);
    expect(names(join(dir, "sub"))).toEqual([]);
    expect(names(parent)).toEqual(["uploads"]);
    expect(source.readableDidRead).toBe(false);
  });
});

describe("workspaces/upload storeUpload: limit and cleanup", () => {
  it("stops reading a never-ending source once the limit is passed and removes the temporary file", async () => {
    const dir = uploadsDir();
    const maxBytes = 4 * CHUNK;
    const { source, pulled } = endless();

    const error = await rejection(storeUpload({ dir, name: "big.bin", source, maxBytes }));

    expectHttpError(error, "upload_too_large");
    expect(source.destroyed).toBe(true);
    expect(pulled()).toBeGreaterThan(maxBytes);
    expect(pulled()).toBeLessThanOrEqual(maxBytes + 2 * CHUNK);
    expect(names(dir)).toEqual([]);
  }, 3_000);

  it("rejects one byte over the limit, in the last of several chunks", async () => {
    const dir = uploadsDir();
    const source = bytes("abcd", "efgh", "i");

    const error = await rejection(storeUpload({ dir, name: "a.txt", source, maxBytes: 8 }));

    expectHttpError(error, "upload_too_large");
    expect(source.destroyed).toBe(true);
    expect(names(dir)).toEqual([]);
  });

  it("accepts a body of exactly the limit", async () => {
    const dir = uploadsDir();

    const stored = await storeUpload({
      dir,
      name: "a.txt",
      source: bytes("abcd", "efgh"),
      maxBytes: 8,
    });

    expect(stored).toEqual({ name: "a.txt", size: 8 });
    expect(names(dir)).toEqual(["a.txt"]);
    expect(text(dir, "a.txt")).toBe("abcdefgh");
  });

  it("accepts zero bytes", async () => {
    const dir = uploadsDir();

    const stored = await storeUpload({ dir, name: "empty", source: bytes(), maxBytes: 0 });

    expect(stored).toEqual({ name: "empty", size: 0 });
    expect(names(dir)).toEqual(["empty"]);
    expect(lstatSync(join(dir, "empty")).size).toBe(0);
  });

  it("removes the temporary file and passes the error on when the source fails midway", async () => {
    const dir = uploadsDir();
    const failure = new Error("client went away");
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw failure;
      })(),
    );

    const error = await rejection(storeUpload({ dir, name: "a.txt", source, maxBytes: NO_LIMIT }));

    expect(error).toBe(failure);
    expect(names(dir)).toEqual([]);
  });

  it("removes the temporary file and passes the error on when naming fails for another reason than a taken name", async () => {
    const dir = uploadsDir();
    // 255 bytes is what one path component may have: the name itself fits, its (1) does not.
    const name = `${"n".repeat(251)}.txt`;
    writeFileSync(join(dir, name), "first");

    const error = await rejection(store(dir, name, "second"));

    expect((error as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG");
    expect(names(dir)).toEqual([name]);
    expect(text(dir, name)).toBe("first");
  });
});

describe("workspaces/upload storeUpload: mode", () => {
  it("stores the file at exactly 0660 under umask 000", async () => {
    expect(await modeUnderUmask(0o000)).toBe(0o660);
  });

  it("stores the file at exactly 0660 under umask 077", async () => {
    expect(await modeUnderUmask(0o077)).toBe(0o660);
  });
});
