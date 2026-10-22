/**
 * Issue #1648 (s1d-model-registry task 6.2, design D19): chat-sessions Scenario「真实 omp 对未加载模型的
 * set_model」 against the official omp v18.12.3 binary, in the world of support/omp-official.ts.
 *
 * The process starts on a managed `models.yml` that holds only `M1` (the production writer,
 * `writeManagedModelsYml`); after the spawn the host rewrites the file with the same writer to hold
 * `M1` and `M2` — what model-registry「变更即发布」 does on a registration — and then asks, in order:
 * `get_available_models` (is `M2` listed?), `set_model{provider:"workbuddy", modelId: M2}` and
 * `get_state` (which model does the process report?). `runtime.command()` drops a refused answer's
 * content, so the raw `response` frame is read from the child's stdout tee, matched by the `id` the
 * runtime wrote on stdin for that `set_model`. "Accepted" = `success` true and `get_state` on
 * `workbuddy/M2`; then the next turn's upstream requests must name `M2`.
 *
 * The contrast: the same session resumed by a fresh spawn on the two-model file, where the same
 * `set_model` must succeed — the entry is sound and only the process that started without it
 * refuses it.
 *
 * First run (2026-10-22, darwin-arm64, v18.12.3), frozen below: refused. `get_available_models`
 * lists only `M1` (also after a 2 s wait: no hot reload of `models.yml`); the raw response is
 * `{"id":"rt-3","type":"response","command":"set_model","success":false,
 * "error":"Model not found: workbuddy/workbuddy-registered-later"}`; `get_state` afterwards reports
 * `workbuddy/deepseek-v4.1-flash`, the process survives and its next turn asks the upstream for
 * `M1` only; the fresh spawn takes `M2`.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-model-set.test.ts --coverage=false --reporter=verbose
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import {
  OMP_TEST_OFF,
  OMP_VERSION,
  officialBin,
  onTeardown,
  openOfficialWorld,
  teeStdoutFrames,
} from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

const CASE = { timeout: 180_000 };
const PROVIDER = "workbuddy";
/** The world's argv `--model` and the only entry of the file the process starts on. */
const M1 = "deepseek-v4.1-flash";
/** Registered after the spawn; unknown to omp's built-in catalog. */
const M2 = "workbuddy-registered-later";
/** How long the host waits after the rewrite before it asks. */
const WATCH_MS = 2_000;
const ENTRY = { reasoning: false, vision: false, maxTokens: 32768 };

function note(label: string, value: unknown): void {
  console.log(`[model-set] ${JSON.stringify({ [label]: value })}`);
}

/** Every JSONL frame a child read on stdin, in write order. */
function teeStdinFrames(child: ReturnType<SpawnImpl>, into: OmpFrame[]): void {
  const write = child.stdin.write.bind(child.stdin) as (...args: unknown[]) => boolean;
  (child.stdin as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    for (const line of String(args[0]).split("\n")) {
      if (line.trim() !== "") {
        into.push(JSON.parse(line) as OmpFrame);
      }
    }
    return write(...args);
  };
}

describe.skipIf(OMP_TEST_OFF)(
  `official omp v${OMP_VERSION}: set_model to a model registered after spawn`,
  () => {
    it(
      "get_available_models, the raw set_model response and get_state after models.yml gains a model the process did not start with",
      CASE,
      async () => {
        const world = await openOfficialWorld(() => {});
        const proxyBaseUrl = `http://127.0.0.1:${String(world.upstream.port)}/v1`;
        const stdin: OmpFrame[] = [];
        const stdout: OmpFrame[] = [];
        const spawnImpl: SpawnImpl = (command, args, options) => {
          const child = (spawn as SpawnImpl)(command, args, options);
          teeStdinFrames(child, stdin);
          teeStdoutFrames(child.stdout, (frame) => stdout.push(frame));
          return child;
        };
        const open = (resumePath: string | null): SessionRuntime => {
          const runtime: SessionRuntime = new SessionRuntime({
            sessionId: "omp-official-model-set",
            bin: officialBin(),
            sandboxRoot: world.sandboxRoot,
            stateDir: world.stateDir,
            ownerId: "u1",
            cwd: world.workspaceRoot,
            modelId: M1,
            approvalMode: "write",
            tokens: { issue: () => "fake", revoke: () => {} },
            resumePath,
            spawnImpl,
            onApproval: (request) => runtime.respondApproval(request.id, "allow"),
          });
          onTeardown(() => runtime.shutdown());
          return runtime;
        };
        const runtime = open(null);

        // The spawn: omp reads the one-model file now.
        const started = (await runtime.command({ type: "get_state" })) as {
          model?: { id?: unknown };
        };
        note("get_state at spawn", started.model?.id ?? null);

        // The registration, published with the production writer after the spawn.
        await writeManagedModelsYml(world.agentDir, {
          proxyBaseUrl,
          models: [
            { id: M1, name: M1, ...ENTRY },
            { id: M2, name: M2, ...ENTRY },
          ],
        });

        // Room for a debounced file watcher, were there one.
        await delay(WATCH_MS);
        const available = (await runtime.command({ type: "get_available_models" } as never)) as {
          models: Array<{ provider?: unknown; id?: unknown }>;
        };
        const listed = available.models
          .filter((model) => model.provider === PROVIDER)
          .map((model) => String(model.id));
        note("get_available_models: workbuddy ids", listed);

        const accepted = await runtime
          .command({ type: "set_model", provider: PROVIDER, modelId: M2 })
          .then(
            () => true,
            (error: unknown) => String(error),
          );
        const request = stdin.find((frame) => frame.type === "set_model");
        const response = stdout.find(
          (frame) => frame.type === "response" && frame.id === request?.id,
        );
        note("set_model request", request);
        note("set_model response", response);
        note("runtime.command outcome", accepted);

        const after = (await runtime.command({ type: "get_state" })) as {
          model?: { provider?: unknown; id?: unknown };
        };
        const model = `${String(after.model?.provider)}/${String(after.model?.id)}`;
        note("get_state after set_model", model);

        const from = world.upstream.requests().length;
        const turn = await collectPrompt(runtime.prompt("下一回合"));
        const upstreamModels = world.upstream
          .requests()
          .slice(from)
          .map((entry) => entry.model);
        note("next turn: last frame", turn.at(-1)?.type);
        note("next turn: upstream models", upstreamModels);

        // Contrast: a fresh spawn on the same two-model file takes `M2` — the entry is sound, only
        // the process that started without it refuses it.
        const sessionFile = runtime.sessionFile;
        expect(sessionFile).toEqual(expect.any(String));
        await runtime.shutdown();
        const respawned = open(sessionFile ?? null);
        await respawned.command({ type: "set_model", provider: PROVIDER, modelId: M2 });
        const resumedState = (await respawned.command({ type: "get_state" })) as {
          model?: { provider?: unknown; id?: unknown };
        };
        const respawnedModel = `${String(resumedState.model?.provider)}/${String(resumedState.model?.id)}`;
        note("respawn: get_state after set_model", respawnedModel);

        expect(started.model?.id).toBe(M1);
        expect(request).toMatchObject({ type: "set_model", provider: PROVIDER, modelId: M2 });
        // Frozen from the first run (2026-10-22, darwin-arm64): refused, the process stays on `M1`.
        expect(listed).toEqual([M1]);
        expect(response).toEqual({
          id: request?.id,
          type: "response",
          command: "set_model",
          success: false,
          error: `Model not found: ${PROVIDER}/${M2}`,
        });
        expect(accepted).toBe("AgentUnavailableError: set_model failed");
        expect(model).toBe(`${PROVIDER}/${M1}`);
        expect(turn.at(-1)?.type).toBe("agent_end");
        expect(upstreamModels.length).toBeGreaterThan(0);
        expect(new Set(upstreamModels)).toEqual(new Set([M1]));
        expect(respawnedModel).toBe(`${PROVIDER}/${M2}`);
      },
    );
  },
);
