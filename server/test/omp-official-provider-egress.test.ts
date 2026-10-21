/**
 * Issue #1621 (change omp-overlay-builtin-providers-off): omp-runtime「宿主 overlay」scenario「启动后不向
 * 第三方模型目录主机发请求（真实 omp）」. #1615's stand-in proxy (support/omp-official.ts `proxyListener`:
 * records each request line and `CONNECT` target, answers 502, never forwards), named by a fresh
 * world's cwd `.env` as `ALL_PROXY`, with both no_proxy pins dropped so omp's background model
 * discovery reaches it. No
 * prompt is sent (`ALL_PROXY` would proxy the loopback model request too): `get_available_models`
 * awaits omp's background refresh, then the child stays up for one window and the listener is read.
 * Under the product overlay it gets nothing at all, while `workbuddy/<model>` and the cwd's
 * `.claude/skills/x` stay listed; the negative control swaps the overlay's `disabledProviders` back
 * to #1564's four ids and sees `CONNECT`s, `catalog.stencil.so:443` among them. The same worlds hold
 * a stale registered plugin marketplace whose source is an https `.json` URL on a reserved `.invalid`
 * host (design D5: omp refreshes a marketplace older than 24 h at every start while
 * `marketplace.autoUpdate` is not `off`); the second negative control drops the overlay's
 * `marketplace` block and sees a `CONNECT` to that host.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-provider-egress.test.ts --coverage=false
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ompHostOverlayPath, ompXdgHome } from "../src/sessions/omp/state-layout.js";
import {
  expectOverlayAt,
  launchWriteTier,
  OMP_TEST_OFF,
  OMP_VERSION,
  openOfficialWorld,
  overlaySwapping,
  overlayWithout,
  proxyListener,
  type WriteTierLaunch,
} from "./support/omp-official.js";

const TURN_CASE = { timeout: 180_000 };
/** The world's model (support/omp-official.ts). */
const MODEL_ID = "deepseek-v4.1-flash";
/**
 * How long the child stays up after `get_available_models` answered (design D3: the magnitude of
 * `OTLP_WINDOW_MS`, for a manager request arriving after the background refresh settled).
 */
const DISCOVERY_WINDOW_MS = 5_000;
/** #1564's `disabledProviders`: the four local probes only (#1621's negative control). */
const FOUR_PROVIDERS = "disabledProviders:\n  - ollama\n  - llama.cpp\n  - lm-studio\n  - apple\n";
/** The shared models.dev catalog's host (v18.12.3 `catalog/src/provider-models/openai-compat.ts:94`). */
const CATALOG_CONNECT = "CONNECT catalog.stencil.so:443";
/** The overlay's marketplace pin, as its fixed block writes it (design D5). */
const MARKETPLACE_BLOCK = 'marketplace:\n  autoUpdate: "off"\n';
/** The planted marketplace's source; `.invalid` never resolves, the stand-in proxy never forwards. */
const MARKETPLACE_SOURCE = "https://marketplace.workbuddy.invalid/marketplace.json";
const MARKETPLACE_CONNECT = "CONNECT marketplace.workbuddy.invalid:443";

/** One reading, with the child's malformed stdout line count (#1592). */
function log(run: WriteTierLaunch, reading: Record<string, unknown>): void {
  console.log(`[provider-egress] ${JSON.stringify({ ...reading, malformed: run.malformed() })}`);
}

/** What one discovery window showed: the stand-in proxy's request lines, omp's models and commands. */
interface DiscoveryReading {
  hits: string[];
  models: string[];
  commands: string[];
}

/** Which overlay a discovery window runs: the product's, or one of the two negative controls. */
type DiscoveryOverlay = "product" | "four-providers" | "without-marketplace";

/**
 * The marketplaces registry omp reads at start (v18.12.3 `getMarketplacesRegistryPath`:
 * `$XDG_DATA_HOME/omp/marketplaces.json`), holding one `url` marketplace last updated in 2020, so
 * `refreshStaleMarketplaces` fetches its source (`marketplace/manager.ts:751-762`).
 */
function plantStaleMarketplace(stateDir: string): void {
  const dataRoot = join(ompXdgHome(stateDir, "data"), "omp");
  const entry = {
    name: "wb-probe",
    sourceType: "url",
    sourceUri: MARKETPLACE_SOURCE,
    catalogPath: join(dataRoot, "wb-probe-catalog.json"),
    addedAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  writeFileSync(
    join(dataRoot, "marketplaces.json"),
    `${JSON.stringify({ version: 1, marketplaces: [entry] }, null, 2)}\n`,
  );
}

/**
 * A fresh world (no model catalog cache) whose cwd `.env` names the stand-in proxy as `ALL_PROXY`,
 * whose cwd holds `.claude/skills/x` and whose omp data dir a stale marketplace, a runtime without
 * the two no_proxy pins — with the product overlay, its `disabledProviders` block swapped for
 * #1564's four ids, or without its `marketplace` block — then `get_available_models`, the window,
 * and the readings (the listener's first).
 */
async function discoveryWindow(variant: DiscoveryOverlay): Promise<DiscoveryReading> {
  const proxy = await proxyListener();
  const world = await openOfficialWorld(({ stateDir, workspaceRoot }) => {
    plantStaleMarketplace(stateDir);
    writeFileSync(
      join(workspaceRoot, ".env"),
      `ALL_PROXY=http://127.0.0.1:${String(proxy.port)}\n`,
    );
    const skill = join(workspaceRoot, ".claude", "skills", "x");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: x\ndescription: 项目技能\n---\n正文\n");
  });
  let overlay: string | undefined;
  if (variant === "four-providers") {
    const product = readFileSync(ompHostOverlayPath(world.stateDir), "utf8");
    const block = String(/^disabledProviders:\n(?: {2}- .+\n)+/mu.exec(product)?.[0]);
    overlay = overlaySwapping(world, block, FOUR_PROVIDERS, "overlay-four-providers");
  } else if (variant === "without-marketplace") {
    overlay = overlayWithout(world, MARKETPLACE_BLOCK, "marketplace");
  }
  const run = launchWriteTier(world, overlay, true, false);

  // The host never sends these two commands, so the runtime's frame union does not carry them.
  const listed = (await run.runtime.command({ type: "get_available_models" } as never)) as {
    models: Array<{ provider: string; id: string }>;
  };
  const answeredAt = Date.now();
  await delay(DISCOVERY_WINDOW_MS);
  const hits = [...proxy.hits];
  const available = (await run.runtime.command({ type: "get_available_commands" } as never)) as {
    commands: Array<{ name: string }>;
  };
  const spawnedAt = run.spawnedAt[0] ?? Number.NaN;
  const reading = {
    hits: hits.map((hit) => hit.line),
    models: listed.models.map((model) => `${model.provider}/${model.id}`),
    commands: available.commands.map((command) => command.name),
  };
  log(run, {
    case: `discovery/${variant}`,
    proxy: reading.hits,
    sinceSpawnMs: hits.map((hit) => hit.at - spawnedAt),
    modelsAnsweredMs: answeredAt - spawnedAt,
    windowMs: DISCOVERY_WINDOW_MS,
    models: reading.models,
  });

  expect(run.env).toHaveLength(1);
  expect(run.env[0]).not.toHaveProperty("no_proxy");
  expect(run.env[0]).not.toHaveProperty("NO_PROXY");
  expectOverlayAt(run, overlay ?? ompHostOverlayPath(world.stateDir));
  return reading;
}

describe.skipIf(OMP_TEST_OFF)(
  `official omp v${OMP_VERSION}: no request to a third-party model catalog host`,
  () => {
    it(
      "product overlay: the proxy gets nothing in the window; workbuddy model and skill:x listed",
      TURN_CASE,
      async () => {
        const { hits, models, commands } = await discoveryWindow("product");

        expect(hits).toEqual([]);
        expect(models).toContain(`workbuddy/${MODEL_ID}`);
        expect(commands).toContain("skill:x");
      },
    );

    it(
      "negative control: disabledProviders back to the four local probes, the proxy gets CONNECTs incl. the shared catalog",
      TURN_CASE,
      async () => {
        const { hits } = await discoveryWindow("four-providers");

        expect(hits.some((line) => line.startsWith("CONNECT "))).toBe(true);
        expect(hits).toContain(CATALOG_CONNECT);
      },
    );

    it(
      "negative control: the overlay without its marketplace block, the proxy gets a CONNECT to the stale marketplace's host",
      TURN_CASE,
      async () => {
        const { hits } = await discoveryWindow("without-marketplace");

        expect(hits).toContain(MARKETPLACE_CONNECT);
      },
    );
  },
);
