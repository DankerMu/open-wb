/**
 * Issue #708 host overlay: the file omp is given through `--config` on every spawn. The expected
 * bytes are the omp-runtime spec's, kept in `omp-layout-helpers.ts`; the argv side is asserted by
 * the spawn contract tests and the startup side by `server-startup-layout.test.ts` and
 * `server-startup-overlay.test.ts`. Issue #1527: the bytes are a pure function of the deployment
 * (`browserEnabled`, `visionModelId`): the fixed block, the browser block and, when the whitelist
 * has a vision model, the vision block.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APPROVAL_MODES } from "../src/model-catalog.js";
import { writeHostOverlay } from "../src/sessions/omp/host-overlay.js";
import { type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import {
  ensureOmpStateLayout,
  ompAgentDir,
  ompHostOverlayPath,
} from "../src/sessions/omp/state-layout.js";
import {
  expectHostOverlay,
  HOST_OVERLAY_FIXED,
  HOST_OVERLAY_YAML,
  hostOverlayBrowserBlock,
  hostOverlayVisionBlock,
} from "./omp-layout-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";

/** The default deployment: no `BROWSER_BIN`, no vision model in the whitelist. */
const DEFAULT = { browserEnabled: false, visionModelId: null } as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-host-overlay-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  return join(root, "state");
}

describe("ompHostOverlayPath", () => {
  it("is host-overlay.yml directly under the managed agent dir", () => {
    const state = join("/srv", "wb state", "omp");
    expect(ompHostOverlayPath(state)).toBe(
      join(state, "home", ".omp", "agent", "host-overlay.yml"),
    );
    expect(dirname(ompHostOverlayPath(state))).toBe(ompAgentDir(state));
  });
});

describe("writeHostOverlay", () => {
  it.each([0o000, 0o077])(
    "writes the exact spec bytes as a 0640 file under umask %o and leaves nothing else",
    async (umask) => {
      const state = stateDir();
      ensureOmpStateLayout(state);
      const previousUmask = process.umask(umask);
      try {
        await writeHostOverlay(state, DEFAULT);
      } finally {
        process.umask(previousUmask);
      }
      expectHostOverlay(state);
      expect(readdirSync(ompAgentDir(state))).toEqual(["host-overlay.yml"]);
    },
  );

  it("pins every key the spec lists, as omp will parse them", () => {
    expect(parse(HOST_OVERLAY_YAML)).toEqual({
      tools: { approval: [], approvalMode: "write" },
      bash: { patterns: [], direnv: "off" },
      shellPath: null,
      python: { interpreter: "" },
      ruby: { interpreter: "" },
      julia: { interpreter: "" },
      mcp: { enableProjectConfig: false },
      todo: { reminders: false },
      images: { urls: { enabled: false, command: null } },
      retry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 500,
        maxDelayMs: 300_000,
        modelFallback: false,
      },
      browser: {
        enabled: false,
        cdpUrl: "",
        relay: false,
        cmux: false,
        headless: true,
        screenshotDir: "screenshots",
      },
    });
  });

  it("the browser block follows browserEnabled: the two files differ in exactly that line", async () => {
    const texts: string[] = [];
    for (const browserEnabled of [false, true]) {
      const state = join(root, `state-${String(browserEnabled)}`);
      ensureOmpStateLayout(state);
      await writeHostOverlay(state, { browserEnabled, visionModelId: null });
      const expected = HOST_OVERLAY_FIXED + hostOverlayBrowserBlock(browserEnabled);
      expectHostOverlay(state, expected);
      texts.push(expected);
    }
    const [off = [], on = []] = texts.map((text) => text.split("\n"));
    expect(on.filter((line, index) => line !== off[index])).toEqual(["  enabled: true"]);
    expect(off.filter((line, index) => line !== on[index])).toEqual(["  enabled: false"]);
    for (const text of texts) {
      expect(text.endsWith("\n  screenshotDir: screenshots\n")).toBe(true);
      expect(text).not.toContain("modelRoles");
    }
  });

  it("a vision model id appends the vision block after the browser block", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    // MODEL_CATALOG [{"id":"m1"},{"id":"m2","vision":true},{"id":"m3","vision":true}]: m2 is the id.
    await writeHostOverlay(state, { browserEnabled: false, visionModelId: "m2" });
    const expected = `${HOST_OVERLAY_YAML}modelRoles:\n  vision: "workbuddy/m2"\n`;
    expect(hostOverlayVisionBlock("m2")).toBe('modelRoles:\n  vision: "workbuddy/m2"\n');
    expectHostOverlay(state, expected);
    expect(parse(expected)).toMatchObject({ modelRoles: { vision: "workbuddy/m2" } });
  });

  it("quotes the vision id as a JSON string, so any whitelist id parses back unchanged", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    const id = 'a"b: #c\\d 模型';
    await writeHostOverlay(state, { browserEnabled: true, visionModelId: id });
    const expected =
      HOST_OVERLAY_FIXED +
      hostOverlayBrowserBlock(true) +
      'modelRoles:\n  vision: "workbuddy/a\\"b: #c\\\\d 模型"\n';
    expectHostOverlay(state, expected);
    expect((parse(expected) as { modelRoles: unknown }).modelRoles).toEqual({
      vision: `workbuddy/${id}`,
    });
  });

  it("a repeated write keeps the bytes, restores a widened or edited file and leaves no temporary file", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state, DEFAULT);
    await writeHostOverlay(state, DEFAULT);
    expectHostOverlay(state);

    writeFileSync(ompHostOverlayPath(state), "tools:\n  approval:\n    bash: allow\n");
    chmodSync(ompHostOverlayPath(state), 0o666);
    await writeHostOverlay(state, DEFAULT);
    expectHostOverlay(state);
    expect(readdirSync(ompAgentDir(state))).toEqual(["host-overlay.yml"]);
  });

  it("does not vary with the approval mode: same bytes and the same --config path for all three", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state, DEFAULT);
    const configs: unknown[] = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      configs.push(args[args.indexOf("--config") + 1], options.env?.PI_CONFIG_FILES);
      return new FakeChild().spawnImpl(command, args, options);
    };
    for (const approvalMode of APPROVAL_MODES) {
      await spawnOmp(
        {
          bin: join(root, "omp"),
          sandboxRoot: join(root, "sandbox"),
          stateDir: state,
          ownerId: "u1",
          cwd: join(root, "sandbox", "u1"),
          modelId: "m1",
          approvalMode,
          token: "t".repeat(64),
          resumePath: null,
        },
        spawnImpl,
      );
      expectHostOverlay(state);
      expect(readdirSync(ompAgentDir(state))).toEqual(["host-overlay.yml"]);
    }
    expect(configs).toEqual(Array<string>(6).fill(ompHostOverlayPath(state)));
  });

  it("rejects when the managed agent dir is missing and creates nothing", async () => {
    const state = stateDir();
    await expect(writeHostOverlay(state, DEFAULT)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readdirSync(dirname(state))).toEqual([]);
  });
});
