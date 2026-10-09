/**
 * Issue #985 (s1g tasks 1.4, 1.5): model and effort commands checked against the official omp
 * v18.0.10 binary — model-selection Scenario「真实 omp 上的模型与强度」, design D8 checks (a)–(e), the
 * two D7 checks and D18 check (f), in the world of support/omp-official.ts. The managed
 * `models.yml` is hand-written with two models (the multi-model writer is s1g group 3, which waits
 * for these results). The oracles are omp's own RPC answers (`get_available_models`, `get_state`),
 * the files under the managed `HOME`, and the fake upstream's request record (`requests()`: the
 * `model` and message count of every request omp sent).
 *
 * One case, because the steps build on each other: the first turn of the fresh session is the tool
 * round (the fake upstream opens with a tool call only while the request holds no tool result), the
 * post-switch turn must carry that history (so no `freshToolRounds` here: its forwarder trims the
 * history), and `/compact` needs both behind it. The expectation tables were filled from the first
 * run and frozen; every observed value is also printed as a `[model-commands] ` line, which is what
 * s1g task 1.6 transcribes from the CI log.
 *
 * Run locally: `make omp-fetch` (fetches the official v18.0.10 binary), then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-approval-modes.test.ts \
 *     test/omp-official-model-commands.test.ts --coverage=false
 * (`OMP_BIN` is the binary's path, `var/omp/omp` under the repository root by default; it must be
 * absolute, because omp is spawned with the temporary workspace as its cwd, and it is the only
 * source of the binary: an `omp` on PATH is never used.) Without `WORKBUDDY_OMP_TEST=1` the whole
 * file is skipped — also under `make test` — so a green local `make check` does not mean these
 * checks ran: the output of the CI uid-isolation job is the authority. When an omp upgrade turns
 * the case red, the spec changes first.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeCommandFrame } from "../src/sessions/omp/commands.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SessionRuntime } from "../src/sessions/omp/runtime.js";
import type { FakeUpstreamRequest } from "./support/fake-upstream.mjs";
import { OMP_TEST_OFF, OMP_VERSION, openOfficialWorld } from "./support/omp-official.js";
import { collectPrompt } from "./support/omp-runtime.js";

/** `/compact` answers its prompt first and reports late: the runtime waits up to 120 s for it. */
const CASE = { timeout: 480_000 };
const PROVIDER = "workbuddy";
/** The world's argv `--model`; in `models.yml` it declares `reasoning: true` and nothing else. */
const PLAIN = "deepseek-v4.1-flash";
/** The second model: `thinking` with two efforts, and image input. */
const EFFORT = "workbuddy-second";
const ALLOWED = [PLAIN, EFFORT];
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
/** Set on the first model before the switch: does `set_model` carry the level over or reset it? */
const CARRIED_LEVEL = "off";
/** Left on the second model after its table, so the resumed `get_state` has something to keep. */
const LEFT_LEVEL = "low";

type Row = [level: string, observed: unknown];

/** The managed `models.yml` of this case, in the format of `src/model-proxy/models-yml.ts`. */
function modelsYml(proxyBaseUrl: string): string {
  return [
    "providers:",
    `  ${PROVIDER}:`,
    "    api: openai-completions",
    `    baseUrl: ${JSON.stringify(proxyBaseUrl)}`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    `      - id: ${JSON.stringify(PLAIN)}`,
    `        name: ${JSON.stringify(PLAIN)}`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "        reasoning: true",
    "        compat:",
    "          reasoningContentField: reasoning_content",
    `      - id: ${JSON.stringify(EFFORT)}`,
    `        name: ${JSON.stringify(EFFORT)}`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "        reasoning: true",
    "        compat:",
    "          reasoningContentField: reasoning_content",
    "        thinking:",
    "          mode: effort",
    "          efforts: [low, high]",
    "        input: [text, image]",
    "",
  ].join("\n");
}

/** Primary means of task 1.4: the keep zone is one token, and only `soft` asks the upstream. */
function plantCompaction({ workspaceRoot }: { workspaceRoot: string }): void {
  mkdirSync(join(workspaceRoot, ".omp"));
  writeFileSync(
    join(workspaceRoot, ".omp", "config.yml"),
    "compaction:\n  keepRecentTokens: 1\n  methodOrder: [soft]\n",
  );
}

/** One observed value as a single log line; the CI job log is where task 1.6 reads them. */
function note(label: string, value: unknown): void {
  console.log(`[model-commands] ${JSON.stringify({ [label]: value })}`);
}

function rpc(runtime: SessionRuntime, frame: RuntimeCommandFrame): Promise<unknown> {
  return runtime.command(frame);
}

async function state(runtime: SessionRuntime): Promise<{ model: unknown; level: unknown }> {
  const data = (await runtime.command({ type: "get_state" })) as {
    model?: { provider?: unknown; id?: unknown };
    thinkingLevel?: unknown;
  };
  return {
    model: [data.model?.provider ?? null, data.model?.id ?? null],
    level: data.thinkingLevel ?? null,
  };
}

/**
 * `set_thinking_level` for each of the eight values, then what `get_state` reports. A refused
 * command is an outcome (`rejected`), and the process must still answer `get_state` after it.
 */
async function levelTable(runtime: SessionRuntime): Promise<Row[]> {
  const rows: Row[] = [];
  for (const level of LEVELS) {
    const accepted = await rpc(runtime, { type: "set_thinking_level", level }).then(
      () => true,
      () => false,
    );
    const after = await state(runtime);
    rows.push([level, accepted ? after.level : "rejected"]);
  }
  return rows;
}

/** The entries of the managed provider in `get_available_models`, keyed by id. */
async function managedModels(
  runtime: SessionRuntime,
): Promise<Map<unknown, Record<string, unknown>>> {
  // The host never sends this command, so the runtime's frame union does not carry it.
  const data = (await runtime.command({ type: "get_available_models" } as never)) as {
    models: Array<Record<string, unknown>>;
  };
  note(
    "get_available_models: provider/id of every entry",
    data.models.map((model) => `${String(model.provider)}/${String(model.id)}`),
  );
  const managed = data.models.filter((model) => model.provider === PROVIDER);
  return new Map(managed.map((model) => [model.id, model]));
}

/** `path → sha256` of every regular file under `root`, paths relative to it. */
function digests(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      found[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return found;
}

/**
 * Observation only: omp's own runtime state (`xdg/`, outside the managed `HOME`) as digests, or the
 * reason it could not be read. Its write-ahead logs make a byte comparison unfit for an assertion.
 */
function ownState(stateDir: string): Record<string, string> {
  try {
    return digests(join(stateDir, "xdg"));
  } catch (error) {
    return { unreadable: String((error as { code?: unknown }).code) };
  }
}

function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = Object.keys({ ...before, ...after }).sort();
  return paths.filter((path) => before[path] !== after[path]);
}

function commandOutput(frames: OmpFrame[]): string[] {
  return frames
    .filter((frame) => frame.type === "command_output")
    .map((frame) => String(frame.text));
}

const models = (requests: FakeUpstreamRequest[]) => requests.map((request) => request.model);
const counts = (requests: FakeUpstreamRequest[]) => requests.map((request) => request.messages);

/**
 * Frozen from the first run (2026-10-07, darwin-arm64): what omp does, not what the spec hoped for.
 * `get_available_models` gives the `reasoning: true`-only entry an effort set of its own, and
 * `set_thinking_level` never refuses a value: it reports the nearest declared effort at or below the
 * one asked for (else the lowest), and `auto` comes back as `high`.
 */
const PLAIN_THINKING = { mode: "effort", efforts: ["low", "high", "max"] };
const PLAIN_TABLE: Row[] = [
  ["off", "off"],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "low"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "max"],
  ["auto", "high"],
];
const EFFORT_TABLE: Row[] = [
  ["off", "off"],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "low"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "high"],
  ["auto", "high"],
];
/** Frozen: the resumed process is on the argv `--model` again, with the level the session had. */
const RESUMED = { model: [PROVIDER, PLAIN], level: LEFT_LEVEL };

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: model and effort commands`, () => {
  it(
    "set_model and set_thinking_level take effect per session, leave the managed HOME alone, and every upstream request names a models.yml id — the tool round, the post-switch turn and /compact included",
    CASE,
    async () => {
      const world = await openOfficialWorld(plantCompaction, {
        modelsYml,
        onApproval: () => "allow",
      });
      const { runtime, upstream } = world;
      const home = dirname(dirname(world.agentDir));
      const stateDir = dirname(home);
      const step = async <T>(run: () => Promise<T>): Promise<[T, FakeUpstreamRequest[]]> => {
        const from = upstream.requests().length;
        const result = await run();
        return [result, upstream.requests().slice(from)];
      };

      // D7: what omp reports for the two hand-written entries.
      const listed = await managedModels(runtime);
      note("get_available_models: plain entry", listed.get(PLAIN));
      note("get_available_models: effort entry", listed.get(EFFORT));

      // (f) step 1: the first turn of the fresh session, which is the tool round.
      const [firstFrames, first] = await step(() => collectPrompt(runtime.prompt("跑一个命令")));
      note("step first turn (tool round)", { models: models(first), messages: counts(first) });
      note("first turn: requests beyond the two of a tool round", first.length - 2);

      // (b) on the starting model; (c) starts here, after omp wrote whatever a first turn writes.
      const started = await state(runtime);
      const before = digests(home);
      const ownBefore = ownState(stateDir);
      note("HOME files compared", Object.keys(before).sort());
      const [plainTable, plainSweep] = await step(() => levelTable(runtime));
      note("table plain model", plainTable);

      // (a), then (b) on the second model.
      await rpc(runtime, { type: "set_thinking_level", level: CARRIED_LEVEL });
      const switched = await rpc(runtime, {
        type: "set_model",
        provider: PROVIDER,
        modelId: EFFORT,
      });
      const afterSwitch = await state(runtime);
      note("set_model reply id", (switched as { id?: unknown } | null)?.id ?? null);
      note("get_state after set_model", afterSwitch);
      const [effortTable, effortSweep] = await step(() => levelTable(runtime));
      note("table effort model", effortTable);
      await rpc(runtime, { type: "set_thinking_level", level: LEFT_LEVEL });
      const left = await state(runtime);
      const after = digests(home);
      note("HOME files after the commands", Object.keys(after).sort());
      note(
        "omp's own state files that changed across the commands",
        changed(ownBefore, ownState(stateDir)),
      );

      // (d): the turn after the switch.
      const [secondFrames, second] = await step(() => collectPrompt(runtime.prompt("第二回合")));
      note("step post-switch turn", { models: models(second), messages: counts(second) });

      // (f): exactly one /compact; its delta is read after the turn ended on `command_output`.
      const [compactFrames, compact] = await step(() => collectPrompt(runtime.prompt("/compact")));
      const output = commandOutput(compactFrames);
      note("/compact command_output", output);
      note("step /compact", { models: models(compact), messages: counts(compact) });

      // (e): a new process on the same session file, no command before `get_state`.
      const resumed = await world.reopen();
      const [resumedState, resume] = await step(() => state(resumed.runtime));
      note("get_state after --resume", resumedState);
      note("step --resume", { models: models(resume), messages: counts(resume) });
      const all = upstream.requests();
      note("all requests", { count: all.length, models: [...new Set(models(all))] });

      // D7.
      expect(listed.get(EFFORT)?.thinking).toEqual({ mode: "effort", efforts: ["low", "high"] });
      expect(listed.get(EFFORT)?.input).toEqual(["text", "image"]);
      expect(listed.get(PLAIN)?.thinking).toEqual(PLAIN_THINKING);
      expect(listed.get(PLAIN)?.input).toEqual(["text"]);
      // The tool round ran, and nothing but turns reached the upstream.
      expect(firstFrames.at(-1)?.type).toBe("agent_end");
      expect(firstFrames.filter((frame) => frame.type === "tool_execution_end")).toHaveLength(1);
      expect(first.length).toBeGreaterThanOrEqual(2);
      expect([plainSweep, effortSweep, resume]).toEqual([[], [], []]);
      // (a)
      expect(started.model).toEqual([PROVIDER, PLAIN]);
      expect(afterSwitch).toEqual({ model: [PROVIDER, EFFORT], level: CARRIED_LEVEL });
      // (b)
      expect(plainTable).toEqual(PLAIN_TABLE);
      expect(effortTable).toEqual(EFFORT_TABLE);
      expect(left).toEqual({ model: [PROVIDER, EFFORT], level: LEFT_LEVEL });
      // (c)
      expect(Object.keys(before)).toEqual(expect.arrayContaining([".omp/agent/models.yml"]));
      expect(after).toEqual(before);
      // (d)
      expect(secondFrames.at(-1)?.type).toBe("agent_end");
      expect(models(second)).toEqual([EFFORT]);
      expect(second[0]?.messages).toBeGreaterThan(Math.max(...counts(first)));
      // (f), the three /compact conditions.
      expect(compact.length).toBeGreaterThanOrEqual(1);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain("Nothing to compact");
      expect(output[0]).not.toContain("Already compacted");
      for (const request of all) {
        expect(ALLOWED).toContain(request.model);
      }
      // (e), an observation frozen like the tables.
      expect(resumedState).toEqual(RESUMED);
    },
  );
});
