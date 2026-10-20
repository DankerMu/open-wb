/**
 * Issue #1569 (omp-pin-18-12 design D8) turn-artifacts「浏览器截图」 at the ScreenshotDiff seam: pure
 * IO on a real temporary directory, `screenshotFs` injected only to count reads and closes and to
 * raise errors a non-root test cannot provoke. Expected candidates are literals from the spec text.
 */
import { execFileSync } from "node:child_process";
import {
  type Dir,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import { ScreenshotDiff, screenshotFs } from "../src/sessions/screenshot-diff.js";

const realOpendir = screenshotFs.opendirSync;
const MESSAGE = 7;
const cleanups: Array<() => void> = [];
let root = "";
let shots = "";
let opened = 0;
let closed = 0;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-1569-root-")));
  shots = join(root, "screenshots");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  opened = 0;
  closed = 0;
  vi.spyOn(screenshotFs, "opendirSync").mockImplementation((path, options) => {
    const dir: Dir = realOpendir(path, options);
    opened += 1;
    const close = dir.closeSync.bind(dir);
    dir.closeSync = () => {
      closed += 1;
      close();
    };
    return dir;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function write(...names: string[]): void {
  mkdirSync(shots, { recursive: true });
  for (const name of names) writeFileSync(join(shots, name), "png");
}

function fill(count: number, prefix = "f-"): void {
  write(...Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}.png`));
}

function shot(...names: string[]) {
  return names.map((name) => ({
    path: `screenshots/${name}`,
    added: null,
    removed: null,
    kind: "write",
  }));
}

function diffOf(workspaceRoot: string | null = root, names: Record<string, string> = {}) {
  return new ScreenshotDiff(workspaceRoot, { toolNames: new Map(Object.entries(names)) });
}

function calls(): number {
  return vi.mocked(screenshotFs.opendirSync).mock.calls.length;
}

describe("baseline at turn start", () => {
  it("ENOENT: an empty baseline, comparison stays on", () => {
    const diff = diffOf();
    diff.turnStart();
    write("screenshot-9.png");
    expect(diff.evalEnd()).toEqual(shot("screenshot-9.png"));
  });

  it("ENOTDIR (screenshots is a regular file): an empty baseline, comparison stays on", () => {
    writeFileSync(shots, "not a dir");
    const diff = diffOf();
    diff.turnStart();
    rmSync(shots);
    write("screenshot-7.png");
    expect(diff.evalEnd()).toEqual(shot("screenshot-7.png"));
  });

  it("any other error (EACCES): no comparison this turn, evalEnd never reads", () => {
    write("old.png");
    vi.mocked(screenshotFs.opendirSync).mockImplementationOnce(() => {
      throw errno("EACCES");
    });
    const diff = diffOf();
    diff.turnStart();
    write("new.png");
    expect(diff.evalEnd()).toEqual([]);
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("4097 entries: no comparison this turn; a 4096-entry read and baseline are within the cap", () => {
    fill(4097);
    const over = diffOf();
    over.turnStart();
    rmSync(join(shots, "f-0000.png"));
    rmSync(join(shots, "f-0001.png"));
    write("new.png");
    expect(over.evalEnd()).toEqual([]);
    expect(calls()).toBe(1);
    expect(opened).toBe(closed);

    rmSync(join(shots, "f-0002.png"));
    const atCap = diffOf();
    atCap.turnStart();
    write("new-2.png"); // a step-end read of 4096 entries, merged to exactly 4096 names
    expect(atCap.evalEnd()).toEqual(shot("new-2.png"));
  });

  it("a later turn start reads afresh: a disabled turn does not disable the next", () => {
    vi.mocked(screenshotFs.opendirSync).mockImplementationOnce(() => {
      throw errno("EIO");
    });
    const diff = diffOf();
    diff.turnStart();
    write("a.png");
    expect(diff.evalEnd()).toEqual([]);
    diff.turnStart();
    write("b.png");
    expect(diff.evalEnd()).toEqual(shot("b.png"));
  });
});

describe("comparison at an eval step end", () => {
  it("a failing read: no candidates and the baseline unchanged", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    write("screenshot-1.png");
    vi.mocked(screenshotFs.opendirSync).mockImplementationOnce(() => {
      throw errno("EACCES");
    });
    expect(diff.evalEnd()).toEqual([]);
    expect(diff.evalEnd()).toEqual(shot("screenshot-1.png"));
  });

  it("a read failing mid-listing: no candidates, the handle closed, the baseline unchanged", () => {
    const diff = diffOf();
    diff.turnStart();
    write("screenshot-1.png");
    vi.mocked(screenshotFs.opendirSync).mockImplementationOnce((path, options) => {
      const dir = realOpendir(path, options);
      opened += 1;
      const close = dir.closeSync.bind(dir);
      dir.closeSync = () => {
        closed += 1;
        close();
      };
      dir.readSync = () => {
        throw errno("EIO");
      };
      return dir;
    });
    expect(diff.evalEnd()).toEqual([]);
    // The baseline read hit ENOENT and opened nothing; the failing listing still closed its handle.
    expect([opened, closed]).toEqual([1, 1]);
    expect(diff.evalEnd()).toEqual(shot("screenshot-1.png"));
  });

  it("over 4096 entries: no candidates and the baseline unchanged", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    fill(4096);
    expect(diff.evalEnd()).toEqual([]);
    for (let i = 1; i < 4096; i += 1) rmSync(join(shots, `f-${String(i).padStart(4, "0")}.png`));
    expect(diff.evalEnd()).toEqual(shot("f-0000.png"));
  });

  it("new names merge into the baseline: a file is reported once per turn", () => {
    const diff = diffOf();
    diff.turnStart();
    write("a.png");
    expect(diff.evalEnd()).toEqual(shot("a.png"));
    write("b.png");
    expect(diff.evalEnd()).toEqual(shot("b.png"));
    expect(diff.evalEnd()).toEqual([]);
  });

  it("candidates are in code-point order of the name, not locale order", () => {
    const diff = diffOf();
    diff.turnStart();
    // Case-distinct names only: the default macOS volume is case-insensitive (b.png ≡ B.png).
    write("c.png", "ä.png", "a.png", "B.png");
    expect(diff.evalEnd()).toEqual(shot("B.png", "a.png", "c.png", "ä.png"));
  });

  it("candidates are in code-point order, not UTF-16 code-unit order", () => {
    const diff = diffOf();
    diff.turnStart();
    // U+FF10 < U+1F600 by code point, but the emoji's lead surrogate 0xD83D < 0xFF10 by code unit.
    write("\u{1F600}.png", "\uFF10.png");
    expect(diff.evalEnd()).toEqual(shot("\uFF10.png", "\u{1F600}.png"));
  });

  it("the directory gone at step end (removed, or now a file): no candidates, baseline unchanged", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    rmSync(shots, { recursive: true });
    expect(diff.evalEnd()).toEqual([]);
    writeFileSync(shots, "not a dir");
    expect(diff.evalEnd()).toEqual([]);
    rmSync(shots);
    write("old.png", "new.png");
    expect(diff.evalEnd()).toEqual(shot("new.png"));
  });

  it("a baseline merged past 4096 names: that step reports nothing, the turn stops comparing", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    for (let i = 0; i < 4095; i += 1) mkdirSync(join(shots, `d-${i}`));
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(2);
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(3); // 4096 names: still comparing
    // Rotate one name: each read stays at 4096 entries, the baseline would reach 4097.
    rmSync(join(shots, "d-0"), { recursive: true });
    write("rotated.png");
    expect(diff.evalEnd()).toEqual([]);
    const reads = calls();
    rmSync(join(shots, "d-1"), { recursive: true });
    write("later.png");
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(reads);
    rmSync(join(shots, "d-2"), { recursive: true });
    diff.turnStart();
    write("next-turn.png");
    expect(diff.evalEnd()).toEqual(shot("next-turn.png"));
  });

  it("a baseline of exactly 4096 names keeps comparing", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    for (let i = 0; i < 4094; i += 1) mkdirSync(join(shots, `d-${i}`));
    write("a.png");
    expect(diff.evalEnd()).toEqual(shot("a.png"));
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(3);
  });

  it("a subdirectory, symlinks and a FIFO are merged into the baseline but never candidates", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-1569-outside-")));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.png"), "x");
    writeFileSync(join(root, "inside.png"), "x");
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    mkdirSync(join(shots, "d"));
    writeFileSync(join(shots, "d", "x.png"), "x");
    symlinkSync(join(outside, "secret.png"), join(shots, "l.png"));
    symlinkSync(join(root, "inside.png"), join(shots, "in.png"));
    execFileSync("mkfifo", [join(shots, "pipe.png")]);
    write("screenshot-1.png");
    expect(diff.evalEnd()).toEqual(shot("screenshot-1.png"));
    rmSync(join(shots, "d"), { recursive: true });
    write("d");
    expect(diff.evalEnd()).toEqual([]);
  });

  it("every directory handle opened is closed", () => {
    write("old.png");
    const diff = diffOf();
    diff.turnStart();
    write("a.png");
    diff.evalEnd();
    fill(4097);
    diff.evalEnd();
    expect(opened).toBe(3);
    expect(closed).toBe(3);
  });
});

describe("annotate (the pump's events)", () => {
  const turnStart: ChatEvent<string> = { type: "turn.start", data: { messageId: MESSAGE } };
  const text: ChatEvent<string> = { type: "text.delta", data: { messageId: MESSAGE, delta: "x" } };
  function stepEnd(call: string): ChatEvent<string> {
    return {
      type: "step.end",
      data: { messageId: MESSAGE, stepId: call, status: "done", output: `${call} ok` },
    };
  }

  it("inserts files.changed right before an eval step.end; bash never reads or inserts", () => {
    const diff = diffOf(root, { e1: "eval", c2: "bash", e3: "eval" });
    expect(diff.annotate([turnStart])).toEqual([turnStart]);
    expect(calls()).toBe(1);
    write("screenshot-3.png");
    expect(diff.annotate([stepEnd("c2")])).toEqual([stepEnd("c2")]);
    expect(diff.annotate([stepEnd("unknown")])).toEqual([stepEnd("unknown")]);
    expect(calls()).toBe(1);
    expect(diff.annotate([text, stepEnd("e1"), text])).toEqual([
      text,
      {
        type: "files.changed",
        data: { messageId: MESSAGE, stepId: "e1", files: shot("screenshot-3.png") },
      },
      stepEnd("e1"),
      text,
    ]);
    expect(calls()).toBe(2);
    expect(diff.annotate([stepEnd("e3")])).toEqual([stepEnd("e3")]);
    expect(calls()).toBe(3);
  });

  it("a null root (an unbound session) never touches the filesystem", () => {
    write("old.png");
    const diff = diffOf(null, { e1: "eval" });
    const batch = [turnStart, stepEnd("e1")];
    write("new.png");
    expect(diff.annotate(batch)).toEqual(batch);
    diff.turnStart();
    expect(diff.evalEnd()).toEqual([]);
    expect(calls()).toBe(0);
  });
});
