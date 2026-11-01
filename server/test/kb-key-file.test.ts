/**
 * s2a-kb-ragflow tasks 4.3（#1839）：`kb_key` 阶段的读取与校验，单元层（ragflow-backend「知识库配置与密钥文件」，
 * design D3）。全部用真实文件；唯一的缝是 `getuid`：非特权进程造不出别的属主（规格「属主不符」，同 `sandbox_root`
 * 先例）。入口层的失败记录与「从同一个 fd 读」在 `server-startup-kb.test.ts`。
 *
 * 期望的错误文本是规格「只点名键」的字面量，固定一句：路径、内容、errno 都不在里面。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { readKbKeyFile } from "../src/kb/key-file.js";
import { prepareKbKey } from "../src/startup-registry.js";

const KEY = "ragflow-key-sentinel-1839";
const PATH_SENTINEL = "PATHSENTINEL1839zq";
const INVALID = "RAGFLOW_API_KEY_FILE must be a private regular file holding one API key";
const INVALID_VALUE = "RAGFLOW_API_KEY_FILE must be a valid HTTP header value";

const root = mkdtempSync(join(tmpdir(), `open-wb-kb-key-${PATH_SENTINEL}-`));
let seq = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function nextPath(): string {
  seq += 1;
  return join(root, `key-${seq}`);
}

/** `mode` 经 chmod 落下，不受 umask 影响。 */
function keyFile(content: string | Buffer, mode = 0o600): string {
  const path = nextPath();
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function messageOf(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the key file to be refused");
}

describe("a compliant key file", () => {
  it("0600 regular file: the handle reads back the content", () => {
    expect(readKbKeyFile(keyFile(KEY)).read()).toBe(KEY);
  });

  it("0400 passes too: the rule is `mode & 0o077`, not exactly 0600", () => {
    expect(readKbKeyFile(keyFile(KEY, 0o400)).read()).toBe(KEY);
  });

  it("exactly one trailing LF is dropped", () => {
    expect(readKbKeyFile(keyFile(`${KEY}\n`)).read()).toBe(KEY);
  });

  it("4096 bytes is the largest size", () => {
    const content = "k".repeat(4096);
    expect(readKbKeyFile(keyFile(content)).read()).toBe(content);
  });

  it("the owner equal to the injected uid passes", () => {
    const path = keyFile(KEY);
    expect(readKbKeyFile(path, { getuid: () => process.getuid?.() }).read()).toBe(KEY);
  });
});

describe("the read-only handle", () => {
  it("cannot be reassigned, and neither JSON nor inspect shows the key", () => {
    const handle = readKbKeyFile(keyFile(KEY));
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).not.toContain(KEY);
    expect(inspect(handle, { depth: 10, showHidden: true })).not.toContain(KEY);
  });
});

describe("a key file that fails the file rules", () => {
  it.each([
    ["0644", 0o644],
    ["0640", 0o640],
    ["0604", 0o604],
    ["0620", 0o620],
    ["0610", 0o610],
    ["0602", 0o602],
    ["0601", 0o601],
  ])("mode %s", (_label, mode) => {
    const path = keyFile(KEY, mode);
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("a symlink to a compliant file", () => {
    const link = nextPath();
    symlinkSync(keyFile(KEY), link);
    expect(messageOf(() => readKbKeyFile(link))).toBe(INVALID);
  });

  it("a directory", () => {
    const dir = nextPath();
    mkdirSync(dir, { mode: 0o700 });
    expect(messageOf(() => readKbKeyFile(dir))).toBe(INVALID);
  });

  it("a FIFO, without waiting for a writer", () => {
    const fifo = nextPath();
    expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
    expect(messageOf(() => readKbKeyFile(fifo))).toBe(INVALID);
  });

  it("a path where nothing is", () => {
    expect(messageOf(() => readKbKeyFile(nextPath()))).toBe(INVALID);
  });

  it("a path through a regular file", () => {
    const path = join(keyFile(KEY), "key");
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("an empty file", () => {
    const path = keyFile("");
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("4097 bytes", () => {
    const path = keyFile("k".repeat(4097));
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("4096 bytes of key and a trailing LF: the size rule is on the file, not the key", () => {
    const path = keyFile(`${"k".repeat(4096)}\n`);
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("only a LF: nothing is left once it is dropped", () => {
    const path = keyFile("\n");
    expect(messageOf(() => readKbKeyFile(path))).toBe(INVALID);
  });

  it("属主不符: an owner other than this process's uid", () => {
    const path = keyFile(KEY);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(messageOf(() => readKbKeyFile(path, { getuid: () => other }))).toBe(INVALID);
  });

  it("no uid to compare with fails closed", () => {
    const path = keyFile(KEY);
    expect(messageOf(() => readKbKeyFile(path, { getuid: () => undefined }))).toBe(INVALID);
  });
});

describe("content that is not a valid HTTP header value", () => {
  it.each([
    ["exactly \\n\\n: one LF is left after dropping one", "\n\n"],
    ["a key and two LFs", `${KEY}\n\n`],
    ["a CR inside", `${KEY}\rrest`],
    ["CRLF at the end", `${KEY}\r\n`],
    ["a LF inside", `${KEY}\nrest`],
    ["a NUL", `${KEY}\0rest`],
    ["above U+00FF", `密钥${KEY}`],
    ["bytes that are not UTF-8", Buffer.from([0x6b, 0xff, 0x6b])],
  ])("%s", (_label, content) => {
    const path = keyFile(content);
    const message = messageOf(() => readKbKeyFile(path));
    expect(message).toBe(INVALID_VALUE);
    expect(message).not.toContain(KEY);
  });
});

describe("the error carries nothing but the key's name", () => {
  it("no path in the message, and no native error attached", () => {
    let thrown: unknown;
    try {
      readKbKeyFile(nextPath());
    } catch (error) {
      thrown = error;
    }
    expect(inspect(thrown, { depth: 10 })).not.toContain(PATH_SENTINEL);
  });
});

describe("the descriptor", () => {
  it("is closed on success and on a refused file", () => {
    const good = keyFile(KEY);
    const bad = keyFile(KEY, 0o644);
    const lowest = openSync(good, "r");
    closeSync(lowest);
    readKbKeyFile(good);
    messageOf(() => readKbKeyFile(bad));
    const next = openSync(good, "r");
    closeSync(next);
    expect(next).toBe(lowest);
  });
});

describe("prepareKbKey (the kb_key stage)", () => {
  it("no key file configured: reads nothing and has no handle", () => {
    expect(prepareKbKey({})).toBeUndefined();
  });

  it("a configured key file gives the handle", () => {
    expect(prepareKbKey({ ragflowApiKeyFile: keyFile(KEY) })?.read()).toBe(KEY);
  });

  it("a refused key file throws out of the stage", () => {
    const path = keyFile(KEY, 0o644);
    expect(messageOf(() => prepareKbKey({ ragflowApiKeyFile: path }))).toBe(INVALID);
  });
});
