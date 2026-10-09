/**
 * Issue #996 (s1g-composer-capabilities tasks 5.1–5.3): the transitional acceptance rules of design
 * D16「三步落地」step 1 — the parsers take the key sets of before and after the server emits the
 * new keys. Oracles are D16's literals. Task 13.5 deletes this file together with the transitional
 * branch in `web/src/lib/session-contract.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  parseMessageSnapshot,
  parseSession,
  parseSessionFork,
  parseSessionUndo,
} from "../src/lib/session-contract.js";

/** The eleven keys of before this change, written out: no shared fixture, which carries all fourteen. */
const ELEVEN = {
  id: "0123456789abcdef0123456789abcdef",
  title: "saved title",
  status: "done",
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  scene: null,
  workspaceId: null,
  pinnedAt: null,
  archivedAt: null,
  pendingApproval: false,
  temporaryWorkspace: false,
};
const DEFAULTS = { approvalMode: "write", modelId: "", reasoningEffort: null };
const THREE = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "low" };
const FILES = {
  mode: "kept",
  restored: 0,
  removed: 0,
  skipped: { count: 0, paths: [] },
  failed: { count: 0, paths: [] },
};

/** A message with the nine keys of before this change. */
function message(id: number, role: "user" | "assistant") {
  return {
    id,
    role,
    content: role === "user" ? "问" : "答",
    thinking: null,
    status: "done",
    createdAt: id,
    steps: [],
    approvals: [],
    undo: role === "user" ? "available" : null,
  };
}

function snapshotOf(messages: readonly unknown[]) {
  return { session: ELEVEN, messages, streamCursor: { epoch: 1, seq: null }, todo: null };
}

describe("D16 step 1: session view, eleven keys or eleven plus three (#996)", () => {
  it("parses an eleven-key session with write, an empty model id and a null effort", () => {
    expect(parseSession(ELEVEN)).toEqual({ ...ELEVEN, ...DEFAULTS });
  });

  it("keeps a fourteen-key session with an empty model id", () => {
    const session = { ...ELEVEN, ...THREE, modelId: "" };

    expect(parseSession(session)).toEqual(session);
  });
});

describe("D16 step 1: messages with or without attachments (#996)", () => {
  it("parses messages without attachments as an empty list", () => {
    const snapshot = parseMessageSnapshot(
      snapshotOf([message(1, "user"), message(2, "assistant")]),
    );

    expect(snapshot?.messages.map((item) => item.attachments)).toEqual([[], []]);
  });
});

describe("D16 step 1: fork and undo responses with or without attachments (#996)", () => {
  const parsed = { ...ELEVEN, ...DEFAULTS };

  it("parses a {session, draft} fork response with an empty attachment list", () => {
    expect(parseSessionFork({ session: ELEVEN, draft: "原文" })).toEqual({
      session: parsed,
      draft: "原文",
      attachments: [],
    });
  });

  it("parses a {session, draft, files} undo response with an empty attachment list", () => {
    expect(parseSessionUndo({ session: ELEVEN, draft: "原文", files: FILES })).toEqual({
      session: parsed,
      draft: "原文",
      files: FILES,
      attachments: [],
    });
  });
});
