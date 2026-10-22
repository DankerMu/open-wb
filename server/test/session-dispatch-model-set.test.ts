/**
 * Issue #1648 (s1d-model-registry task 6.2, design D19): chat-sessions「派发前按会话设置对齐进程」 step 1's
 * model set — a live process retires and respawns before a dispatch whose effective model was
 * registered after its spawn (omp reads `models.yml` at spawn only; the official refusal is pinned
 * in `omp-official-model-set.test.ts`), and a deletion never restarts it. Scenario「新登记的模型使存活
 * 进程重启」.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (`branch`), with `assembly.models` a real registry (`createRegistry` over `createModelStore`)
 * driven by store writes + `refresh()`, as the admin endpoints will. The registry sits on its own
 * in-memory database: nothing on the dispatch path reads the app database's `models` table.
 * Oracles: the recorded spawn argv, Node's own exit state of each child, per-child stdin frames,
 * `stream_epoch` and the session row; never supervisor internals.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { flagValue, REAL, spawnedAt } from "./session-approval-helpers.js";
import { choose, processOf } from "./session-composer-helpers.js";
import { forkWorlds, openForkWorld } from "./session-fork-helpers.js";
import { answered, types } from "./session-regenerate-helpers.js";
import { requiredCall } from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";

const worlds = forkWorlds();

/** A registry holding `ids`, the first one the default (the store makes the first row default). */
function registryOf(...ids: string[]) {
  const store = createModelStore(openDb(":memory:"));
  for (const id of ids) {
    store.create({ id });
  }
  const registry = createRegistry(store);
  registry.refresh();
  return { store, registry };
}

/** The `set_model` frames a child read on stdin, by model id. */
function setModels(stdin: readonly OmpFrame[]): unknown[] {
  return stdin.filter((frame) => frame.type === "set_model").map((frame) => frame.modelId);
}

function rawModel(world: Awaited<ReturnType<typeof openForkWorld>>): unknown {
  return world.fixture.db
    .prepare("SELECT model_id FROM chat_sessions WHERE id = ?")
    .get(world.session)?.model_id;
}

describe("派发前按会话设置对齐进程：模型集合 (chat-sessions, design D19)", () => {
  it(
    "新登记并设为缺省的模型：下一条 prompt 先退役再以 --model workbuddy/m2 spawn，epoch 恰加一，新进程在 prompt 前收到 set_model m2；第三条不再重启",
    REAL,
    async () => {
      const { store, registry } = registryOf("m1");
      const world = worlds.track(await openForkWorld({ assembly: { models: registry } }));
      expect(rawModel(world)).toBeNull();
      await answered(world);
      const first = processOf(world);
      const old = spawnedAt(world, 0);
      expect(first).toMatchObject({ spawns: 1, live: 1 });
      expect(flagValue(requiredCall(world.rt.calls, 0).args, "--model")).toBe("workbuddy/m1");
      expect(isLive(old.child)).toBe(true);
      const oldFrames = old.stdin.length;

      store.create({ id: "m2" });
      store.setDefault("m2");
      registry.refresh();
      await answered(world);

      // The first child had exited when the second spawned: never two alive.
      expect(world.liveAtSpawn).toEqual([[], []]);
      expect(isLive(old.child)).toBe(false);
      // The retired process was never asked for a model it did not load.
      expect(old.stdin).toHaveLength(oldFrames);
      expect(flagValue(requiredCall(world.rt.calls, 1).args, "--model")).toBe("workbuddy/m2");
      const second = processOf(world);
      expect(second).toMatchObject({ epoch: first.epoch + 1, spawns: 2, live: 1 });
      const fresh = types(spawnedAt(world, 1).stdin);
      expect(fresh.indexOf("set_model")).toBeGreaterThan(-1);
      expect(fresh.indexOf("set_model")).toBeLessThan(fresh.indexOf("prompt"));
      expect(setModels(spawnedAt(world, 1).stdin)).toEqual(["m2"]);

      await answered(world);
      expect(processOf(world)).toEqual(second);
      expect(isLive(spawnedAt(world, 1).child)).toBe(true);
      expect(rawModel(world)).toBeNull();
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "删除会话所在的模型：不重启，进程在 prompt 前收到 set_model m1，会话行的 model_id 仍为 m2",
    REAL,
    async () => {
      const { store, registry } = registryOf("m1", "m2");
      const world = worlds.track(await openForkWorld({ assembly: { models: registry } }));
      await choose(world, { modelId: "m2" });
      await answered(world);
      const before = processOf(world);
      const child = spawnedAt(world, 0);
      expect(before).toMatchObject({ spawns: 1, live: 1 });
      expect(setModels(child.stdin)).toEqual(["m2"]);
      const frames = child.stdin.length;

      store.remove("m2");
      registry.refresh();
      await answered(world);

      expect(processOf(world)).toEqual(before);
      expect(isLive(child.child)).toBe(true);
      const turn = child.stdin.slice(frames);
      expect(setModels(turn)).toEqual(["m1"]);
      expect(types(turn).indexOf("set_model")).toBeLessThan(types(turn).indexOf("prompt"));
      expect(rawModel(world)).toBe("m2");
      expect(world.errors).toEqual([]);
    },
  );
});
