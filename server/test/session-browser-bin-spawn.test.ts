/**
 * Issue #1529 browser-runtime「浏览器可执行文件配置」scenario「配置实际抵达每种 spawn」. `BROWSER_BIN`
 * goes through the production config seam (`resolveServerConfig` → `sessionRuntimeOf`) into the
 * runtime object the production `createApp` assembly hands the supervisor (configured / unset, as
 * `server-assembly.test.ts`'s OMP_USER case). An authenticated session's prompt, a fork of that
 * session and a regenerate of the fork each spawn one real fake-omp child through the captured
 * spawnImpl (no real omp): all three env carry `PUPPETEER_EXECUTABLE_PATH=<file>` exactly when the
 * key is configured, none of them otherwise.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import { REAL } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import {
  FIRST,
  forkWorlds,
  messagesOf,
  openForkWorld,
  realSource,
  turn,
} from "./session-fork-helpers.js";
import { QUESTION } from "./session-regenerate-helpers.js";
import { requiredCall, resumePath, waitForTurn } from "./session-supervisor-helpers.js";
import { presetSessionFile } from "./session-supervisor-pool-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;

const worlds = forkWorlds();
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An absolute 0755 regular file: a valid `BROWSER_BIN` (never executed here). */
function executable(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-browser-bin-spawn-"));
  scratch.push(dir);
  const file = join(dir, "chromium");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("BROWSER_BIN reaches the session, fork and regenerate spawns", () => {
  it.each([
    ["configured", true],
    ["unset", false],
  ] as const)("%s", REAL, async (_name, configured) => {
    const file = configured ? executable() : undefined;
    const config = resolveServerConfig(
      file === undefined ? {} : { BROWSER_BIN: file },
      SOURCE_ENTRY,
    );
    const fromConfig = sessionRuntimeOf(config);
    const world = worlds.track(await openForkWorld({ entries: [FIRST] }));
    // The object the supervisor reads at every runtime construction (never a spread copy).
    if (fromConfig.browserBin !== undefined) {
      world.rt.runtime.browserBin = fromConfig.browserBin;
    }
    const { db } = world.fixture;
    const source = world.session;

    await turn(world, FIRST);
    await turn(world, QUESTION);
    const u2 = messagesOf(db, source)[2];
    if (u2 === undefined) {
      throw new Error("missing u2");
    }
    const real = realSource();
    presetSessionFile(db, source, real.file);
    const forked = await postSessionAction(world.fixture.app, "fork", source, world.cookie, {
      name: "fork body",
      payload: JSON.stringify({ messageId: u2.id }),
      contentType: "application/json",
    });
    expect(forked.statusCode).toBe(201);
    const fresh = (forked.json() as { session: { id: string } }).session.id;
    const regenerated = await postSessionAction(
      world.fixture.app,
      "regenerate",
      fresh,
      world.cookie,
    );
    expect(regenerated.statusCode).toBe(202);
    await waitForTurn(world.fixture, fresh, "done");

    const calls = world.rt.calls;
    expect(calls).toHaveLength(3);
    // 0: the session's prompt (cold); 1: the fork's temporary child; 2: the fork's regenerate.
    expect(resumePath(requiredCall(calls, 0).args)).toBeUndefined();
    expect(resumePath(requiredCall(calls, 1).args)).toBe(real.file);
    expect(resumePath(requiredCall(calls, 2).args)).toMatch(/branch-/u);
    for (const call of calls) {
      if (file === undefined) {
        expect(call.env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
      } else {
        expect(call.env.PUPPETEER_EXECUTABLE_PATH).toBe(file);
      }
      expect(call.env).not.toHaveProperty("BROWSER_BIN");
    }
  });
});
