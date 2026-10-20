/**
 * Issue #1522 (epic-acceptance-followups 2.2, design D3): model-proxy Scenario「maxTokens reaches the
 * upstream request」on the official omp v18.12.3 binary. `models.yml` comes from the writer (the
 * world's `maxTokens` option); no compaction is planted, so the record holds this turn only: the
 * bash tool round (default `toolRoundScope`, denied by the world) and the answer.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-max-tokens.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION, openOfficialWorld } from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: maxTokens from models.yml`, () => {
  it.each([32768, 8192])(
    "every upstream request of one prompt turn carries maxTokens %i",
    async (maxTokens) => {
      const world = await openOfficialWorld(() => {}, { maxTokens });
      await collectPrompt(world.runtime.prompt("跑一个命令"));
      const records = world.upstream.requests();
      console.log(`[max-tokens] ${JSON.stringify({ written: maxTokens, records })}`);

      expect(world.approvals).toHaveLength(1);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.maxTokens)).toEqual([maxTokens, maxTokens]);
    },
    120_000,
  );
});
