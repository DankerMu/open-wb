/**
 * Issue #1527 (omp-browser-integration task 2.4): omp-runtime「宿主 overlay」, scenario「未配置浏览器时
 * 浏览器调用失败且不下载（真实 omp）」, against the official omp v18.0.10 binary in the world of
 * support/omp-official.ts. The host overlay is the product file of a deployment without
 * `BROWSER_BIN` (browser block `enabled: false`); the workspace holds a project layer that turns
 * the browser on, which the overlay must beat. The fake upstream's `WORKBUDDY_BROWSER_OPEN:<url>`
 * (omp-test-harness「受控上游浏览器标记」) makes the tool round a `write` to `xd://browser`.
 *
 * Oracles: the frames of the turn (exactly one tool call, failed; the turn ends with `agent_end`),
 * the workspace on disk (no `xd:` entry: the write did not fall through to a plain file), the omp
 * download cache (`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` absent) and omp's file log (no
 * `Downloading Chromium for puppeteer`). Before this change the overlay had no browser block, so
 * the project layer's `enabled: true` won and omp on macOS started downloading Chrome-for-Testing.
 *
 * Issue #1529 (task 3.2): omp-runtime「子进程 spawn 契约」, scenario「工作目录 .env 不能打开浏览器中继
 *（真实 omp）」. A deployment with `BROWSER_BIN` (overlay `enabled: true`, the runtime's `browserBin`
 * through the product wiring) whose workspace `.env` turns relay and cmux on and whose project layer
 * points the relay at TEST-NET-1. `BROWSER_BIN` is a wrapper that appends to a marker file it names
 * itself and exits 1: the marker exists only if omp took the local launch path (relay and cmux both
 * off). The committed negative contrast drops the two spawn-env pins with a test-only spawn wrapper:
 * then the relay wins, no marker, and the tool times out (`Browser open timed out after`; the
 * relay waits 35 s, the tool's default timeout is 30 s) instead of reporting the broker unavailable.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-browser.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped; the CI uid-isolation job runs it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  type OfficialDirs,
  OMP_TEST_OFF,
  OMP_VERSION,
  onTeardown,
  openOfficialWorld,
} from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

// A turn takes seconds; the bound stays short so the pre-change red (a download) ends quickly.
const TURN = { timeout: 60_000 };

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: no browser configured`, () => {
  it(
    "a project layer's browser.enabled loses to the overlay: the browser call fails, nothing is downloaded",
    TURN,
    async () => {
      const world = await openOfficialWorld(
        ({ workspaceRoot }) => {
          mkdirSync(join(workspaceRoot, ".omp"));
          writeFileSync(join(workspaceRoot, ".omp", "config.yml"), "browser:\n  enabled: true\n");
        },
        { spawnArgs: { approvalMode: "yolo" } },
      );

      const frames = await collectPrompt(
        world.runtime.prompt("打开页面 WORKBUDDY_BROWSER_OPEN:about:blank"),
      );

      const starts = frames.filter((frame) => frame.type === "tool_execution_start");
      const ends = frames.filter((frame) => frame.type === "tool_execution_end");
      expect(starts).toHaveLength(1);
      expect(ends.map((frame) => frame.isError)).toEqual([true]);
      expect(resultText(ends[0])).toContain("No such tool: xd://browser");
      expect(frames.at(-1)?.type).toBe("agent_end");
      expect(world.approvals).toEqual([]);

      expect(readdirSync(world.workspaceRoot).toSorted()).toEqual([".omp"]);
      const state = world.stateDir;
      expect(existsSync(join(state, "xdg", "cache", "omp", "puppeteer", "chrome"))).toBe(false);
      const logs = join(state, "xdg", "state", "omp", "logs");
      const logFiles = readdirSync(logs).filter((name) => name.endsWith(".log"));
      expect(logFiles.length).toBeGreaterThan(0);
      for (const name of logFiles) {
        expect(readFileSync(join(logs, name), "utf8")).not.toContain(
          "Downloading Chromium for puppeteer",
        );
      }
    },
  );
});

// The negative contrast waits out the tool's 30 s default timeout; the bound is deliberate.
const RELAY_TURN = { timeout: 90_000 };

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: workspace .env and the relay`, () => {
  it(
    "the spawn-env pins beat a workspace .env: omp launches BROWSER_BIN, not the relay",
    RELAY_TURN,
    async () => {
      const browser = fakeBrowser();
      const world = await openOfficialWorld(plantRelay(browser), {
        spawnArgs: { approvalMode: "yolo" },
        browserEnabled: true,
        browserBin: browser.bin,
      });

      const frames = await collectPrompt(
        world.runtime.prompt("打开页面 WORKBUDDY_BROWSER_OPEN:about:blank"),
      );

      expect(frames.filter((frame) => frame.type === "tool_execution_start")).toHaveLength(1);
      expect(frames.at(-1)?.type).toBe("agent_end");
      expect(existsSync(browser.marker)).toBe(true);
    },
  );

  it(
    "negative contrast: without the two pins the .env turns the relay on and the open times out",
    RELAY_TURN,
    async () => {
      const browser = fakeBrowser();
      const world = await openOfficialWorld(plantRelay(browser), {
        spawnArgs: { approvalMode: "yolo" },
        browserPins: false,
        browserEnabled: true,
        browserBin: browser.bin,
      });

      const frames = await collectPrompt(
        world.runtime.prompt("打开页面 WORKBUDDY_BROWSER_OPEN:about:blank"),
      );

      const ends = frames.filter((frame) => frame.type === "tool_execution_end");
      expect(ends.map((frame) => frame.isError)).toEqual([true]);
      expect(resultText(ends[0])).toContain("Browser open timed out after");
      expect(resultText(ends[0])).not.toContain("Shared browser daemon unavailable");
      expect(frames.at(-1)?.type).toBe("agent_end");
      expect(existsSync(browser.marker)).toBe(false);
    },
  );
});

interface FakeBrowser {
  dir: string;
  bin: string;
  marker: string;
}

/** A `BROWSER_BIN` that appends a line to a marker it names itself, then exits 1 (omp may retry). */
function fakeBrowser(): FakeBrowser {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omp-browser-bin-")));
  onTeardown(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "launched");
  const bin = join(dir, "chromium");
  writeFileSync(bin, `#!/bin/sh\necho launched >> ${JSON.stringify(marker)}\nexit 1\n`, {
    mode: 0o755,
  });
  return { dir, bin, marker };
}

/** The workspace `.env` turning relay and cmux on, and a project layer pointing the relay at TEST-NET-1. */
function plantRelay(browser: FakeBrowser): (dirs: OfficialDirs) => void {
  return ({ workspaceRoot }) => {
    writeFileSync(
      join(workspaceRoot, ".env"),
      `PI_BROWSER_RELAY=1\nPI_BROWSER_CMUX=1\nCMUX_SOCKET_PATH=${join(browser.dir, "cmux.sock")}\n`,
    );
    mkdirSync(join(workspaceRoot, ".omp"));
    writeFileSync(
      join(workspaceRoot, ".omp", "config.yml"),
      'browser:\n  relay: true\n  relayUrl: "http://192.0.2.1:9"\n',
    );
  };
}

function resultText(frame: OmpFrame | undefined): string {
  const result = frame?.result as { content?: Array<{ text?: string }> } | undefined;
  return (result?.content ?? []).map((part) => part.text ?? "").join("");
}
