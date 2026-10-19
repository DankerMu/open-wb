/**
 * Issue #1527: the host overlay as the real compiled production entry writes it — omp-runtime
 * 「宿主 overlay」, scenarios「overlay 写入」and「overlay 不随档位变化」with the new bytes (fixed block
 * then the browser block; this group never configures a browser, so `enabled: false`), and the
 * `MODEL_CATALOG` example of「看图块随白名单」(the first `vision:true` whitelist model is the vision
 * role). The expected bytes are the spec's, kept in `omp-layout-helpers.ts`. #1529 (the owning
 * group of「浏览器块随 BROWSER_BIN」): cold starts without and with `BROWSER_BIN` differ in exactly
 * the `enabled` line.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectHostOverlay,
  HOST_OVERLAY_FIXED,
  HOST_OVERLAY_YAML,
  hostOverlayBrowserBlock,
} from "./omp-layout-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  expectPromptStatus,
  login,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const MODEL_ID = "issue-1527-overlay-model";
const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  return root;
}

function agentDirOf(root: string): string {
  return join(root, "state", "home", ".omp", "agent");
}

/** Records each omp spawn's argv `--config` and env `PI_CONFIG_FILES`; the child exits 7. */
function captureConfigHook(): string {
  return `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const nativeSpawn = cp.spawn;
cp.spawn = function capture(command, args, options) {
  if (command !== process.env.OMP_BIN) return nativeSpawn(command, args, options);
  const record = {
    mode: args[args.indexOf('--approval-mode') + 1],
    config: args[args.indexOf('--config') + 1],
    files: options.env.PI_CONFIG_FILES,
  };
  fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify(record) + '\\n');
  return nativeSpawn(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: options.cwd, env: options.env, stdio: options.stdio, shell: false,
  });
};
syncBuiltinESMExports();
`;
}

async function createSessionIn(port: number, cookie: string, approvalMode: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ approvalMode }),
  });
  const body = (await response.json()) as { id?: unknown };
  expect(response.status).toBe(201);
  if (typeof body.id !== "string") {
    throw new Error("session create returned no id");
  }
  return body.id;
}

describe("production entry host overlay (#1527)", () => {
  it("cold start writes the fixed block then the browser block (enabled: false), the same bytes after a restart", async () => {
    const root = scratchRoot("open-wb-overlay-cold-");
    const state = join(root, "state");
    expect(HOST_OVERLAY_YAML).toBe(HOST_OVERLAY_FIXED + hostOverlayBrowserBlock(false));
    for (const _start of [1, 2]) {
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
      }));
      try {
        await server.waitForStarted();
        expectHostOverlay(state, HOST_OVERLAY_FIXED + hostOverlayBrowserBlock(false));
        const text = readFileSync(join(agentDirOf(root), "host-overlay.yml"), "utf8");
        expect(text.endsWith("\n  screenshotDir: screenshots\n")).toBe(true);
        expect(text).not.toContain("modelRoles");
        expect(readdirSync(agentDirOf(root)).toSorted()).toEqual([
          "host-overlay.yml",
          "models.yml",
        ]);
      } finally {
        await server.dispose();
      }
    }
  }, 90_000);

  it("the browser block follows BROWSER_BIN: enabled false unset, true set; only that line differs", async () => {
    const texts: string[] = [];
    for (const configured of [false, true]) {
      const root = scratchRoot("open-wb-overlay-browser-");
      const browser = join(root, "chromium");
      writeFileSync(browser, "#!/bin/sh\nexit 0\n");
      chmodSync(browser, 0o755);
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
          MODEL_ID,
          MODEL_VISION: "off",
          ...(configured ? { BROWSER_BIN: browser } : {}),
        }),
      }));
      try {
        await server.waitForStarted();
        expectHostOverlay(
          join(root, "state"),
          HOST_OVERLAY_FIXED + hostOverlayBrowserBlock(configured),
        );
        const text = readFileSync(join(agentDirOf(root), "host-overlay.yml"), "utf8");
        expect(text.endsWith("\n  screenshotDir: screenshots\n")).toBe(true);
        expect(text).not.toContain("modelRoles");
        texts.push(text);
      } finally {
        await server.dispose();
      }
    }
    const [unset, set] = texts.map((text) => text.split("\n"));
    const differing = (unset ?? []).flatMap((line, index) =>
      line === set?.[index] ? [] : [[line, set?.[index]]],
    );
    expect(set).toHaveLength(unset?.length ?? -1);
    expect(differing).toEqual([["  enabled: false", "  enabled: true"]]);
  }, 90_000);

  it("a MODEL_CATALOG with vision models appends modelRoles.vision for the first of them", async () => {
    const root = scratchRoot("open-wb-overlay-vision-");
    const catalog = '[{"id":"m1"},{"id":"m2","vision":true},{"id":"m3","vision":true}]';
    const expected = `${HOST_OVERLAY_YAML}modelRoles:\n  vision: "workbuddy/m2"\n`;
    for (const _start of [1, 2]) {
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_CATALOG: catalog }),
      }));
      try {
        await server.waitForStarted();
        expectHostOverlay(join(root, "state"), expected);
        expect(readdirSync(agentDirOf(root)).toSorted()).toEqual([
          "host-overlay.yml",
          "models.yml",
        ]);
      } finally {
        await server.dispose();
      }
    }
  }, 90_000);

  it("does not vary with the approval mode: three sessions spawn on the one unchanged file", async () => {
    const root = scratchRoot("open-wb-overlay-modes-");
    const trace = join(root, "spawn.jsonl");
    const hook = join(root, "capture-config.cjs");
    writeFileSync(hook, captureConfigHook());
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
        MODEL_ID,
        PROBE_TRACE: trace,
      }),
      requireHook: hook,
    }));
    try {
      await server.waitForStarted();
      const state = join(root, "state");
      const overlay = join(agentDirOf(root), "host-overlay.yml");
      expectHostOverlay(state);
      const cookie = await login(port);
      for (const mode of ["always-ask", "write", "yolo"]) {
        const session = await createSessionIn(port, cookie, mode);
        await expectPromptStatus(port, cookie, session, `mode ${mode}`, 502);
        expectHostOverlay(state);
        expect(readdirSync(agentDirOf(root)).toSorted()).toEqual([
          "host-overlay.yml",
          "models.yml",
        ]);
      }
      const spawns = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      expect(spawns).toEqual(
        ["always-ask", "write", "yolo"].map((mode) => ({ mode, config: overlay, files: overlay })),
      );
    } finally {
      await server.dispose();
    }
  }, 90_000);
});
