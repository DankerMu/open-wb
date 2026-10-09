/**
 * Issue #1009 (s1g-composer-capabilities task 9.1, design D2/D5): a dispatch aligns the session's
 * process with its composer settings — the mode half. Every spawn takes the session's EFFECTIVE
 * mode and model (the raw columns clamped by the cap and the whitelist), and a live process started
 * under another mode is retired before the dispatch spawns its successor.
 * chat-sessions「派发前按会话设置对齐进程」, session-permission-tier「档位进入 argv」「换档从下一条消息起生效」
 * 「调低上界后既有会话被夹取」 and turn-control「档位不同时先退役再重新生成」; the fork argv is in
 * `session-fork-metadata.test.ts`, the `always-ask` approval flow in `session-approvals.test.ts`.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (`branch` unless a case says otherwise), a real in-memory SQLite and the injected clock, driven
 * over REST. A mode REST would refuse (`yolo` under a `write` cap) is planted by SQL. Oracles: the
 * recorded spawn argv, Node's own exit state of each child at every spawn, per-child stdin frames,
 * `stream_epoch`, SQLite rows and the published events; never supervisor internals.
 * The model and effort commands before a prompt are task 9.2: until then a process started for a
 * regenerate receives `get_branch_messages` first.
 */
import { mkdirSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auditCount, flagValue, REAL } from "./session-approval-helpers.js";
import { forkWorlds, openForkWorld } from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  answered,
  openRegenWorld,
  QUESTION,
  type RegenWorld,
  sendPrompt,
} from "./session-regenerate-helpers.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import { requiredCall, resumePath, waitForTurn } from "./session-supervisor-helpers.js";
import { postUndo, seedUndoable, undone } from "./session-undo-helpers.js";

const MODES = ["always-ask", "write", "yolo"] as const;

const worlds = forkWorlds();

function post(world: RegenWorld, url: string, body: unknown): Promise<LightMyRequestResponse> {
  return world.fixture.app.inject({
    method: "POST",
    url,
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function plant(world: RegenWorld, column: "approval_mode" | "model_id", value: string): void {
  const written = world.fixture.db
    .prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`)
    .run(value, world.session);
  expect(Number(written.changes)).toBe(1);
}

function rawMode(world: RegenWorld): unknown {
  return world.fixture.db
    .prepare("SELECT approval_mode FROM chat_sessions WHERE id = ?")
    .get(world.session)?.approval_mode;
}

/** The session view's `approvalMode`, read over the public snapshot. */
async function shownMode(world: RegenWorld): Promise<unknown> {
  const response = await getSessionMessages(world.fixture.app, world.session, world.cookie);
  expect(response.statusCode).toBe(200);
  return (response.json() as { session: { approvalMode: unknown } }).session.approvalMode;
}

/** `--approval-mode` of the n-th spawn. */
function modeOf(world: RegenWorld, index: number): string | undefined {
  return flagValue(requiredCall(world.rt.calls, index).args, "--approval-mode");
}

describe("档位进入 argv (session-permission-tier)", () => {
  it("三个档位的会话各自冷启动：argv 只差 --approval-mode 的取值", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    // The workspace store realpaths the sandbox root; one workspace gives the three one cwd.
    mkdirSync(world.rt.runtime.sandboxRoot, { recursive: true });
    const made = await post(world, "/api/workspaces", { name: "proj", dir: "proj" });
    expect(made.statusCode).toBe(201);
    const workspaceId = (made.json() as { id: string }).id;

    for (const approvalMode of MODES) {
      const created = await post(world, "/api/sessions", { workspaceId, approvalMode });
      expect(created.statusCode).toBe(201);
      const session = (created.json() as { id: string }).id;
      expect((await sendPrompt(world, QUESTION, session)).statusCode).toBe(202);
      await waitForTurn(world.fixture, session, "done");
    }

    expect(world.rt.calls).toHaveLength(3);
    const argvs = world.rt.calls.map((call) => call.args);
    const at = requiredCall(world.rt.calls, 0).args.indexOf("--approval-mode");
    expect(at).toBeGreaterThan(0);
    expect(argvs.map((args) => args[at + 1])).toEqual([...MODES]);
    const rest = argvs.map((args) => args.filter((_, index) => index !== at + 1));
    expect(rest[1]).toEqual(rest[0]);
    expect(rest[2]).toEqual(rest[0]);
    expect(rest[0]?.filter((arg) => arg === "--approval-mode")).toHaveLength(1);
    expect(rest[0]).not.toContain("--resume");
    expect(MODES.some((mode) => rest[0]?.includes(mode))).toBe(false);
  });
});

describe("调低上界后既有会话被夹取 (session-permission-tier「管理员最高档」)", () => {
  it(
    "上界 write 下的 yolo 行：两条 prompt 恰一次 spawn，argv 为 write，列值仍为 yolo，不写审计",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld({ assembly: { approvalMaxMode: "write" } }));
      plant(world, "approval_mode", "yolo");
      const audits = auditCount(world.fixture.db);

      expect(await shownMode(world)).toBe("write");
      await answered(world);
      await answered(world);

      expect(world.rt.calls).toHaveLength(1);
      expect(modeOf(world, 0)).toBe("write");
      expect(rawMode(world)).toBe("yolo");
      expect(await shownMode(world)).toBe("write");
      expect(auditCount(world.fixture.db)).toBe(audits);
    },
  );

  it("上界 always-ask 下三列为 NULL 的会话：视图与 argv 都是 always-ask", REAL, async () => {
    const world = worlds.track(
      await openRegenWorld({ assembly: { approvalMaxMode: "always-ask" } }),
    );
    expect(rawMode(world)).toBeNull();

    await answered(world);

    expect(world.rt.calls).toHaveLength(1);
    expect(modeOf(world, 0)).toBe("always-ask");
    expect(await shownMode(world)).toBe("always-ask");
    expect(rawMode(world)).toBeNull();
  });
});

describe("撤回的临时进程 (message-undo; the spec names no argv scenario)", () => {
  it(
    "以该会话的有效档位与有效模型启动：yolo 与 workbuddy/m3，--resume 会话文件",
    REAL,
    async () => {
      const world = worlds.track(
        await openForkWorld({ assembly: { modelCatalog: THREE_MODEL_CATALOG } }),
      );
      const { u2, file } = seedUndoable(world);
      plant(world, "approval_mode", "yolo");
      plant(world, "model_id", "m3");

      undone(await postUndo(world, u2));

      expect(world.rt.calls).toHaveLength(1);
      const { args } = requiredCall(world.rt.calls, 0);
      expect([flagValue(args, "--approval-mode"), flagValue(args, "--model")]).toEqual([
        "yolo",
        "workbuddy/m3",
      ]);
      expect(resumePath(args)).toBe(file);
    },
  );
});
