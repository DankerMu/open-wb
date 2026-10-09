/**
 * Issue #1006 (s1g-composer-capabilities task 8.3): `PATCH /api/sessions/:id` takes the three
 * composer settings — session-composer-settings「修改会话设置」(「修改并回显有效值」「运行中修改不触及在途回合」
 * 「非法取值与越过最高档」「隔离」), session-permission-tier「档位变更审计」(「修改与重复选择」「审计失败则修改不生效」),
 * the view half of「调低上界后既有会话被夹取」 and the PATCH part of chat-sessions「Session views carry the
 * three composer settings」.
 *
 * Every world but one is `session-composer-rest-helpers.ts`'s (production assembly, no omp child):
 * a session there is made `done` by SQL, and a raw column the cap or the catalog would refuse
 * (`yolo` under `write`, the model `gone`) is planted by SQL. 「运行中修改」 runs the same assembly over
 * a real fake-omp child held at a pending approval (`openApprovalWorld`); it does not send a second
 * prompt to count frames — once task group 9 lands, that prompt would restart the process.
 * Oracles: the spec's literals, whole SQL rows, `GET /api/audit` and the child's recorded stdin.
 */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import {
  approvalRows,
  openApprovalWorld,
  pendingApproval,
  REAL,
  spawnedAt,
} from "./session-approval-helpers.js";
import {
  ACCOUNT_ID,
  type Account,
  type Cap,
  composerOf,
  create,
  createWorkspace,
  expectBadRequest,
  footprint,
  openWorld,
  type PermissionAudit,
  permissionAudits,
  prefs,
  rawOf,
  type View,
  type World,
} from "./session-composer-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE, NOT_FOUND_ENVELOPE } from "./session-db-helpers.js";
import { SESSION_VIEW_KEYS, THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  getSessionMessages,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";

type PatchedView = View & { status: string; updatedAt: number };

function patchVia(
  app: FastifyInstance,
  cookie: string,
  sessionId: string,
  body: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}`,
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function patch(
  world: World,
  account: Account,
  sessionId: string,
  body: unknown,
): Promise<LightMyRequestResponse> {
  return patchVia(world.app, world.cookies[account], sessionId, body);
}

/** 200 + no-store + exactly the fourteen keys in wire order. */
function expectPatched(response: LightMyRequestResponse): PatchedView {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const view = response.json() as PatchedView;
  expect(Object.keys(view)).toEqual(SESSION_VIEW_KEYS);
  return view;
}

/** Every column of the session row, the three composer columns included. */
function rowOf(world: World, sessionId: string): Record<string, unknown> {
  return { ...world.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(sessionId) };
}

function plantRaw(world: World, sessionId: string, column: string, value: string): void {
  world.db.prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`).run(value, sessionId);
}

/** The audit of one PATCH that changed the effective mode of `view`'s session. */
function changedAs(account: Account, view: View, from: string, to: string): PermissionAudit {
  return {
    actor: ACCOUNT_ID[account],
    title: "修改权限档位",
    workspaceId: view.workspaceId,
    detail: { sessionId: view.id, from, to },
  };
}

/** The `session.permission` events `GET /api/audit` shows this account, oldest first. */
async function permissionEventsSeenBy(world: World, account: Account): Promise<unknown[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie: world.cookies[account] },
  });
  expect(response.statusCode).toBe(200);
  const { events } = response.json() as {
    events: Array<{ id: number; kind: string; [key: string]: unknown }>;
  };
  return events
    .filter((event) => event.kind === "session.permission")
    .sort((left, right) => left.id - right.id)
    .map(({ actorId, title, workspaceId, detail }) => ({ actorId, title, workspaceId, detail }));
}

describe("修改会话设置 (session-composer-settings)", () => {
  it("修改并回显有效值：六步各回显有效值，只写所给列；最近选择更新、恰一条审计，新会话沿用", async () => {
    const world = await openWorld();
    const session = await create(world, "zhangsan");
    world.db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(session.id);
    const before = rowOf(world, session.id);
    expect(before).toMatchObject({ approval_mode: null, model_id: null, reasoning_effort: null });

    const steps: Array<[Record<string, string>, unknown[], unknown[]]> = [
      [{ approvalMode: "yolo" }, ["yolo", "m1", "high"], ["yolo", null, null]],
      [{ modelId: "m3" }, ["yolo", "m3", "high"], ["yolo", "m3", null]],
      // xhigh 不在 m3 的可选强度内，照常受理并原样存储。
      [{ reasoningEffort: "xhigh" }, ["yolo", "m3", "xhigh"], ["yolo", "m3", "xhigh"]],
      [{ reasoningEffort: "low" }, ["yolo", "m3", "low"], ["yolo", "m3", "low"]],
      // 只给 modelId 不碰 reasoning_effort：列仍是 low，m2 不支持推理所以视图为 null。
      [{ modelId: "m2" }, ["yolo", "m2", null], ["yolo", "m2", "low"]],
      [{ modelId: "m1" }, ["yolo", "m1", "low"], ["yolo", "m1", "low"]],
    ];
    let start = 0;
    for (const [body, shown, raw] of steps) {
      start = Date.now();
      const view = expectPatched(await patch(world, "zhangsan", session.id, body));

      expect(composerOf(view)).toEqual(shown);
      expect(view.status).toBe("done");
      expect(view.updatedAt).toBe(before.updated_at);
      // 整行：除三列外没有一列变化（updated_at、status、stream_epoch、title 等）。
      expect(rowOf(world, session.id)).toEqual({
        ...before,
        approval_mode: raw[0],
        model_id: raw[1],
        reasoning_effort: raw[2],
      });
    }
    const end = Date.now();

    const chosen = prefs(world) as Array<[string, string, string, string, number]>;
    expect(chosen.map((row) => row.slice(0, 4))).toEqual([["u1", "yolo", "m1", "low"]]);
    expect(chosen[0]?.[4]).toBeGreaterThanOrEqual(start);
    expect(chosen[0]?.[4]).toBeLessThanOrEqual(end);
    // 六步里只有第一步改变了有效档位。
    expect(permissionAudits(world)).toEqual([changedAs("zhangsan", session, "write", "yolo")]);
    expect(session.temporaryWorkspace).toBe(true);

    // 新会话沿用最近选择：PATCH 写下的最近选择被同账号的无 body 创建继承，另一账号仍缺省。
    const next = await create(world, "zhangsan");
    expect(composerOf(next)).toEqual(["yolo", "m1", "low"]);
    expect(rawOf(world, next.id)).toEqual(["yolo", "m1", "low"]);
    const foreign = await create(world, "zhaoliu");
    expect(composerOf(foreign)).toEqual(["write", "m1", "high"]);
    expect(rawOf(world, foreign.id)).toEqual([null, null, null]);
  });

  type Arrange = (world: World, sessionId: string) => Promise<void>;
  const nothing: Arrange = async () => {};
  /** The session's model becomes `modelId`; the account's last choice then moves on to `m1`. */
  const onModel =
    (modelId: string): Arrange =>
    async (world, sessionId) => {
      expectPatched(await patch(world, "zhangsan", sessionId, { modelId }));
      await create(world, "zhangsan", { modelId: "m1" });
    };

  it.each<[string, Cap | undefined, Arrange, Record<string, unknown>]>([
    ["越过最高档 write 的 yolo", "write", nothing, { approvalMode: "yolo" }],
    ["不在白名单的模型", undefined, nothing, { modelId: "nope" }],
    ["强度 auto（当前有效模型 m3）", undefined, onModel("m3"), { reasoningEffort: "auto" }],
    // 最近选择的模型是 m1：强度所对的模型取会话当前的 m2，不取最近选择。
    ["不支持推理的当前模型 m2 带强度", undefined, onModel("m2"), { reasoningEffort: "high" }],
    ["body 的 m2 不支持推理", undefined, nothing, { modelId: "m2", reasoningEffort: "off" }],
    ["合法标题与非法档位同在", undefined, nothing, { title: "好", approvalMode: "x" }],
    // 规格六例之外。
    ["档位为 null", undefined, nothing, { approvalMode: null }],
    // 数组会被当作属性名转成 "high"：只有路由的字符串判定拦得住。
    ["强度是数组", undefined, nothing, { reasoningEffort: ["high"] }],
    ["合法模型与非法强度同在", undefined, nothing, { modelId: "m3", reasoningEffort: "ultra" }],
  ])("非法取值与越过最高档：%s → 400，什么都不写", async (_name, cap, arrange, body) => {
    const world = await openWorld(cap);
    const session = await create(world, "zhangsan");
    await arrange(world, session.id);
    const before = { row: rowOf(world, session.id), rest: footprint(world) };

    const response = await patch(world, "zhangsan", session.id, body);

    expectBadRequest(response);
    expect({ row: rowOf(world, session.id), rest: footprint(world) }).toEqual(before);
  });

  it("强度所对的模型取 body 的 modelId，否则取会话当前的有效模型（不取最近选择）", async () => {
    const world = await openWorld();
    const onM2 = await create(world, "zhangsan", { modelId: "m2" });
    const gone = await create(world, "zhangsan");
    plantRaw(world, gone.id, "model_id", "gone");
    // 此刻最近选择的模型是 m2。

    const moved = expectPatched(
      await patch(world, "zhangsan", onM2.id, { modelId: "m1", reasoningEffort: "high" }),
    );
    expect(composerOf(moved)).toEqual(["write", "m1", "high"]);
    expect(rawOf(world, onM2.id)).toEqual([null, "m1", "high"]);

    // gone 回落到缺省的 m1（支持推理）；列照旧是 gone。最近选择再被置回 m2 也不影响。
    await create(world, "zhangsan", { modelId: "m2" });
    const kept = expectPatched(await patch(world, "zhangsan", gone.id, { reasoningEffort: "max" }));
    expect(composerOf(kept)).toEqual(["write", "m1", "max"]);
    expect(rawOf(world, gone.id)).toEqual([null, "gone", "max"]);
    expect(permissionAudits(world)).toEqual([]);
  });

  it("隔离：他人会话与未知 id 的四次请求是逐字节相同的 404，先于取值校验，什么都不写", async () => {
    const world = await openWorld();
    const session = await create(world, "zhangsan", { approvalMode: "always-ask" });
    await create(world, "zhaoliu", { modelId: "m3" });
    const before = { row: rowOf(world, session.id), rest: footprint(world) };

    const responses: LightMyRequestResponse[] = [];
    for (const id of [session.id, UNKNOWN_SESSION_ID]) {
      for (const body of [{ approvalMode: "yolo" }, { approvalMode: "x" }]) {
        responses.push(await patch(world, "zhaoliu", id, body));
      }
    }

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND_ENVELOPE);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    expect({ row: rowOf(world, session.id), rest: footprint(world) }).toEqual(before);
  });

  it(
    "运行中修改不触及在途回合：200 且不发帧、不退进程、不动占用；带 archived:true 的同类请求整体被拒",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval", {
        assembly: { modelCatalog: THREE_MODEL_CATALOG },
      });
      const { app, db } = world.fixture;
      try {
        const pending = await pendingApproval(world);
        const child = spawnedAt(world, 0);
        const frames = child.stdin.length;
        const calls = world.rt.calls.length;
        const rowNow = (): Record<string, unknown> => ({
          ...db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(world.session),
        });
        const lastChoice = (): unknown[] =>
          db.prepare("SELECT * FROM account_composer_prefs ORDER BY account_id").all();
        const auditRows = (): number =>
          Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n);
        const before = rowNow();
        expect(before.status).toBe("running");

        const view = expectPatched(
          await patchVia(app, world.cookie, world.session, {
            approvalMode: "always-ask",
            modelId: "m3",
          }),
        );

        expect(view.status).toBe("running");
        expect(composerOf(view)).toEqual(["always-ask", "m3", "high"]);
        expect(rowNow()).toEqual({ ...before, approval_mode: "always-ask", model_id: "m3" });
        expect(child.stdin).toHaveLength(frames);
        expect(world.rt.calls).toHaveLength(calls);
        expect(child.child.exitCode).toBeNull();
        expect(approvalRows(db, world.session)).toEqual([pending]);
        expect(pending.decision).toBeNull();
        const snapshot = await getSessionMessages(app, world.session, world.cookie);
        expect((snapshot.json() as { session: unknown }).session).toEqual(view);

        // 规格未写的分支：归档守卫让整个请求落空，三列、最近选择与审计都不动；
        // 取值不合法时校验先于 UPDATE，是 400 而不是 409。
        const settled = { row: rowNow(), prefs: lastChoice(), audits: auditRows() };
        const archived = await patchVia(app, world.cookie, world.session, {
          approvalMode: "yolo",
          modelId: "m1",
          reasoningEffort: "low",
          archived: true,
        });
        expect(archived.statusCode).toBe(409);
        expect(archived.json()).toEqual(SESSION_BUSY_ENVELOPE);
        expectBadRequest(
          await patchVia(app, world.cookie, world.session, { approvalMode: "x", archived: true }),
        );
        expect({ row: rowNow(), prefs: lastChoice(), audits: auditRows() }).toEqual(settled);
        expect(child.stdin).toHaveLength(frames);
        expect(child.child.exitCode).toBeNull();

        const answered = await app.inject({
          method: "POST",
          url: `/api/sessions/${world.session}/approvals/${String(pending.id)}`,
          headers: { cookie: world.cookie, "content-type": "application/json" },
          payload: JSON.stringify({ decision: "allow" }),
        });
        expect(answered.statusCode).toBe(200);
        const done = await waitForTurn(world.fixture, world.session, "done");

        expect(child.stdin.slice(frames).map((frame) => frame.type)).toEqual([
          "extension_ui_response",
        ]);
        expect(world.rt.calls).toHaveLength(calls);
        expect(done.session).toMatchObject({
          approvalMode: "always-ask",
          modelId: "m3",
          reasoningEffort: "high",
        });
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("档位变更审计 (session-permission-tier)", () => {
  it("修改与重复选择：四步恰新增两条 session.permission，另一个成员看不到", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "zhangsan");
    const session = await create(world, "zhangsan", { workspaceId: workspace });
    expect(composerOf(session)).toEqual(["write", "m1", "high"]);
    expect(await permissionEventsSeenBy(world, "zhangsan")).toEqual([]);

    for (const body of [
      { approvalMode: "yolo" },
      { approvalMode: "yolo" },
      { modelId: "m3" },
      { approvalMode: "always-ask", title: "新名" },
    ]) {
      expectPatched(await patch(world, "zhangsan", session.id, body));
    }

    const expected = [
      ["write", "yolo"],
      ["yolo", "always-ask"],
    ].map(([from, to]) => ({
      actorId: "u1",
      title: "修改权限档位",
      workspaceId: workspace,
      detail: { sessionId: session.id, from, to },
    }));
    expect(await permissionEventsSeenBy(world, "zhangsan")).toEqual(expected);
    expect(await permissionEventsSeenBy(world, "zhaoliu")).toEqual([]);
    expect(await permissionEventsSeenBy(world, "lisi")).toEqual(expected);
    expect(rowOf(world, session.id)).toMatchObject({
      title: "新名",
      approval_mode: "always-ask",
      model_id: "m3",
      reasoning_effort: null,
    });
    expect(prefs(world).map((row) => (row as unknown[]).slice(0, 4))).toEqual([
      ["u1", "always-ask", "m3", null],
    ]);
  });

  it("审计失败则修改不生效：500，档位与最近选择不变；不写审计的修改不受影响", async () => {
    const world = await openWorld();
    const session = await create(world, "zhangsan", { modelId: "m1" });
    world.db.exec(`CREATE TEMP TRIGGER reject_audit
      BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit denied'); END`);
    try {
      const before = { row: rowOf(world, session.id), rest: footprint(world) };

      const refused = await patch(world, "zhangsan", session.id, {
        approvalMode: "yolo",
        title: "不落",
      });

      expect(refused.statusCode).toBe(500);
      expect(refused.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
      expect({ row: rowOf(world, session.id), rest: footprint(world) }).toEqual(before);
      expect(world.db.isTransaction).toBe(false);

      // 触发器仍在：模型的变化与重复当前档都不写审计，照常 200。
      expectPatched(await patch(world, "zhangsan", session.id, { modelId: "m3" }));
      const same = expectPatched(
        await patch(world, "zhangsan", session.id, { approvalMode: "write" }),
      );
      expect(composerOf(same)).toEqual(["write", "m3", "high"]);
      expect(rawOf(world, session.id)).toEqual(["write", "m3", null]);
      expect(permissionAudits(world)).toEqual([]);
    } finally {
      world.db.exec("DROP TRIGGER reject_audit");
    }
  });

  it("调低上界后既有会话被夹取：上界 write 下 yolo 行读作 write，from 取有效档位而不是原始列", async () => {
    const world = await openWorld("write");
    const first = await create(world, "zhangsan");
    const second = await create(world, "zhangsan");
    plantRaw(world, first.id, "approval_mode", "yolo");
    plantRaw(world, second.id, "approval_mode", "yolo");
    const list = await world.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: world.cookies.zhangsan },
    });
    const { sessions } = list.json() as { sessions: View[] };
    expect(sessions.map((session) => session.approvalMode)).toEqual(["write", "write"]);
    expect(rawOf(world, first.id)).toEqual(["yolo", null, null]);
    expect(permissionAudits(world)).toEqual([]);

    expectBadRequest(await patch(world, "zhangsan", first.id, { approvalMode: "yolo" }));
    expect(rawOf(world, first.id)).toEqual(["yolo", null, null]);
    expect(prefs(world)).toEqual([]);

    // yolo（读作 write）→ write：列变了，有效档位没变，不写审计；最近选择照常更新。
    const same = expectPatched(await patch(world, "zhangsan", first.id, { approvalMode: "write" }));
    expect(same.approvalMode).toBe("write");
    expect(rawOf(world, first.id)).toEqual(["write", null, null]);
    expect(prefs(world).map((row) => (row as unknown[]).slice(0, 4))).toEqual([
      ["u1", "write", null, null],
    ]);
    expect(permissionAudits(world)).toEqual([]);

    const lowered = expectPatched(
      await patch(world, "zhangsan", second.id, { approvalMode: "always-ask" }),
    );
    expect(lowered.approvalMode).toBe("always-ask");
    expect(permissionAudits(world)).toEqual([changedAs("zhangsan", second, "write", "always-ask")]);
  });

  it("上界 always-ask：NULL 行选 always-ask 不写审计（有效档位本就是它），write 为 400", async () => {
    const world = await openWorld("always-ask");
    const session = await create(world, "zhangsan");
    expect(session.approvalMode).toBe("always-ask");

    const same = expectPatched(
      await patch(world, "zhangsan", session.id, { approvalMode: "always-ask" }),
    );

    expect(same.approvalMode).toBe("always-ask");
    expect(rawOf(world, session.id)).toEqual(["always-ask", null, null]);
    expect(permissionAudits(world)).toEqual([]);
    const before = { row: rowOf(world, session.id), rest: footprint(world) };
    expectBadRequest(await patch(world, "zhangsan", session.id, { approvalMode: "write" }));
    expect({ row: rowOf(world, session.id), rest: footprint(world) }).toEqual(before);
  });
});

describe("十四键的四个出口 (chat-sessions「Session views carry the three composer settings」)", () => {
  it("缺省单模型配置：创建读缺省值，PATCH yolo 之后 PATCH、列表与快照都读 yolo，其余两键不变", async () => {
    const world = await openWorld(undefined, "default");
    const created = await create(world, "zhangsan");
    expect(composerOf(created)).toEqual(["write", "deepseek-v4.1-flash", "high"]);

    const patched = expectPatched(
      await patch(world, "zhangsan", created.id, { approvalMode: "yolo" }),
    );
    const list = await world.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: world.cookies.zhangsan },
    });
    const listed = (list.json() as { sessions: View[] }).sessions.find(
      (session) => session.id === created.id,
    );
    const snapshot = await getSessionMessages(world.app, created.id, world.cookies.zhangsan);
    const shown = (snapshot.json() as { session: View }).session;

    expect(patched).toEqual({ ...created, approvalMode: "yolo" });
    for (const view of [listed, shown]) {
      expect(Object.keys(view ?? {})).toEqual(SESSION_VIEW_KEYS);
      expect(view).toEqual(patched);
    }
  });
});
