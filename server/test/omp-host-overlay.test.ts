/**
 * Issue #708 host overlay: the file omp is given through `--config` on every spawn. The expected
 * bytes are the omp-runtime spec's, kept in `omp-layout-helpers.ts`; the argv side is asserted by
 * the spawn contract tests and the startup side by `server-startup-layout.test.ts`.
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
import { expectHostOverlay, HOST_OVERLAY_YAML } from "./omp-layout-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";

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
        await writeHostOverlay(state);
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
    });
  });

  it("a repeated write keeps the bytes, restores a widened or edited file and leaves no temporary file", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state);
    await writeHostOverlay(state);
    expectHostOverlay(state);

    writeFileSync(ompHostOverlayPath(state), "tools:\n  approval:\n    bash: allow\n");
    chmodSync(ompHostOverlayPath(state), 0o666);
    await writeHostOverlay(state);
    expectHostOverlay(state);
    expect(readdirSync(ompAgentDir(state))).toEqual(["host-overlay.yml"]);
  });

  it("does not vary with the approval mode: same bytes and the same --config path for all three", async () => {
    const state = stateDir();
    ensureOmpStateLayout(state);
    await writeHostOverlay(state);
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
    await expect(writeHostOverlay(state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readdirSync(dirname(state))).toEqual([]);
  });
});
