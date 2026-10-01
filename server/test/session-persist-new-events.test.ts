/**
 * Issue #514 publication gate: `persistEvent` neither stores nor publishes `thinking.delta` /
 * `files.changed`. Since #519 the supervisor takes `thinking.delta` into its merge buffer before
 * `persistEvent` (covered by session-thinking.test.ts); `files.changed` stays unpublished until the
 * file-change slice (3.4) lands.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { SessionStore, SettledApproval } from "../src/sessions/store.js";
import { persistEvent } from "../src/sessions/turn-control.js";

const ASSISTANT_ID = 41;

const THINKING: ChatEvent<string> = {
  type: "thinking.delta",
  data: { messageId: ASSISTANT_ID, delta: "先读需求，" },
};
const FILES: ChatEvent<string> = {
  type: "files.changed",
  data: {
    messageId: ASSISTANT_ID,
    stepId: "tool-edit-1",
    files: [
      { path: "/srv/workbuddy/sandbox/u1/demo/notes.md", added: 2, removed: 1, kind: "edit" },
      {
        path: "/srv/workbuddy/sandbox/u1/demo/out/report.html",
        added: null,
        removed: null,
        kind: "write",
      },
    ],
  },
};

/** Every property read on the store is recorded; any method returns undefined after recording. */
function recordingStore(): { store: SessionStore; touched: string[] } {
  const touched: string[] = [];
  const store = new Proxy(
    {},
    {
      get(_target, key) {
        touched.push(String(key));
        return () => undefined;
      },
    },
  ) as unknown as SessionStore;
  return { store, touched };
}

function persistAlone(event: ChatEvent<string>) {
  const { store, touched } = recordingStore();
  const toolIds = new Map<string, number>([["call_prior", 7]]);
  const nextOrdinal = vi.fn(() => 1);
  const settled: SettledApproval[] = [];
  const published = persistEvent(store, ASSISTANT_ID, event, toolIds, nextOrdinal, settled);
  return { published, touched, toolIds: [...toolIds], nextOrdinal, settled };
}

describe("persistEvent — thinking.delta and files.changed are neither stored nor published", () => {
  it("the recording store double sees an existing store-backed event", () => {
    const text: ChatEvent<string> = {
      type: "text.delta",
      data: { messageId: ASSISTANT_ID, delta: "答" },
    };
    const result = persistAlone(text);
    expect(result.published).toBe(text);
    expect(result.touched).toEqual(["appendDelta"]);
  });

  for (const [name, event] of [
    ["thinking.delta", THINKING],
    ["files.changed", FILES],
  ] as const) {
    it(`${name} returns undefined without touching the store, tool ids, ordinals or settlements`, () => {
      const result = persistAlone(event);
      expect(result.published).toBeUndefined();
      expect(result.touched).toEqual([]);
      expect(result.toolIds).toEqual([["call_prior", 7]]);
      expect(result.nextOrdinal).not.toHaveBeenCalled();
      expect(result.settled).toEqual([]);
    });
  }
});
