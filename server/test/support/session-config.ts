/**
 * s1d-experts-skills group 1 (omp-runtime「子进程 spawn 契约」「会话配置文件」): the per-spawn session
 * config file as the spec writes it, not derived from `src/sessions/omp/session-config.ts`.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, vi } from "vitest";

/** No expert and nothing disabled: what every group-1 spawn path passes (design D1). */
export const EMPTY_CAPABILITIES = { disabledExtensions: [], appendSystemPrompt: null } as const;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The second `--config` value of a spawn, `<state>/session-config/<key>.yml` under the configured
 * state dir for any hex key, as an asymmetric matcher for argv arrays.
 */
export function sessionConfigYml(stateDir: string): string {
  const dir = escaped(join(stateDir, "session-config"));
  return expect.stringMatching(new RegExp(`^${dir}/[0-9a-f]+\\.yml$`, "u")) as string;
}

/** `value` with every session config key replaced by `<key>`: spawns compared apart from it. */
export function keyless<T>(value: T): T {
  const text = JSON.stringify(value).replace(
    /session-config\/[0-9a-f]+\./gu,
    "session-config/<key>.",
  );
  return JSON.parse(text) as T;
}

const SESSION_CONFIG_FILE = /\/session-config\/[0-9a-f]+\.(yml|md)$/u;

/** The EACCES a removal of a file the omp uid still holds would throw. */
export function eacces(): Error {
  return Object.assign(new Error("EACCES: session config file"), { code: "EACCES" });
}

/**
 * Makes `rmSync` of a session config file (`session-config/<key>.yml` / `.md`) whose extension is in
 * `extensions` throw `thrown()`; every other path is removed for real. Undo with
 * `vi.restoreAllMocks()` then `syncBuiltinESMExports()`.
 */
export function failSessionConfigRemovals(
  extensions: readonly ("yml" | "md")[],
  thrown: () => unknown = eacces,
): void {
  const rmSync = fs.rmSync;
  vi.spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof rmSync>) => {
    const extension = SESSION_CONFIG_FILE.exec(String(args[0]))?.[1];
    if (extension !== undefined && (extensions as readonly string[]).includes(extension)) {
      throw thrown();
    }
    rmSync(...args);
  }) as typeof rmSync);
  syncBuiltinESMExports();
}
