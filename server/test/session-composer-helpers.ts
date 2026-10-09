/**
 * Test plumbing shared by the two files that pin how a dispatch aligns a session's process with
 * its composer settings: `session-composer-dispatch.test.ts` (#1009, the mode: a restart) and
 * `session-composer-align.test.ts` (#1010, the model and the effort: two commands). Composed over
 * the #464/#465 worlds (production createApp → registerSessions, real fake-omp children, per-child
 * stdin record, injected clock); settings are set over REST, or by SQL where REST would refuse the
 * value. Oracles stay public: SQLite rows, spawn argv, stdin frames, Node's own exit state.
 */
import { expect } from "vitest";
import type { ComposerConfig } from "../src/sessions/store-composer.js";
import type { ApprovalWorld } from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import { epochOf, sessionFile } from "./session-regenerate-helpers.js";
import { holdExitEvents } from "./session-spawn-gate-helpers.js";

/** Any of the worlds here: each is an approval world, opened under one scenario or another. */
type World = ApprovalWorld;

type Mode = "always-ask" | "write" | "yolo";

/** The model id fake-omp refuses in `set_model` (`fake-omp-composer.mjs`, `Model not found`). */
export const MISSING_MODEL = "workbuddy-missing-model";
/** The level fake-omp refuses in `set_thinking_level`; no REST request can store it. */
export const BAD_LEVEL = "workbuddy-bad-level";

/**
 * The three-model whitelist plus the model fake-omp refuses: off the whitelist the id would read
 * as the default model and no failing command would ever be sent.
 */
export const FAILING_MODEL_CATALOG: ComposerConfig["modelCatalog"] = {
  models: [
    ...THREE_MODEL_CATALOG.models,
    { id: MISSING_MODEL, name: "Missing", reasoning: false, vision: false },
  ],
  defaultModelId: THREE_MODEL_CATALOG.defaultModelId,
};

/** Writes a raw composer column REST would refuse to store (above the cap, off the whitelist). */
export function plant(
  world: World,
  column: "approval_mode" | "model_id",
  value: string,
  session = world.session,
): void {
  const written = world.fixture.db
    .prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`)
    .run(value, session);
  expect(Number(written.changes)).toBe(1);
}

/**
 * Stores `BAD_LEVEL` as the session's raw effort. Migration 040's CHECK admits the seven effort
 * names only, so the constraint is switched off for this one statement.
 */
export function plantBadLevel(world: World): void {
  const { db } = world.fixture;
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    const written = db
      .prepare("UPDATE chat_sessions SET reasoning_effort = ? WHERE id = ?")
      .run(BAD_LEVEL, world.session);
    expect(Number(written.changes)).toBe(1);
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
}

/** The owner picks `approvalMode` over REST: 200, and the view reads it back. */
export async function setMode(
  world: World,
  approvalMode: Mode,
  session = world.session,
): Promise<void> {
  const response = await patch(world, { approvalMode }, { session });
  expect(response.statusCode).toBe(200);
  expect((response.json() as { approvalMode: unknown }).approvalMode).toBe(approvalMode);
}

/** The owner picks a model and/or an effort over REST: 200. */
export async function choose(
  world: World,
  body: { modelId?: string; reasoningEffort?: string; approvalMode?: Mode },
): Promise<void> {
  const response = await patch(world, body);
  expect([response.statusCode, response.json()]).toEqual([200, expect.objectContaining(body)]);
}

/** The session's file, epoch, spawn count and live process count, as one comparable value. */
export function processOf(world: World) {
  const { db, supervisor } = world.fixture;
  return {
    file: sessionFile(db, world.session),
    epoch: epochOf(db, world.session),
    spawns: world.rt.calls.length,
    live: supervisor.liveProcessCount(),
  };
}

/**
 * Holds the `exit`/`close` events of the world's first child (wrapped before any spawn), so its
 * retirement stays pending until `release()`.
 */
export function holdFirstExit(world: World): { held(): number; release(): void } {
  let hold: ReturnType<typeof holdExitEvents> | undefined;
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const child = inner(command, args, options);
    hold ??= holdExitEvents(child);
    return child;
  };
  return { held: () => hold?.held() ?? 0, release: () => hold?.release() };
}
