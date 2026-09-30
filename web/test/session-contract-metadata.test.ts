/**
 * Issue #517 (parent s1c tasks 5.1) web session DTO contract: eight-key sessions, message
 * `thinking` and step `changes` strict parsing through the exported snapshot/list/fork parsers,
 * `listSessions()` whole-response rejection, and the SSE `step.end` guard that still refuses a
 * `changes` key. Oracles: the spec delta's literal fixtures and key sets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  parseMessageSnapshot,
  parseSessionFork,
  parseSessionList,
} from "../src/lib/session-contract.js";
import {
  assistantSteps,
  chatSnapshot,
  connectChat,
  observeUnhandledRejections,
  resetFakeEventSources,
  settle,
} from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = "fedcba9876543210fedcba9876543210";

const metaSession = {
  id: SESSION_ID,
  title: "周报",
  status: "done",
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  scene: "design",
  workspaceId: WORKSPACE_ID,
  pinnedAt: 1_700_000_000_000,
};

const nullMetaSession = {
  id: "abcdef0123456789abcdef0123456789",
  title: null,
  status: "idle",
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_000,
  ...NULL_SESSION_META,
};

const editChange = { path: "src/app.ts", added: 2, removed: 1, kind: "edit" };
const writeChange = { path: "out/index.html", added: null, removed: null, kind: "write" };

function step(id: number, changes: unknown) {
  return {
    id,
    ordinal: id,
    name: id === 0 ? "bash" : "edit",
    detail: "{}",
    output: "",
    changes,
    status: "done",
  };
}

function snapshotWith(
  overrides: { session?: unknown; user?: object; assistant?: object; step?: object } = {},
) {
  return {
    session: overrides.session ?? metaSession,
    messages: [
      {
        id: -3,
        role: "user",
        content: "写周报",
        thinking: null,
        status: "done",
        createdAt: -1,
        steps: [],
        approvals: [],
        ...overrides.user,
      },
      {
        id: 0,
        role: "assistant",
        content: "好的",
        thinking: "先想一想",
        status: "done",
        createdAt: 0,
        steps: [step(0, null), { ...step(1, [editChange, writeChange]), ...overrides.step }],
        approvals: [],
        ...overrides.assistant,
      },
      {
        id: 1,
        role: "assistant",
        content: "再答",
        thinking: null,
        status: "done",
        createdAt: 1,
        steps: [],
        approvals: [],
      },
    ],
    streamCursor: { epoch: 1, seq: null },
  };
}

function withoutKey(value: Record<string, unknown>, key: string) {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function withoutMeta(session: Record<string, unknown>) {
  return withoutKey(withoutKey(withoutKey(session, "scene"), "workspaceId"), "pinnedAt");
}

function manyChanges(count: number) {
  return Array.from({ length: count }, (_, index) => ({ ...editChange, path: `f${index}.ts` }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFakeEventSources();
});

describe("Session contract: eight-key session", () => {
  it.each([
    ["stored metadata", metaSession],
    ["null metadata", nullMetaSession],
  ])("accepts and preserves a session with %s in list, snapshot and fork", (_label, session) => {
    expect(parseSessionList({ sessions: [session] })).toEqual({ sessions: [session] });
    expect(parseSessionFork({ session, draft: "" })).toEqual({ session, draft: "" });
    expect(parseMessageSnapshot(snapshotWith({ session }))?.session).toEqual(session);
  });

  it.each([
    ["missing scene", withoutKey(metaSession, "scene")],
    ["missing workspaceId", withoutKey(metaSession, "workspaceId")],
    ["missing pinnedAt", withoutKey(metaSession, "pinnedAt")],
    ["an extra parentSessionId", { ...metaSession, parentSessionId: SESSION_ID }],
    ["scene chat", { ...metaSession, scene: "chat" }],
    ["an uppercase workspaceId", { ...metaSession, workspaceId: WORKSPACE_ID.toUpperCase() }],
    ["a 31-character workspaceId", { ...metaSession, workspaceId: WORKSPACE_ID.slice(1) }],
    ["a non-hex workspaceId", { ...metaSession, workspaceId: `g${WORKSPACE_ID.slice(1)}` }],
    ["a negative pinnedAt", { ...metaSession, pinnedAt: -1 }],
    ["an unsafe pinnedAt", { ...metaSession, pinnedAt: 2 ** 53 }],
  ])("rejects a session with %s in list, snapshot and fork", (_label, session) => {
    expect(parseSessionList({ sessions: [nullMetaSession, session] })).toBeNull();
    expect(parseSessionFork({ session, draft: "" })).toBeNull();
    expect(parseMessageSnapshot(snapshotWith({ session }))).toBeNull();
  });

  it("rejects a legacy five-key session in list, snapshot and fork", () => {
    const legacy = withoutMeta(nullMetaSession);
    expect(parseSessionList({ sessions: [legacy] })).toBeNull();
    expect(parseSessionFork({ session: legacy, draft: "" })).toBeNull();
    expect(parseMessageSnapshot(snapshotWith({ session: legacy }))).toBeNull();
  });
});

describe("Session contract: message thinking and step changes", () => {
  it("accepts and preserves thinking, null changes and edit/write changes", () => {
    const snapshot = snapshotWith();

    expect(parseMessageSnapshot(snapshot)).toEqual(snapshot);
  });

  it("accepts the 1 and 50 element changes bounds", () => {
    for (const count of [1, 50]) {
      const snapshot = snapshotWith({ step: { changes: manyChanges(count) } });
      expect(parseMessageSnapshot(snapshot)).toEqual(snapshot);
    }
  });

  it.each([
    ["a non-null user thinking", { user: { thinking: "x" } }],
    ["a numeric thinking", { assistant: { thinking: 1 } }],
    ["empty changes", { step: { changes: [] } }],
    ["51 changes", { step: { changes: manyChanges(51) } }],
    ["a write change with counts", { step: { changes: [{ ...writeChange, added: 1 }] } }],
    ["an edit change with a null count", { step: { changes: [{ ...editChange, added: null }] } }],
    [
      "an edit change with a negative count",
      { step: { changes: [{ ...editChange, removed: -1 }] } },
    ],
    ["a rename change", { step: { changes: [{ ...editChange, kind: "rename" }] } }],
    ["a change with an extra field", { step: { changes: [{ ...editChange, extra: true }] } }],
    ["a change missing a field", { step: { changes: [withoutKey(editChange, "removed")] } }],
    ["a change with an empty path", { step: { changes: [{ ...writeChange, path: "" }] } }],
  ])("rejects the whole snapshot for %s", (_label, overrides) => {
    expect(parseMessageSnapshot(snapshotWith(overrides))).toBeNull();
  });

  it("rejects a legacy seven-key message without thinking", () => {
    const snapshot = snapshotWith();
    const [user, ...rest] = snapshot.messages;
    const legacy = { ...snapshot, messages: [withoutKey(user ?? {}, "thinking"), ...rest] };

    expect(parseMessageSnapshot(legacy)).toBeNull();
  });

  it("rejects a legacy six-key step without changes", () => {
    const snapshot = snapshotWith();
    const [user, assistant, last] = snapshot.messages;
    const legacyStep = withoutKey(step(0, null), "changes");
    const legacy = {
      ...snapshot,
      messages: [user, { ...assistant, steps: [legacyStep] }, last],
    };

    expect(parseMessageSnapshot(legacy)).toBeNull();
  });

  it("rejects a fully legacy snapshot of five-key session, seven-key messages, six-key steps", () => {
    const snapshot = snapshotWith();
    const legacy = {
      session: withoutMeta(metaSession),
      messages: snapshot.messages.map((message) => ({
        ...withoutKey(message, "thinking"),
        steps: message.steps.map((entry) => withoutKey(entry, "changes")),
      })),
      streamCursor: snapshot.streamCursor,
    };

    expect(parseMessageSnapshot(legacy)).toBeNull();
  });
});

describe("Session contract: list response through the API client", () => {
  it("accepts a valid eight-key list", async () => {
    const body = { sessions: [metaSession, nullMetaSession] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    await expect(createApiClient().listSessions()).resolves.toEqual(body);
  });

  it.each([
    ["a seven-key item without pinnedAt", withoutKey(metaSession, "pinnedAt")],
    ["a nine-key item with parentSessionId", { ...metaSession, parentSessionId: SESSION_ID }],
    ["an item with scene chat", { ...metaSession, scene: "chat" }],
  ])("rejects the whole list for %s without a partial list", async (_label, session) => {
    const body = { sessions: [nullMetaSession, session] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await captureApiError(createApiClient().listSessions());

    expectRequestFailure(error, 200);
  });
});

describe("Session contract: SSE step.end stays four keys", () => {
  it("resyncs on a step.end carrying changes and still applies the four-key step.end", async () => {
    const observer = observeUnhandledRejections();
    const runningEdit = {
      id: 11,
      ordinal: 0,
      name: "edit",
      detail: "{}",
      output: "",
      changes: null,
      status: "running" as const,
    };
    const withEdit = (seq: number) =>
      chatSnapshot({ steps: [runningEdit], cursor: { epoch: 1, seq } });
    const stepEnd = { messageId: 0, stepId: 11, status: "done", output: "edited" };
    try {
      const context = connectChat(withEdit(4));
      context.source.emitOpen();
      context.loads[0]?.resolve(withEdit(4));
      await settle();

      context.source.emitData("step.end", "1:5", { ...stepEnd, changes: [editChange] });

      expect(context.loads).toHaveLength(2);
      expect(context.events).toEqual([]);
      expect(assistantSteps(context.state)).toEqual([
        { id: 11, name: "edit", detail: "{}", output: "", status: "running" },
      ]);

      context.loads[1]?.resolve(withEdit(5));
      await settle();
      context.source.emitData("step.end", "1:6", stepEnd);

      expect(context.loads).toHaveLength(2);
      expect(context.events).toEqual([{ type: "step.end", data: stepEnd }]);
      expect(assistantSteps(context.state)).toEqual([
        { id: 11, name: "edit", detail: "{}", output: "edited", status: "done" },
      ]);
      context.handle.close();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});
