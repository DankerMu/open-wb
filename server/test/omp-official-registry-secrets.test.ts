/**
 * s1d-model-registry group 5 (task 5.2, design D18): upstream-failure「注册表登记的密钥不进会话」with the
 * official omp binary — the proxied app world of `support/omp-official-proxied.ts` with its `registry`
 * option, so the proxy and createApp share one real registry on the app's database and createApp has no
 * `assembly.upstream` (the production assembly since group 5). The fake upstream expects the registered
 * sentinel key and its `secret` body echoes it on the scripted 401. The CI-runnable proof of the same
 * scenario is `session-registry-redaction.test.ts`; this file is the real-binary proof on this machine.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-registry-secrets.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import { start } from "./support/fake-upstream.mjs";
import { OMP_TEST_OFF, OMP_VERSION, onTeardown } from "./support/omp-official.js";
import {
  type AppTurn,
  openProxiedApp,
  PROXIED_MODELS,
  type ProxiedApp,
  runAppTurn,
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 120_000 };
/** Low-entropy sentinels: no `sk-` prefix, so only the registry's secret list can remove them. */
const KEY_ONE = "wb-issue1647-official-key-one";
const KEY_TWO = "wb-issue1647-official-key-two";
const MARKED = "你好 WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret";

/** Everything the browser and the operator can read of `turn`: events, the stored row, the snapshot, the log. */
async function readable(world: ProxiedApp, turn: AppTurn): Promise<string[]> {
  const snapshot = await world.app.inject({
    method: "GET",
    url: `/api/sessions/${turn.session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(snapshot.statusCode).toBe(200);
  const list = await world.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  const stored = world.db
    .prepare("SELECT error_detail FROM chat_messages WHERE session_id = ? AND role = 'assistant'")
    .get(turn.session);
  return [
    JSON.stringify(turn.events),
    JSON.stringify(stored),
    snapshot.payload,
    list.payload,
    JSON.stringify(world.log),
  ];
}

/** The turn failed as an auth failure whose detail had the echoed key removed. */
function expectRedactedAuthFailure(turn: AppTurn): void {
  const errors = turn.events.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  const data = (errors[0]?.data ?? {}) as { detail?: unknown };
  expect(data).toMatchObject({ reason: "auth_failed", status: 401 });
  expect(String(data.detail)).toContain("rejected key [已移除]");
  expect(turn.events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "failed" } });
}

function update(world: ProxiedApp, upstream: { baseUrl: string; apiKey: string }): void {
  const models = world.models;
  if (models === undefined) {
    throw new Error("the world was opened without the shared registry");
  }
  models.store.update(PROXIED_MODELS[0], {
    name: PROXIED_MODELS[0],
    reasoning: false,
    vision: false,
    maxTokens: 32768,
    upstream,
  });
  models.registry.refresh();
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} with the shared model registry`, () => {
  it(
    "a registered key echoed by an upstream 401 reaches no event, row, view or log",
    CASE,
    async () => {
      const world = await openProxiedApp({ registry: { apiKey: KEY_ONE } });

      const turn = await runAppTurn(world, MARKED);

      expectRedactedAuthFailure(turn);
      expect(world.upstream.requests()).toHaveLength(1);
      for (const text of await readable(world, turn)) {
        expect(text).not.toContain(KEY_ONE);
      }
      expect(world.faults).toEqual([]);
    },
  );

  it(
    "after the model is moved to a second upstream instance, its key is removed too",
    CASE,
    async () => {
      const world = await openProxiedApp({ registry: { apiKey: KEY_ONE } });
      const first = await runAppTurn(world, MARKED);
      expectRedactedAuthFailure(first);

      const second = await start({ apiKey: KEY_TWO });
      onTeardown(() => second.close());
      update(world, { baseUrl: `http://127.0.0.1:${String(second.port)}/v1`, apiKey: KEY_TWO });
      const turn = await runAppTurn(world, MARKED);

      expectRedactedAuthFailure(turn);
      expect(world.upstream.requests()).toHaveLength(1);
      expect(second.requests()).toHaveLength(1);
      for (const text of await readable(world, turn)) {
        expect(text).not.toContain(KEY_ONE);
        expect(text).not.toContain(KEY_TWO);
      }
      expect(world.faults).toEqual([]);
    },
  );
});
