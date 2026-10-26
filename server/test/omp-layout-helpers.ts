/**
 * Issue #706 managed omp state layout: the directory table of the omp-runtime spec, written out
 * here (not derived from `src/sessions/omp/state-layout.ts`) so the tests have their own oracle.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

/** Every directory `ensureOmpStateLayout` owns, relative to the state root, with `mode & 0o7777`. */
export const LAYOUT_TABLE: ReadonlyArray<readonly [string, number]> = [
  ["", 0o2750],
  ["home", 0o3770],
  ["home/.omp", 0o2750],
  ["home/.omp/agent", 0o2750],
  ["xdg", 0o2750],
  ["xdg/data", 0o2750],
  ["xdg/state", 0o2750],
  ["xdg/cache", 0o2750],
  ["xdg/data/omp", 0o2770],
  ["xdg/state/omp", 0o2770],
  ["xdg/cache/omp", 0o2770],
  ["sessions", 0o2750],
  ["trash", 0o700],
  ["snapshots", 0o700],
  ["session-config", 0o2710],
  ["mounts", 0o700],
];

/**
 * Issue #708 host overlay: the bytes of the omp-runtime spec's `host-overlay.yml`, written out here
 * (not imported from `src/sessions/omp/host-overlay.ts`). `HOST_OVERLAY_FIXED` is the fixed block;
 * `HOST_OVERLAY_YAML` is the file of a deployment without `BROWSER_BIN` and without a vision model
 * (#1527: fixed block, then the browser block with `enabled: false`, no vision block). Since #1530
 * (`MODEL_VISION` defaults on) the default deployment adds `hostOverlayVisionBlock(<MODEL_ID>)`.
 * #1564: the fixed block has `approval: null` and the `telemetry`, `archive`, `disabledProviders`
 * and `ask` pins. #1570 (the pin moves to v18.12.3): `ruby` / `julia` are gone and the block ends
 * with the `advisor` and `ida` pins. #1621: `disabledProviders` lists the 87 built-in model
 * providers of v18.12.3 and `marketplace.autoUpdate: "off"` follows it.
 */
export const HOST_OVERLAY_FIXED = `tools:
  approval: null
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
images:
  urls:
    enabled: false
    command: null
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: false
telemetry:
  otlpExportEnabled: false
archive:
  enabled: false
disabledProviders:
  - ollama
  - llama.cpp
  - lm-studio
  - apple
  - abliteration
  - aiand
  - aimlapi
  - alibaba-coding-plan
  - alibaba-token-plan
  - amazon-bedrock
  - anthropic
  - azure
  - baseten
  - bedrock-mantle
  - cerebras
  - charm-hyper
  - cline-pass
  - cloudflare-ai-gateway
  - cloudflare-workers-ai
  - commandcode
  - coralbricks
  - coreweave
  - deepinfra
  - deepseek
  - devin
  - factory-droid
  - firepass
  - fireworks
  - github-copilot
  - gitlab-duo
  - gitlab-duo-agent
  - gmi-cloud
  - google
  - google-antigravity
  - google-gemini-cli
  - google-vertex
  - groq
  - helmcode
  - huggingface
  - kilo
  - kimi-code
  - litellm
  - meta
  - minimax
  - minimax-cn
  - minimax-code
  - minimax-code-cn
  - mistral
  - moonshot
  - muse-code
  - nanogpt
  - novita
  - nvidia
  - ollama-cloud
  - openai
  - openai-codex
  - opencode-go
  - opencode-zen
  - openrouter
  - qianfan
  - qwen-portal
  - sakana
  - sambanova
  - siliconflow
  - siliconflow-cn
  - singularityapi-dev
  - singularityapi-tech
  - snowflake
  - stepfun
  - synthetic
  - together
  - typesafe
  - umans
  - venice
  - vercel-ai-gateway
  - vllm
  - wafer-serverless
  - xai
  - xai-oauth
  - xiaomi
  - xiaomi-token-plan-ams
  - xiaomi-token-plan-cn
  - xiaomi-token-plan-sgp
  - yolo-auto
  - zai
  - zenmux
  - zhipu-coding-plan
marketplace:
  autoUpdate: "off"
ask:
  enabled: false
advisor:
  enabled: false
ida:
  enabled: false
`;

/** The spec's browser block (#1527); `enabled` is whether the deployment configures `BROWSER_BIN`. */
export function hostOverlayBrowserBlock(enabled: boolean): string {
  return `browser:
  enabled: ${String(enabled)}
  cdpUrl: ""
  relay: false
  cmux: false
  headless: true
  screenshotDir: screenshots
`;
}

/** The spec's vision block (#1527): `modelRoles.vision`, the JSON string literal of `workbuddy/<id>`. */
export function hostOverlayVisionBlock(id: string): string {
  return `modelRoles:\n  vision: ${JSON.stringify(`workbuddy/${id}`)}\n`;
}

export const HOST_OVERLAY_YAML = HOST_OVERLAY_FIXED + hostOverlayBrowserBlock(false);

/**
 * `<state>/home/.omp/agent/host-overlay.yml` is a 0640 regular file holding exactly `expected`
 * (`HOST_OVERLAY_YAML` when absent: no `BROWSER_BIN`, no vision model).
 */
export function expectHostOverlay(state: string, expected = HOST_OVERLAY_YAML): void {
  const overlay = join(state, "home", ".omp", "agent", "host-overlay.yml");
  const stats = lstatSync(overlay);
  expect(stats.isFile()).toBe(true);
  expect(stats.mode & 0o7777).toBe(0o640);
  expect(readFileSync(overlay, "utf8")).toBe(expected);
}

/**
 * Issue #802: `<state>/home/.env` is a 0640 regular file owned by this process; the host creates
 * it empty and never touches its content afterwards.
 */
export function expectHomeDotenv(state: string, content = ""): void {
  const dotenv = join(state, "home", ".env");
  const stats = lstatSync(dotenv);
  expect(stats.isFile()).toBe(true);
  expect(stats.mode & 0o7777).toBe(0o640);
  expect(stats.uid).toBe(process.geteuid?.());
  expect(readFileSync(dotenv, "utf8")).toBe(content);
}

/** `sessions/<ownerId>`, created by the spawn. */
export function sessionRow(ownerId: string): readonly [string, number] {
  return [`sessions/${ownerId}`, 0o2770];
}

export function expectLayout(
  base: string,
  rows: ReadonlyArray<readonly [string, number]> = LAYOUT_TABLE,
): void {
  for (const [path, mode] of rows) {
    const stats = lstatSync(join(base, path));
    expect(stats.isDirectory(), path).toBe(true);
    expect(stats.mode & 0o7777, path).toBe(mode);
    expect(stats.uid, path).toBe(process.geteuid?.());
  }
}

/** The old layout's `<state>/agent` (2770) with a models.yml and one skill `x`; returns its path. */
export function seedLegacyAgentDir(state: string): string {
  const legacy = join(state, "agent");
  mkdirSync(join(legacy, "skills", "x"), { recursive: true });
  writeFileSync(join(legacy, "models.yml"), "legacy-models");
  writeFileSync(join(legacy, "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
  chmodSync(legacy, 0o2770);
  return legacy;
}
