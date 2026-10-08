/**
 * Issue #996 (s1g-composer-capabilities tasks 5.1–5.3): the transitional acceptance rules of design
 * D16「三步落地」step 1 — the parsers take the key sets of before and after the server emits the
 * new keys. Oracles are D16's literals. Task 13.5 deletes this file together with the transitional
 * branch in `web/src/lib/session-contract.ts`.
 */
import { describe, expect, it } from "vitest";
import { convertMessage } from "../src/features/chat/runtime-convert.js";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
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
const FILE = { path: "uploads/a.pdf", size: 3 };
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

  it.each([
    ["yolo, m3, low", THREE],
    ["a null effort", { ...THREE, reasoningEffort: null }],
    ["always-ask and max", { approvalMode: "always-ask", modelId: "m3", reasoningEffort: "max" }],
    ["an empty model id", { ...THREE, modelId: "" }],
  ])("keeps each value of a fourteen-key session with %s", (_label, three) => {
    expect(parseSession({ ...ELEVEN, ...three })).toEqual({ ...ELEVEN, ...three });
  });

  it("rejects a session carrying only approvalMode", () => {
    expect(parseSession({ ...ELEVEN, approvalMode: "write" })).toBeNull();
  });

  it.each([
    ["approvalMode and modelId only", { approvalMode: "write", modelId: "m3" }],
    ["modelId and reasoningEffort only", { modelId: "m3", reasoningEffort: null }],
    ["a fifteenth key", { ...THREE, parentId: "p" }],
    ["two of the three keys and a foreign one", { approvalMode: "write", modelId: "m3", x: null }],
    ["approvalMode auto", { ...THREE, approvalMode: "auto" }],
    ["a non-string modelId", { ...THREE, modelId: 3 }],
    ["reasoningEffort auto", { ...THREE, reasoningEffort: "auto" }],
    ["reasoningEffort ultra", { ...THREE, reasoningEffort: "ultra" }],
  ])("rejects a session with %s", (_label, extra) => {
    expect(parseSession({ ...ELEVEN, ...extra })).toBeNull();
  });
});

describe("D16 step 1: messages with or without attachments (#996)", () => {
  it("parses messages without attachments as an empty list", () => {
    const snapshot = parseMessageSnapshot(
      snapshotOf([message(1, "user"), message(2, "assistant")]),
    );

    expect(snapshot?.messages.map((item) => item.attachments)).toEqual([[], []]);
  });

  it("keeps the attachments of a user message and the empty list of an assistant message", () => {
    const snapshot = parseMessageSnapshot(
      snapshotOf([
        { ...message(1, "user"), attachments: [FILE, { path: "b.txt", size: 0 }] },
        { ...message(2, "assistant"), attachments: [] },
      ]),
    );

    expect(snapshot?.messages.map((item) => item.attachments)).toEqual([
      [FILE, { path: "b.txt", size: 0 }],
      [],
    ]);
  });

  it("rejects the snapshot when an assistant message carries attachments", () => {
    const snapshot = snapshotOf([
      { ...message(1, "user"), attachments: [FILE] },
      { ...message(2, "assistant"), attachments: [FILE] },
    ]);

    expect(parseMessageSnapshot(snapshot)).toBeNull();
  });

  it.each([
    ["null", null],
    ["an object", { 0: FILE }],
    ["an element with an extra key", [{ ...FILE, name: "a.pdf" }]],
    ["an element without size", [{ path: "uploads/a.pdf" }]],
    ["an empty path", [{ path: "", size: 3 }]],
    ["a negative size", [{ path: "uploads/a.pdf", size: -1 }]],
    ["a fractional size", [{ path: "uploads/a.pdf", size: 1.5 }]],
  ])("rejects the snapshot when a user message has attachments of %s", (_label, attachments) => {
    expect(parseMessageSnapshot(snapshotOf([{ ...message(1, "user"), attachments }]))).toBeNull();
  });

  it("rejects a message with a foreign tenth key", () => {
    expect(parseMessageSnapshot(snapshotOf([{ ...message(1, "user"), files: [] }]))).toBeNull();
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

  it("keeps the attachments of a fork response", () => {
    expect(parseSessionFork({ session: ELEVEN, draft: "", attachments: [FILE] })).toEqual({
      session: parsed,
      draft: "",
      attachments: [FILE],
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

  it("keeps the attachments of an undo response", () => {
    const body = { session: ELEVEN, draft: "", files: FILES, attachments: [FILE] };

    expect(parseSessionUndo(body)).toEqual({ ...body, session: parsed });
  });

  it.each([
    ["a foreign third key", { session: ELEVEN, draft: "", files: FILES }],
    ["a foreign key beside attachments", { session: ELEVEN, draft: "", attachments: [], x: 1 }],
    ["null attachments", { session: ELEVEN, draft: "", attachments: null }],
    [
      "an attachment with a negative size",
      { session: ELEVEN, draft: "", attachments: [{ path: "a", size: -1 }] },
    ],
  ])("rejects a fork response with %s", (_label, body) => {
    expect(parseSessionFork(body)).toBeNull();
  });

  it.each([
    ["a foreign fourth key", { session: ELEVEN, draft: "", files: FILES, x: 1 }],
    ["attachments in place of files", { session: ELEVEN, draft: "", attachments: [] }],
    ["null attachments", { session: ELEVEN, draft: "", files: FILES, attachments: null }],
    [
      "an attachment with an extra key",
      { session: ELEVEN, draft: "", files: FILES, attachments: [{ ...FILE, x: 1 }] },
    ],
  ])("rejects an undo response with %s", (_label, body) => {
    expect(parseSessionUndo(body)).toBeNull();
  });
});

describe("attachments reach the view state and the runtime custom fields (#996)", () => {
  it("passes each attachment through chatStateFromSnapshot and convertMessage", () => {
    const snapshot = parseMessageSnapshot(
      snapshotOf([{ ...message(1, "user"), attachments: [FILE] }, message(2, "assistant")]),
    );
    if (!snapshot) {
      throw new Error("the snapshot did not parse");
    }

    const view = chatStateFromSnapshot(snapshot);

    expect(view.messages.map((item) => item.attachments)).toEqual([[FILE], []]);
    expect(view.messages.map((item) => convertMessage(item).metadata?.custom?.attachments)).toEqual(
      [[FILE], []],
    );
  });
});
