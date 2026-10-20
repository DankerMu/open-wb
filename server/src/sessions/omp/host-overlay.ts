/**
 * Host overlay (issue #708, ADR-0012): omp deep-merges the project settings found under the
 * session cwd, a directory the agent writes without approval, over the global layer. This file is
 * passed to every spawn as `--config` (global < project < overlay < CLI) and pins the keys that
 * would skip an approval or run a command outside one. omp does not schema-check an overlay file
 * as a whole, so each value depends on the pinned omp's consuming code: re-verify them on an omp
 * upgrade (#1564 and #1570 ran the block on v18.12.3: no `Settings:` warning, log or stderr).
 *
 * `tools.approvalMode: write` sits below argv: omp writes `--approval-mode` into a runtime
 * override layer above the overlay, so for an `always-ask` or `yolo` session the argv value is the
 * one in effect and that line is only the fallback for a spawn without the flag (every spawn
 * passes it). All sessions and all approval modes share this one file and its bytes never vary
 * with the mode: a session changes mode by being re-spawned, never by rewriting the overlay.
 *
 * `retry:` (issue #909, ADR-0012) caps omp's session-level retry at one round: omp already retries
 * each failed request inside a round (6 transport attempts, the round replayed once by the provider
 * layer: 12 requests, 实测 on v18.12.3 by #1570), so its default ten rounds keep a 5xx turn running
 * for minutes. `enabled`, `baseDelayMs` and `maxDelayMs` restate omp's defaults so the project layer
 * cannot lengthen the wait; `modelFallback: false` turns omp's model fallback off — switching
 * upstreams or models is out of scope, and a project `retry.fallbackChains` would otherwise switch
 * models on a 5xx turn (实测 on the old overlay) and, by omp's `isHardErrorFallbackEligible`, replay
 * even a non-retryable 424 on the next model (读代码推出, not measured).
 *
 * Issue #1564 (#1563 design D4) appends four pins after `retry:`: `telemetry.otlpExportEnabled`
 * (OTLP export defaults on and a cwd `.env` can supply the `OTEL_*` endpoint), `archive.enabled`
 * (the read-tier `archive` prelude; hygiene), `disabledProviders` (no implicit probing of the local
 * ollama / llama.cpp / lm-studio ports and no macOS `apple` provider; the managed `workbuddy`
 * provider is untouched) and `ask.enabled` (under `--mode rpc-ui` omp creates `ask`, the host can
 * only cancel its question, and a cancelled `ask` aborts the whole turn); #1570 (pin v18.12.3, eval
 * has only py / js) drops `ruby` / `julia` and adds `advisor` and `ida` (see below). `browser.tern`
 * and `dev.autoqa` are deliberately not pinned (owner 2026-10-20, ADR-0012).
 *
 * Issue #1527 (design D2): the bytes are a pure function of the deployment — the fixed block, then
 * the browser block, then the vision block when the whitelist has a vision model. `enabled` is the
 * browser switch (`BROWSER_BIN` set, group 3); while false omp offers no browser eval prelude and
 * so never downloads Chrome-for-Testing. `cdpUrl: ""`, `relay: false` and `cmux: false` void the project
 * layer's external browser, relay and cmux; `headless: true` refuses a headed window;
 * `screenshotDir: screenshots` is relative, so screenshots land in `<cwd>/screenshots/` (omp's
 * process cwd is the session cwd; 实测 task 2.3). `modelRoles` is an object: the deep merge pins
 * only `vision`, the project's other roles stay (ADR-0012 residual).
 */
import { basename, dirname } from "node:path";
import { replaceFile } from "../../core/replace-file.js";
import { ompHostOverlayPath } from "./state-layout.js";

const HOST_OVERLAY = [
  "tools:",
  // null takes omp's replace branch of the deep merge, so the project's per-tool record is dropped
  // as a whole, and reads as unset (default `{}`, no warning). An object would be deep-merged with
  // the project's; an array is dropped by v18.12.3's record check with a `Settings:` warning.
  "  approval: null",
  "  approvalMode: write",
  "bash:",
  "  patterns: []",
  '  direnv: "off"',
  "shellPath: null",
  "python:",
  '  interpreter: ""',
  "mcp:",
  "  enableProjectConfig: false",
  "todo:",
  // No hidden reminder and same-turn continuation for unfinished todos (issue #772).
  "  reminders: false",
  "images:",
  "  urls:",
  "    enabled: false",
  "    command: null",
  // One session-level retry (issue #909); enabled and both delays restate omp's defaults.
  "retry:",
  "  enabled: true",
  "  maxRetries: 1",
  "  baseDelayMs: 500",
  "  maxDelayMs: 300000",
  // No model fallback: a project fallback chain would switch models and reset the retry budget.
  "  modelFallback: false",
  "telemetry:",
  "  otlpExportEnabled: false",
  "archive:",
  "  enabled: false",
  // The array replaces the project's list as a whole: a project `disabledProviders` no longer
  // applies (measured on both versions, #1564; ADR-0012).
  "disabledProviders:",
  "  - ollama",
  "  - llama.cpp",
  "  - lm-studio",
  "  - apple",
  // No `ask` tool under `--mode rpc-ui`: a cancelled `ask` aborts the turn.
  "ask:",
  "  enabled: false",
  // Default false, but any project layer overrides a default; once on, its WATCHDOG lookup walks
  // past the empty `.git` marker (no `.git/HEAD`) to the filesystem root.
  "advisor:",
  "  enabled: false",
  // v18.12.3 defaults `ida.enabled` to true, and a project `ida.installDir` + `ida.python` would
  // make `read` run a project script without approval (Epic #1563 (f)).
  "ida:",
  "  enabled: false",
].join("\n");

/** What the overlay depends on; both are fixed at startup. */
export interface HostOverlayOptions {
  /** Whether the deployment configures a browser (`BROWSER_BIN`). */
  browserEnabled: boolean;
  /** The first `vision: true` whitelist model, or null when there is none. */
  visionModelId: string | null;
}

function hostOverlayText({ browserEnabled, visionModelId }: HostOverlayOptions): string {
  const lines = [
    HOST_OVERLAY,
    "browser:",
    `  enabled: ${String(browserEnabled)}`,
    '  cdpUrl: ""',
    "  relay: false",
    "  cmux: false",
    "  headless: true",
    "  screenshotDir: screenshots",
  ];
  if (visionModelId !== null) {
    lines.push("modelRoles:", `  vision: ${JSON.stringify(`workbuddy/${visionModelId}`)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the overlay for `options` to `ompHostOverlayPath(stateDir)` the way the managed `models.yml`
 * is written. The managed agent dir must exist: the state layout creates it, this writer never does.
 */
export async function writeHostOverlay(
  stateDir: string,
  options: HostOverlayOptions,
): Promise<void> {
  const path = ompHostOverlayPath(stateDir);
  await replaceFile(dirname(path), basename(path), hostOverlayText(options));
}
