/**
 * Issue #708 host overlay: the file omp is given through `--config` on every spawn. The expected
 * bytes are the omp-runtime spec's, kept in `omp-layout-helpers.ts`; the argv side is asserted by
 * the spawn contract tests and the startup side by `server-startup-layout.test.ts` and
 * `server-startup-overlay.test.ts`. Issue #1527: the bytes are a pure function of the deployment
 * (`browserEnabled`, `visionModelId`): the fixed block, the browser block and, when the whitelist
 * has a vision model, the vision block.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { openDb } from "../src/core/db/index.js";
import { APPROVAL_MODES } from "../src/model-catalog.js";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { createPublisher } from "../src/models/publish.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
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

/** No `BROWSER_BIN`, no vision model in the whitelist (since #1530 not the default deployment). */
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
      tools: { approval: null, approvalMode: "write" },
      bash: { patterns: [], direnv: "off" },
      shellPath: null,
      python: { interpreter: "" },
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
      telemetry: { otlpExportEnabled: false },
      archive: { enabled: false },
      // The 87 ids are pinned byte for byte by HOST_OVERLAY_FIXED; their shape is the next case's.
      disabledProviders: expect.any(Array),
      // A string, not YAML's boolean false.
      marketplace: { autoUpdate: "off" },
      ask: { enabled: false },
      advisor: { enabled: false },
      ida: { enabled: false },
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

  it("disabledProviders (#1621): 87 unique ids, the four local probes first, the rest sorted, none of the kept ids", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state, DEFAULT);
    const written = parse(readFileSync(ompHostOverlayPath(state), "utf8")) as {
      disabledProviders: string[];
    };
    const ids = written.disabledProviders;
    expect(ids).toHaveLength(87);
    expect(new Set(ids).size).toBe(87);
    expect(ids.slice(0, 4)).toEqual(["ollama", "llama.cpp", "lm-studio", "apple"]);
    const rest = ids.slice(4);
    expect(rest).toEqual([...rest].sort());
    // Model providers excluded by the rule, the managed provider, and capability discovery sources
    // of v18.12.3 (`discovery/*.ts` `PROVIDER_ID`): listing one would hide it.
    for (const kept of [
      "cursor",
      "local",
      "web",
      "workbuddy",
      "claude",
      "codex",
      "cline",
      "native",
    ]) {
      expect(ids).not.toContain(kept);
    }
  });

  it("the fixed block (#1564, #1570, #1621): approval null, no ruby/julia, marketplace before ask, ida last", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state, DEFAULT);
    const text = readFileSync(ompHostOverlayPath(state), "utf8");
    const fixed = text.slice(0, text.indexOf("\nbrowser:\n") + 1);
    expect(fixed).toBe(HOST_OVERLAY_FIXED);
    expect(fixed.split("\n").filter((line) => line.includes("approval:"))).toEqual([
      "  approval: null",
    ]);
    // v18.12.3 has no ruby / julia eval backends: the flip removes both pins.
    expect(fixed).not.toMatch(/ruby|julia/u);
    expect(fixed).toContain('\npython:\n  interpreter: ""\nmcp:\n');
    expect(fixed).toContain('\n  - zhipu-coding-plan\nmarketplace:\n  autoUpdate: "off"\nask:\n');
    expect(
      fixed.endsWith(
        "\nask:\n  enabled: false\nadvisor:\n  enabled: false\nida:\n  enabled: false\n",
      ),
    ).toBe(true);
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

  it("the vision block is rewritten from the registry snapshot on every publish (s1d-model-registry D13)", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    const db = openDb(":memory:");
    try {
      const store = createModelStore(db);
      store.create({ id: "m1" });
      const registry = createRegistry(store);
      registry.refresh();
      const { publish } = createPublisher({
        agentDir: ompAgentDir(state),
        stateDir: state,
        proxyBaseUrl: () => "http://127.0.0.1:18016/v1",
        browserEnabled: false,
        registry,
        writeModelsYml: writeManagedModelsYml,
        writeOverlay: writeHostOverlay,
      });

      await publish();
      expectHostOverlay(state, HOST_OVERLAY_YAML);

      store.create({ id: "m2", vision: true });
      registry.refresh();
      await publish();
      expectHostOverlay(state, HOST_OVERLAY_YAML + hostOverlayVisionBlock("m2"));

      store.remove("m2");
      registry.refresh();
      await publish();
      expectHostOverlay(state, HOST_OVERLAY_YAML);
    } finally {
      db.close();
    }
  });

  it("rejects when the managed agent dir is missing and creates nothing", async () => {
    const state = stateDir();
    await expect(writeHostOverlay(state, DEFAULT)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readdirSync(dirname(state))).toEqual([]);
  });
});
