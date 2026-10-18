/**
 * Issue 1505：office-preview「转换 sidecar 的健康与 fail-closed」场景「预检的两个方向（单元）」与
 * `heartbeatFresh` 的判据。时间参数取规格的单元值（`pollMs 20`、`waitMs 400`）；心跳年龄以
 * `utimes` 伪造，属主不符以注入的比对 uid 伪造（不需要第二个系统用户）。期望值是规格的字面量。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heartbeatFresh, preflightOfficeSidecar } from "../src/preview/office-sidecar-health.js";

const UNIT = { waitMs: 400, pollMs: 20, freshMs: 10_000 };
const roots: string[] = [];
const timers: NodeJS.Timeout[] = [];

afterEach(() => {
  timers.splice(0).forEach(clearTimeout);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 合格的 spool 根（`0700`、属本进程）放在一个临时目录里；返回 spool 路径。 */
function spoolRoot(mode = 0o700): string {
  const root = mkdtempSync(join(tmpdir(), "office-health-"));
  roots.push(root);
  const spool = join(root, "spool");
  mkdirSync(spool);
  chmodSync(spool, mode);
  return spool;
}

function beat(spool: string, ageS = 0): void {
  const path = join(spool, "heartbeat");
  writeFileSync(path, "");
  const at = Date.now() / 1000 - ageS;
  utimesSync(path, at, at);
}

function beatAfter(spool: string, ms: number): void {
  timers.push(setTimeout(() => beat(spool), ms));
}

/** 落定的值与用时（与实现同用 `Date.now`，下界因此不受两个时钟的取整差影响）；reject 会让 `await` 抛出。 */
async function timed(spool: string, uid?: number): Promise<{ ok: boolean; ms: number }> {
  const startedAt = Date.now();
  const ok = await preflightOfficeSidecar({
    spoolDir: spool,
    ...UNIT,
    ...(uid === undefined ? {} : { uid }),
  });
  return { ok, ms: Date.now() - startedAt };
}

/** spool 根之下的全部条目与根自己的 mode：「不建目录、不 chmod」的判据。 */
function layoutOf(spool: string): { mode: number | undefined; entries: string[] } {
  return {
    mode: existsSync(spool) ? lstatSync(spool).mode & 0o7777 : undefined,
    entries: existsSync(spool) ? readdirSync(spool).sort() : [],
  };
}

describe("转换 sidecar 的健康与 fail-closed：预检的两个方向（单元）", () => {
  const OTHER_UID = (process.geteuid?.() ?? 0) + 1;
  const cases: Array<[string, () => string, boolean, number?]> = [
    ["spool 根缺席", () => join(spoolRoot(), "absent"), false],
    ["spool 根是 0770（heartbeat 新鲜）", () => tapped(spoolRoot(0o770), 0), false],
    ["spool 根是 0707（heartbeat 新鲜）", () => tapped(spoolRoot(0o707), 0), false],
    ["heartbeat 的 mtime 为 30 s 前", () => tapped(spoolRoot(), 30), false],
    ["heartbeat 在 100 ms 后才写出", () => delayed(spoolRoot(), 100), true],
    ["heartbeat 在 600 ms 后才写出", () => delayed(spoolRoot(), 600), false],
    ["heartbeat 新鲜但比对 uid 与属主不同", () => tapped(spoolRoot(), 0), false, OTHER_UID],
  ];

  function tapped(spool: string, ageS: number): string {
    beat(spool, ageS);
    return spool;
  }

  function delayed(spool: string, ms: number): string {
    beatAfter(spool, ms);
    return spool;
  }

  it.each(cases)("%s", async (_case, arrange, expected, uid) => {
    const spool = arrange();
    const before = layoutOf(spool);

    const { ok } = await timed(spool, uid);

    expect(ok).toBe(expected);
    const after = layoutOf(spool);
    // 「100 ms 后写出」那一例多出来的 heartbeat 是测试写的；预检自己不建、不改任何东西。
    expect(after.mode).toBe(before.mode);
    expect(after.entries.filter((name) => name !== "heartbeat")).toEqual(
      before.entries.filter((name) => name !== "heartbeat"),
    );
  });

  it("600 ms 后才写出的一例落定不早于 400 ms、不晚于 800 ms；缺席的根不被建出", async () => {
    const late = spoolRoot();
    beatAfter(late, 600);
    const { ok, ms } = await timed(late);
    expect(ok).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(ms).toBeLessThanOrEqual(800);

    const absent = join(spoolRoot(), "absent");
    expect((await timed(absent)).ok).toBe(false);
    expect(existsSync(absent)).toBe(false);
  });

  it("根不是目录（一个普通文件）、heartbeat 是目录：都落为 false，永不 reject", async () => {
    const root = mkdtempSync(join(tmpdir(), "office-health-"));
    roots.push(root);
    writeFileSync(join(root, "file"), "");
    expect((await timed(join(root, "file"))).ok).toBe(false);
    const spool = spoolRoot();
    mkdirSync(join(spool, "heartbeat"));
    expect((await timed(spool)).ok).toBe(false);
  });
});

describe("heartbeatFresh：新鲜 = now − mtime < freshMs", () => {
  it("恰在界内为 true、到界上为 false；缺席为 false", () => {
    const spool = spoolRoot();
    expect(heartbeatFresh(spool, { freshMs: 10_000 })).toBe(false);
    beat(spool);
    const mtime = lstatSync(join(spool, "heartbeat")).mtimeMs;
    expect(heartbeatFresh(spool, { freshMs: 10_000, now: mtime + 9_999 })).toBe(true);
    expect(heartbeatFresh(spool, { freshMs: 10_000, now: mtime + 10_000 })).toBe(false);
    expect(heartbeatFresh(spool, { freshMs: 10_000 })).toBe(true);
  });
});
