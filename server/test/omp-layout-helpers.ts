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
];

/**
 * Issue #708 host overlay: the bytes of the omp-runtime spec's `host-overlay.yml`, written out here
 * (not imported from `src/sessions/omp/host-overlay.ts`).
 */
export const HOST_OVERLAY_YAML = `tools:
  approval: []
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
ruby:
  interpreter: ""
julia:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
images:
  urls:
    enabled: false
    command: null
`;

/** `<state>/home/.omp/agent/host-overlay.yml` is a 0640 regular file holding exactly the spec bytes. */
export function expectHostOverlay(state: string): void {
  const overlay = join(state, "home", ".omp", "agent", "host-overlay.yml");
  const stats = lstatSync(overlay);
  expect(stats.isFile()).toBe(true);
  expect(stats.mode & 0o7777).toBe(0o640);
  expect(readFileSync(overlay, "utf8")).toBe(HOST_OVERLAY_YAML);
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
