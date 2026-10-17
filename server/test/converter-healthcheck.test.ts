/**
 * Issue #1504：`converter/healthcheck.mjs`（office-preview「转换 sidecar 实现与镜像」场景
 * 「healthcheck 的两个方向」）。以子进程运行，`CONVERTER_SPOOL_DIR` 指向临时目录。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HEALTHCHECK = fileURLToPath(new URL("../../converter/healthcheck.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function spool(heartbeatAgeS?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-healthcheck-"));
  roots.push(dir);
  if (heartbeatAgeS !== undefined) {
    const heartbeat = join(dir, "heartbeat");
    writeFileSync(heartbeat, "");
    const at = Date.now() / 1000 - heartbeatAgeS;
    utimesSync(heartbeat, at, at);
  }
  return dir;
}

function exitCodeOn(dir: string): number | null {
  return spawnSync(process.execPath, [HEALTHCHECK], {
    env: { PATH: process.env.PATH, CONVERTER_SPOOL_DIR: dir },
    stdio: "ignore",
  }).status;
}

describe("healthcheck 的两个方向", () => {
  it("heartbeat 刚 touch 过 → 退出码 0", () => {
    expect(exitCodeOn(spool(0))).toBe(0);
  });

  it("heartbeat 的 mtime 是 30 s 前 → 退出码 1", () => {
    expect(exitCodeOn(spool(30))).toBe(1);
  });

  it("heartbeat 缺席 → 退出码 1", () => {
    expect(exitCodeOn(spool())).toBe(1);
  });
});
