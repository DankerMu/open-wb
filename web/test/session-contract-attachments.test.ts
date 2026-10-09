/**
 * Issue #1025 (s1g-composer-capabilities task 13.5): chat-web「API 客户端扩展」— the scenario
 * 「三键与附件的严格解析」, on the parsers themselves: the three composer settings of a session, the
 * `attachments` of a message, and the fork and undo responses. Oracles are the scenario's literals.
 */
import { describe, expect, it } from "vitest";
import {
  parseMessageSnapshot,
  parseSession,
  parseSessionFork,
  parseSessionUndo,
} from "../src/lib/session-contract.js";

/** The eleven keys a session had before the three composer settings, written out. */
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
const THREE = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "low" };
const SESSION = { ...ELEVEN, ...THREE };
const FILE = { path: "uploads/a.pdf", size: 3 };
const FILES = {
  mode: "kept",
  restored: 0,
  removed: 0,
  skipped: { count: 0, paths: [] },
  failed: { count: 0, paths: [] },
};
const FORK = { session: SESSION, draft: "x", attachments: [] };
const UNDO = { session: SESSION, draft: "x", files: FILES, attachments: [] };

/** A message with every key but `attachments`. */
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
  return { session: SESSION, messages, streamCursor: { epoch: 1, seq: null }, todo: null };
}

describe("三键与附件的严格解析: the three composer settings of a session (#1025)", () => {
  it.each([
    ["yolo, m3, low", THREE],
    ["a null effort", { ...THREE, reasoningEffort: null }],
    ["always-ask and max", { approvalMode: "always-ask", modelId: "m3", reasoningEffort: "max" }],
  ])("keeps each value of a fourteen-key session with %s", (_label, three) => {
    expect(parseSession({ ...ELEVEN, ...three })).toEqual({ ...ELEVEN, ...three });
  });

  it.each([
    ["approvalMode only", { approvalMode: "write" }],
    ["approvalMode and modelId only", { approvalMode: "write", modelId: "m3" }],
    ["approvalMode and reasoningEffort only", { approvalMode: "write", reasoningEffort: null }],
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

describe("三键与附件的严格解析: message attachments (#1025)", () => {
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

  it.each([
    ["files in place of attachments", { ...message(1, "user"), files: [] }],
    ["a foreign eleventh key", { ...message(1, "user"), attachments: [], files: [] }],
  ])("rejects the snapshot when a message has %s", (_label, item) => {
    expect(parseMessageSnapshot(snapshotOf([item]))).toBeNull();
  });
});

describe("三键与附件的严格解析: fork and undo responses (#1025)", () => {
  it.each([
    ["no attachments", []],
    ["one attachment", [FILE]],
  ])("keeps a fork response with %s", (_label, attachments) => {
    expect(parseSessionFork({ ...FORK, attachments })).toEqual({ ...FORK, attachments });
  });

  it.each([
    ["no attachments", []],
    ["one attachment", [FILE]],
  ])("keeps an undo response with %s", (_label, attachments) => {
    expect(parseSessionUndo({ ...UNDO, attachments })).toEqual({ ...UNDO, attachments });
  });

  it.each([
    ["files in place of attachments", { session: SESSION, draft: "", files: FILES }],
    ["a foreign fourth key", { ...FORK, x: 1 }],
    ["null attachments", { ...FORK, attachments: null }],
    ["an attachment with a negative size", { ...FORK, attachments: [{ path: "a", size: -1 }] }],
  ])("rejects a fork response with %s", (_label, body) => {
    expect(parseSessionFork(body)).toBeNull();
  });

  it.each([
    ["a foreign key in place of attachments", { session: SESSION, draft: "", files: FILES, x: 1 }],
    ["attachments in place of files", { session: SESSION, draft: "", attachments: [] }],
    ["a foreign fifth key", { ...UNDO, x: 1 }],
    ["null attachments", { ...UNDO, attachments: null }],
    ["an attachment with an extra key", { ...UNDO, attachments: [{ ...FILE, x: 1 }] }],
  ])("rejects an undo response with %s", (_label, body) => {
    expect(parseSessionUndo(body)).toBeNull();
  });
});
