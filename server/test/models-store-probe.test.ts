/**
 * #1760 (change models-probe-identity; model-registry「探活」store part): `probeTarget` reads a row's
 * upstream and identity in one table read, and `recordProbe` writes only while the row is still that
 * identity — gone or recreated → `not_found` before `within`; upstream changed by a PUT → dropped,
 * `within` not run, the current row returned; other columns changed → written. `:memory:` databases
 * through the real migrations; expected values are literals and the table itself.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { resolveModelCatalog } from "../src/model-catalog.js";
import { createModelStore } from "../src/models/store.js";

const T0 = 1_760_000_000_000;
const KEY = "sk-store-SENTINEL-4242";
const UP = { baseUrl: "https://gw.example/v1", apiKey: KEY };
const USERINFO_URL = "https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001";
const BODY = { name: "改名", reasoning: true, vision: true, maxTokens: 100, efforts: ["high"] };
const NEVER = { status: "never", at: null, message: null } as const;

const opened: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) db.close();
});

function fresh() {
  const db = openDb(":memory:");
  opened.push(db);
  return { db, store: createModelStore(db) };
}

function rawRows(db: DatabaseSync) {
  return db.prepare("SELECT * FROM models ORDER BY created_at, id").all();
}

/** Asserts `action` throws `HttpError(code)` with its fixed message and leaves the table as it was. */
function expectRefused(db: DatabaseSync, code: HttpErrorCode, action: () => unknown): void {
  const before = rawRows(db);
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).code).toBe(code);
  expect((thrown as HttpError).message).toBe(HTTP_ERROR_MESSAGES[code]);
  expect(rawRows(db)).toEqual(before);
}

const seedOne = (store: ReturnType<typeof createModelStore>) => {
  store.create({ id: "m1", upstream: UP });
  store.create({ id: "m2" });
};

function targetOf(store: ReturnType<typeof createModelStore>, id: string) {
  const target = store.probeTarget(id);
  if (target === undefined) throw new Error(`no row ${id}`);
  return target;
}

describe("probeTarget and the identity-conditioned recordProbe", () => {
  it("probeTarget reads the upstream and the row identity raw: undefined / no upstream / userinfo", () => {
    const { store } = fresh();
    store.seedIfEmpty(resolveModelCatalog({}), { baseUrl: USERINFO_URL, apiKey: KEY });
    vi.setSystemTime(T0 + 3);
    store.create({ id: "bare" });
    const seeded = store.list()[0]?.id ?? "";
    expect(store.probeTarget("nope")).toBeUndefined();
    expect(store.probeTarget("bare")).toEqual({
      upstream: undefined,
      identity: { createdAt: T0 + 3, upstreamBaseUrl: null, upstreamApiKey: null },
    });
    expect(store.probeTarget(seeded)).toEqual({
      upstream: { baseUrl: USERINFO_URL, apiKey: KEY },
      identity: { createdAt: T0, upstreamBaseUrl: USERINFO_URL, upstreamApiKey: KEY },
    });
  });

  it("recordProbe after delete-and-recreate of the id is not_found before within, nothing written", () => {
    const { db, store } = fresh();
    seedOne(store);
    const { identity } = targetOf(store, "m2");
    store.remove("m2");
    vi.setSystemTime(T0 + 10);
    store.create({ id: "m2" });
    expect(store.get("m2")?.createdAt).toBe(T0 + 10);
    const within = vi.fn();
    expectRefused(db, "not_found", () =>
      store.recordProbe("m2", identity, { status: "ok", message: null, at: T0 + 11 }, within),
    );
    expect(within).not.toHaveBeenCalled();
    expect(store.get("m2")?.probe).toEqual(NEVER);
  });

  it.each([
    ["another base URL", { baseUrl: "https://moved.example/v1" }],
    ["a new key", { baseUrl: UP.baseUrl, apiKey: "sk-store-ROTATED-0001" }],
    ["no upstream", null],
  ])("recordProbe after a PUT to %s drops the result: current row, within not run", (_l, up) => {
    const { db, store } = fresh();
    seedOne(store);
    const { identity } = targetOf(store, "m1");
    vi.setSystemTime(T0 + 5);
    const current = store.update("m1", { ...BODY, upstream: up });
    const before = rawRows(db);
    const within = vi.fn();
    const row = store.recordProbe(
      "m1",
      identity,
      { status: "failed", message: "超时", at: T0 + 6 },
      within,
    );
    expect(row).toEqual(current);
    expect(row.probe).toEqual(NEVER);
    expect(within).not.toHaveBeenCalled();
    expect(rawRows(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it("recordProbe after a PUT that changes only other columns still writes and runs within", () => {
    const { store } = fresh();
    seedOne(store);
    const { identity } = targetOf(store, "m1");
    vi.setSystemTime(T0 + 5);
    store.update("m1", { ...BODY, upstream: { baseUrl: UP.baseUrl } });
    store.setDefault("m2");
    const within = vi.fn();
    const row = store.recordProbe(
      "m1",
      identity,
      { status: "ok", message: null, at: T0 + 6 },
      within,
    );
    expect(row).toMatchObject({ name: "改名", probe: { status: "ok", at: T0 + 6, message: null } });
    expect(within.mock.calls).toEqual([[row]]);
  });
});
