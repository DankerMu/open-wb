/**
 * Byte builders for the archive listing tests: tar blocks and zip central directories are written
 * by hand here (no binary fixture is committed, no tar or zip library), and every archive is read
 * back through a real file handle whose `readAt` records the largest length it was asked for.
 */
import { writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach } from "vitest";
import { archiveFormat, listArchive } from "../src/workspaces/archive.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

const BLOCK = 512;
/** `ustar\0` + version `00` (POSIX); the GNU form is `ustar` + two spaces + NUL over the same 8 bytes. */
const POSIX_MAGIC = "ustar\u000000";
export const GNU_MAGIC = "ustar  \u0000";
/** The two zero blocks that end a tar. */
export const TAR_END = Buffer.alloc(2 * BLOCK);
/** What the recording `readAt` serves at most; a larger request is recorded, not allocated. */
const SERVED_AT_MOST = 1_048_576;

interface HeaderFields {
  name: string | Buffer;
  size?: number;
  /** One character: `0` file, `1` hard link, `2` symlink, `5` directory, `L` / `K` GNU, `x` / `g` pax. */
  typeflag?: string;
  prefix?: string | Buffer;
  magic?: string;
  /** Raw bytes for the 12-byte size field, for the shapes octal cannot express. */
  rawSize?: Buffer;
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\u0000`;
}

/** One 512-byte header with a valid checksum (unsigned sum, the checksum field counted as spaces). */
export function tarHeader(fields: HeaderFields): Buffer {
  const block = Buffer.alloc(BLOCK);
  Buffer.from(fields.name).copy(block, 0, 0, 100);
  block.write(octal(0o644, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(fields.size ?? 0, 11), 124, "latin1");
  fields.rawSize?.copy(block, 124, 0, 12);
  block.write(octal(0, 11), 136, "latin1");
  block.write(fields.typeflag ?? "0", 156, "latin1");
  block.write(fields.magic ?? POSIX_MAGIC, 257, "latin1");
  Buffer.from(fields.prefix ?? "").copy(block, 345, 0, 155);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${octal(sum, 6)} `, 148, "latin1");
  return block;
}

/** A header whose size is the body's, then the body padded to whole blocks. */
export function tarFile(
  name: string | Buffer,
  body: string | Buffer = "",
  fields: Omit<HeaderFields, "name" | "size"> = {},
): Buffer {
  const data = Buffer.from(body);
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([tarHeader({ ...fields, name, size: data.length }), data, padding]);
}

/** One pax record `LEN key=value\n`; LEN is the decimal byte length of the whole record, itself included. */
export function paxRecord(key: string, value: string): string {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + 1;
  while (String(length).length + rest !== length) {
    length += 1;
  }
  return `${length} ${key}=${value}\n`;
}

/** `length` bytes that do not compress: a fixed Lehmer sequence, the same on every run. */
export function noise(length: number): Buffer {
  let state = 12_345;
  return Buffer.from(
    Array.from({ length }, () => {
      state = (state * 48_271) % 2_147_483_647;
      return Math.floor(state / 256) % 256;
    }),
  );
}

/**
 * One gzip member written by hand (RFC 1952): the optional header fields asked for, raw deflate,
 * then the CRC-32 and the length of `data`. `extra` is the FEXTRA payload, at most 65535 bytes.
 */
export function gzipMember(
  data: Buffer,
  fields: { extra?: Buffer; name?: string; comment?: string; headerCrc?: boolean } = {},
): Buffer {
  const flags =
    (fields.headerCrc ? 2 : 0) +
    (fields.extra ? 4 : 0) +
    (fields.name === undefined ? 0 : 8) +
    (fields.comment === undefined ? 0 : 16);
  const parts: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3])];
  if (fields.extra) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(fields.extra.length);
    parts.push(length, fields.extra);
  }
  for (const text of [fields.name, fields.comment]) {
    if (text !== undefined) {
      parts.push(Buffer.from(`${text}\u0000`, "latin1"));
    }
  }
  if (fields.headerCrc) {
    const headerCrc = Buffer.alloc(2);
    headerCrc.writeUInt16LE(crc32(Buffer.concat(parts)) % 65_536);
    parts.push(headerCrc);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length % 4_294_967_296, 4);
  return Buffer.concat([...parts, deflateRawSync(data), trailer]);
}

/** A gzip member that holds nothing: the 10-byte header, an empty deflate stream, CRC-32 0 and length 0. */
export const EMPTY_MEMBER = gzipMember(Buffer.alloc(0));

interface ZipMember {
  name: string | Buffer;
  /** The uncompressed size; `compressedSize` is the same unless given. */
  size?: number;
  compressedSize?: number;
  /** 0 stored (the default), 8 deflate. */
  method?: number;
  /** General purpose bit flag: 0x800 says the name is UTF-8, 0x40 is strong encryption. */
  flags?: number;
  extra?: Buffer;
  comment?: Buffer;
  /** External file attributes; 0x10 is the MS-DOS directory bit. */
  attributes?: number;
}

/** One central directory record (APPNOTE 4.3.12): 46 fixed bytes, then name, extra field, comment. */
export function zipCentral(member: ZipMember): Buffer {
  const name = Buffer.from(member.name);
  const extra = member.extra ?? Buffer.alloc(0);
  const comment = member.comment ?? Buffer.alloc(0);
  const fixed = Buffer.alloc(46);
  fixed.writeUInt32LE(0x02014b50, 0);
  fixed.writeUInt16LE(20, 4);
  fixed.writeUInt16LE(20, 6);
  fixed.writeUInt16LE(member.flags ?? 0, 8);
  fixed.writeUInt16LE(member.method ?? 0, 10);
  fixed.writeUInt32LE(member.compressedSize ?? member.size ?? 0, 20);
  fixed.writeUInt32LE(member.size ?? 0, 24);
  fixed.writeUInt16LE(name.length, 28);
  fixed.writeUInt16LE(extra.length, 30);
  fixed.writeUInt16LE(comment.length, 32);
  fixed.writeUInt32LE(member.attributes ?? 0, 38);
  return Buffer.concat([fixed, name, extra, comment]);
}

/**
 * `prefix`, the central directory, then the 22-byte end record (APPNOTE 4.3.16) and `tail`. No
 * local file header and no member data is written: listing reads neither. The end record declares
 * `records.length` entries and the directory at `prefix.length` unless `count` / `offset` say otherwise.
 */
export function zipArchive(
  records: Buffer[],
  layout: { prefix?: Buffer; count?: number; offset?: number; tail?: Buffer } = {},
): Buffer {
  const prefix = layout.prefix ?? Buffer.alloc(0);
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(layout.count ?? records.length, 8);
  end.writeUInt16LE(layout.count ?? records.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(layout.offset ?? prefix.length, 16);
  return Buffer.concat([prefix, directory, end, layout.tail ?? Buffer.alloc(0)]);
}

/** The central directory of `a.txt` (5 bytes, deflated to 7), `dir/` and `dir/b.md` (7 bytes); no attribute marks `dir/`. */
export const ZIP_THREE_RECORDS = [
  zipCentral({ name: "a.txt", size: 5, compressedSize: 7, method: 8 }),
  zipCentral({ name: "dir/" }),
  zipCentral({ name: "dir/b.md", size: 7 }),
];

const handles: FileHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  removeTempDirs();
});

/**
 * Writes the archive into `dir` and opens it. `readAt` returns a short Buffer at the end of the
 * file; `maxLength()` is the largest `length` any call asked for and `positions` every `position`.
 * `size` is the byte length of the archive, what a zip listing has to be told.
 */
export async function archiveOnDisk(
  name: string,
  bytes: Buffer,
  dir: string = tempDir(),
): Promise<{
  dir: string;
  size: number;
  readAt: (position: number, length: number) => Promise<Buffer>;
  maxLength: () => number;
  positions: number[];
}> {
  writeFileSync(join(dir, name), bytes);
  const handle = await open(join(dir, name), "r");
  handles.push(handle);
  let maxLength = 0;
  const positions: number[] = [];
  return {
    dir,
    size: bytes.length,
    async readAt(position, length) {
      maxLength = Math.max(maxLength, length);
      positions.push(position);
      const buffer = Buffer.alloc(Math.min(length, SERVED_AT_MOST));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    },
    maxLength: () => maxLength,
    positions,
  };
}

export const DEFAULTS = { maxEntries: 1000, now: () => 0, size: 0 };
export const UNSUPPORTED = { name: "HttpError", code: "preview_unsupported" };
/** The name GNU tar gives the header of an `L` / `K` record. */
export const LONG_LINK = "././@LongLink";
/** `a.txt` (5 bytes), `dir/`, `dir/b.md` (7 bytes): the archive of the spec's first scenario. */
export const THREE_MEMBERS = Buffer.concat([
  tarFile("a.txt", "hello"),
  tarFile("dir/", "", { typeflag: "5" }),
  tarFile("dir/b.md", "# title"),
  TAR_END,
]);

/** `count` empty files named `m0`, `m1`, …: one 512-byte header each. */
export function emptyMembers(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) => tarFile(`m${index}`));
}

/** Writes the archive to disk and lists it in the format its name gives; `size` is always the real one. */
export async function list(
  name: string,
  bytes: Buffer,
  options: { maxEntries: number; now: () => number } = DEFAULTS,
) {
  const file = await archiveOnDisk(name, bytes);
  const format = archiveFormat(name);
  if (format === null) {
    throw new Error(`not an archive name: ${name}`);
  }
  const listing = await listArchive(format, name, file.readAt, {
    maxEntries: options.maxEntries,
    now: options.now,
    size: file.size,
  });
  return { file, listing };
}

/** A clock that moves `step` milliseconds forward every time it is read. */
export function tickingClock(step: number): () => number {
  let clock = 0;
  return () => {
    clock += step;
    return clock;
  };
}
