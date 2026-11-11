/**
 * Issue #909: 3.2, a session-cwd project layer asking for longer retries and a fallback model changes nothing.
 * Shared helpers, the case map and the local run command: support/omp-official-upstream.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedWorld, PROXIED_MODELS } from "./support/omp-official-proxied.js";
import {
  BEYOND_CAP,
  CAPPED,
  expectOneCappedRetry,
  messagesOf,
  note,
  runTurn,
} from "./support/omp-official-upstream.js";

/**
 * omp-runtime「会话级重试封顶一轮（真实 omp）」: a session-cwd project layer that would lengthen
 * the retries and switch to the second whitelisted model of the same provider.
 */
const PROJECT_RETRY = [
  "retry:",
  "  maxRetries: 10",
  "  baseDelayMs: 3600000",
  "  modelFallback: true",
  "  fallbackChains:",
  "    default:",
  `      - workbuddy/${PROXIED_MODELS[1]}`,
  "",
].join("\n");

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} through the model proxy`, () => {
  it(
    "3.2 a project layer asking for ten slow retries and a fallback model changes nothing",
    CAPPED,
    async () => {
      const world = await openProxiedWorld();
      mkdirSync(join(world.workspaceRoot, ".omp"));
      writeFileSync(join(world.workspaceRoot, ".omp", "config.yml"), PROJECT_RETRY);
      const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_STATUS=503", BEYOND_CAP);
      note(
        "cap-503-project-layer",
        turn,
        world.upstream.requests().length,
        messagesOf(world.upstream),
      );
      expectOneCappedRetry(turn, world);
    },
  );
});
