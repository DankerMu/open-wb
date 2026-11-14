/**
 * Change kb-search-approval-scope D2/D3 (#2011): omp-runtime「`kb_search` 的注册」 scenario「注册冲突」
 * and chat-sessions「派发前按会话设置对齐进程」 scenario「注册冲突时 regenerate 不动分支」.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (session-regenerate-helpers' `openRegenWorld`), the owner's definition from a stub session search.
 * `WORKBUDDY_FAKE_CONFLICT_PREFIX` reaches the child through the test's spawn wrapper: the production
 * spawn env is a closed allowlist (spawn-env.ts), so it never passes through on its own.
 * Oracles: the HTTP response, the child's stdin and stdout frames, SQLite rows, the assembly's log
 * records, `onError` and the published events. Expected bodies are the specs' literals; the omp error
 * text each case checks for is the one the child actually wrote on stdout.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { REAL, spawnedAt } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { forkWorlds, messagesOf } from "./session-fork-helpers.js";
import {
  answered,
  openRegenWorld,
  type RegenWorld,
  sendPrompt,
  snapshot,
  stubSearch,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";

const worlds = forkWorlds();
const CONFLICT = 'RPC host tool "kb_search" conflicts with an existing tool';
const KB_TOOL_CONFLICT_ENVELOPE = {
  error: {
    code: "kb_tool_conflict",
    message:
      "工作空间里有同名的项目工具 kb_search（.omp/tools），与知识库检索冲突，改名或移除后再试",
  },
};

interface ConflictWorld {
  world: RegenWorld;
  stub: ReturnType<typeof stubSearch>;
  records: unknown[];
}

/** A world on `scenario` whose children get `env` on top of the production spawn env. */
async function openConflictWorld(
  scenario: string,
  env: Record<string, string>,
  bases = [{ id: "k1", name: "产品文档" }],
): Promise<ConflictWorld> {
  const stub = stubSearch(bases);
  const records: unknown[] = [];
  const record = (entry: unknown) => {
    records.push(entry);
  };
  const world = worlds.track(
    await openRegenWorld({
      scenario,
      assembly: { sessionSearch: stub.source, log: record },
    }),
  );
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) =>
    inner(command, args, { ...options, env: { ...options.env, ...env } });
  return { world, stub, records };
}

/** The `error` of the one `set_host_tools` answer the n-th child wrote on stdout. */
function refusalOf(world: RegenWorld, index: number): unknown {
  const answers = (world.replies[index] ?? []).filter(
    (frame: OmpFrame) => frame.type === "response" && frame.command === "set_host_tools",
  );
  expect(answers).toHaveLength(1);
  expect(answers[0]?.success).toBe(false);
  return answers[0]?.error;
}

/** Everything the host put out besides the child's stdin: none of it carries omp's text. */
function expectNoLeak(
  { world, records }: ConflictWorld,
  responseBody: string,
  ompError: string,
): void {
  const audits = world.fixture.db.prepare("SELECT * FROM audit_events").all();
  const surfaces = {
    response: responseBody,
    log: JSON.stringify(records),
    onError: world.errors.map((error) => `${inspect(error)} ${JSON.stringify(error)}`).join("\n"),
    audit: JSON.stringify(audits),
    sse: JSON.stringify(world.events),
  };
  for (const [surface, text] of Object.entries(surfaces)) {
    expect(text.includes(ompError), surface).toBe(false);
    expect(text.includes("conflicts with an existing tool"), surface).toBe(false);
  }
}

describe("注册冲突 (omp-runtime「`kb_search` 的注册」)", () => {
  it.each([
    ["host-tool-register-conflict", {}, CONFLICT, 409, KB_TOOL_CONFLICT_ENVELOPE],
    [
      "host-tool-register-conflict",
      { WORKBUDDY_FAKE_CONFLICT_PREFIX: "x" },
      `x${CONFLICT}`,
      502,
      AGENT_UNAVAILABLE_ENVELOPE,
    ],
    ["host-tool-register-fail", {}, "host tools rejected", 502, AGENT_UNAVAILABLE_ENVELOPE],
  ])(
    "%s %o: omp's error %s → %i; compensated, no prompt frame, slot retired, omp's text nowhere",
    REAL,
    async (scenario, env, ompError, status, envelope) => {
      const opened = await openConflictWorld(scenario, env);
      const { world } = opened;
      const { db, supervisor } = world.fixture;

      const response = await sendPrompt(world);

      expect([response.statusCode, response.json()]).toEqual([status, envelope]);
      expect(response.body).toBe(JSON.stringify(envelope));
      expect(refusalOf(world, 0)).toBe(ompError);
      expect(messagesOf(db, world.session)).toEqual([]);
      expect(snapshot(db, world.session).session).toMatchObject({ status: "idle" });
      const sent = types(spawnedAt(world, 0).stdin);
      expect(sent).not.toContain("prompt");
      expect(sent.at(-1)).toBe("set_host_tools");
      await waitDead(world, 0);
      expect(supervisor.liveProcessCount()).toBe(0);
      expectNoLeak(opened, response.body, ompError);
    },
  );

  it(
    "每次都重新 spawn 再试：第二条 prompt 起新进程、再注册、再 409，不缓存冲突",
    REAL,
    async () => {
      const opened = await openConflictWorld("host-tool-register-conflict", {});
      const { world } = opened;

      for (const index of [0, 1]) {
        const response = await sendPrompt(world);
        expect([response.statusCode, response.json()]).toEqual([409, KB_TOOL_CONFLICT_ENVELOPE]);
        expect(refusalOf(world, index)).toBe(CONFLICT);
        await waitDead(world, index);
      }
      expect(world.rt.calls).toHaveLength(2);
    },
  );
});

describe("注册冲突时 regenerate 不动分支 (chat-sessions「派发前按会话设置对齐进程」)", () => {
  it(
    "409 kb_tool_conflict，没有 get_branch_messages 与 branch，行不变，slot 被退役",
    REAL,
    async () => {
      const opened = await openConflictWorld("host-tool-register-conflict", {}, []);
      const { world, stub } = opened;
      const { db, supervisor } = world.fixture;
      await answered(world);
      const first = spawnedAt(world, 0);
      expect(types(first.stdin)).not.toContain("set_host_tools");
      stub.bases.push({ id: "k1", name: "产品文档" });
      const before = snapshot(db, world.session);
      const sent = first.stdin.length;

      const response = await postSessionAction(
        world.fixture.app,
        "regenerate",
        world.session,
        world.cookie,
      );

      expect([response.statusCode, response.json()]).toEqual([409, KB_TOOL_CONFLICT_ENVELOPE]);
      expect(types(first.stdin.slice(sent))).toEqual(["set_host_tools"]);
      expect(snapshot(db, world.session)).toEqual(before);
      await waitDead(world, 0);
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(supervisor.controlHeld(world.session)).toBe(false);
      expectNoLeak(opened, response.body, CONFLICT);
    },
  );
});
