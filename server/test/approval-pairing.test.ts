/**
 * Issue 1473 (chat-interleaved-segments 4.2, design D6/D16) at the pure seam: `PumpSteps`, one per
 * pump (one turn), with the unpaired approval queue and the unpaired running steps, both in the
 * order the pump reads frames. Pairing happens when the later of a same-name approval and step
 * arrives, whichever that is (tool-approval「确认与步骤配对」rules 1–3). The store is a recording
 * port; "would `publishRequest` publish a request for this frame now" is the registry's read-only
 * query, checked against a real `ApprovalRegistry` over fake ports in the last group. Expected
 * values are the rule texts applied by hand to the frames each case feeds in.
 */
import { describe, expect, it } from "vitest";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import { ApprovalRegistry } from "../src/sessions/approvals.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { emptySlot } from "../src/sessions/pool.js";
import type { ApprovalView, SessionStore } from "../src/sessions/store.js";

const MESSAGE = 7;

/** request id → tool of the approval rows the runtime registered (every `select` below registers). */
const registered = new Map<string, string>();

function select(id: string, tool: string): OmpFrame {
  registered.set(id, tool);
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: `Allow tool: ${tool}\nCommand: echo ${id}`,
    options: ["Approve", "Deny"],
  };
}

/** The pairing write: records every call; answers an approval id, or null for a zero-row update. */
function recordingStore(answer: (requestId: string) => number | null = () => 1) {
  const writes: Array<[number, string, number]> = [];
  return {
    writes,
    approvalTool: (_messageId: number, requestId: string) => registered.get(requestId),
    pairApproval(messageId: number, requestId: string, stepId: number) {
      writes.push([messageId, requestId, stepId]);
      return answer(requestId);
    },
  };
}

const PUBLISHES = () => true;

describe("rule 1: a step start takes the first queued approval of its name", () => {
  it("select first: starts take same-name approvals first in, first out", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.select(select("r1", "bash"), PUBLISHES, store);
    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([]);

    expect(steps.takeApproval("bash")).toBe("r1");
    steps.started("c1", 10, "bash", 101);
    expect(steps.takeApproval("bash")).toBe("r2");
    steps.started("c2", 11, "bash", 102);
    expect(steps.takeApproval("bash")).toBeUndefined();
    expect([...steps.toolIds]).toEqual([
      ["c1", 10],
      ["c2", 11],
    ]);
  });

  it("a taken approval whose update hit no row leaves the step running, unpaired", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.select(select("r1", "bash"), PUBLISHES, store);
    expect(steps.takeApproval("bash")).toBe("r1");
    steps.started("c1", 10, "bash", null);

    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([[MESSAGE, "r2", 10]]);
  });
});

describe("rule 2: a select whose request publishes now pairs the earliest running step", () => {
  it("start first: each select pairs the earliest-started same-name step still unpaired", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.started("c1", 10, "bash", null);
    steps.started("c2", 11, "bash", null);
    steps.select(select("r1", "bash"), PUBLISHES, store);
    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([
      [MESSAGE, "r1", 10],
      [MESSAGE, "r2", 11],
    ]);

    // Both steps are paired now: a third select finds none and queues.
    steps.select(select("r3", "bash"), PUBLISHES, store);
    expect(store.writes).toHaveLength(2);
    expect(steps.takeApproval("bash")).toBe("r3");
  });

  it("an update that hit no row is no pairing: the approval queues, the step stays running", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore((requestId) => (requestId === "r1" ? null : 5));
    steps.started("c1", 10, "bash", null);
    steps.select(select("r1", "bash"), PUBLISHES, store);
    expect(steps.takeApproval("bash")).toBe("r1");

    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([
      [MESSAGE, "r1", 10],
      [MESSAGE, "r2", 10],
    ]);
  });

  it("frames that are no approval select are neither paired nor queued", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.started("c1", 10, "bash", null);
    steps.select({ type: "extension_ui_request", id: "w1", method: "setWidget" }, PUBLISHES, store);
    steps.select(
      { type: "tool_execution_start", toolCallId: "c9", toolName: "bash" },
      PUBLISHES,
      store,
    );
    expect(store.writes).toEqual([]);
    expect(steps.takeApproval("bash")).toBeUndefined();
  });
});

describe("names, ended steps, published requests and the turn's end", () => {
  it("different names pair in neither direction", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.select(select("r1", "bash"), PUBLISHES, store);
    expect(steps.takeApproval("read")).toBeUndefined();
    steps.started("c1", 10, "read", null);
    expect(steps.takeApproval("bash")).toBe("r1");

    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([]);
    expect(steps.takeApproval("bash")).toBe("r2");
  });

  it("an ended step is no longer paired", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.started("c1", 10, "bash", null);
    steps.started("c2", 11, "bash", null);
    steps.ended(10);
    steps.select(select("r1", "bash"), PUBLISHES, store);
    expect(store.writes).toEqual([[MESSAGE, "r1", 11]]);
    steps.ended(11);
    steps.select(select("r2", "bash"), PUBLISHES, store);
    expect(store.writes).toHaveLength(1);
    expect(steps.takeApproval("bash")).toBe("r2");
  });

  it("a select whose request was already published only queues, a running step notwithstanding", () => {
    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.started("c1", 10, "bash", null);
    steps.select(select("r1", "bash"), () => false, store);
    expect(store.writes).toEqual([]);
    expect(steps.takeApproval("bash")).toBe("r1");
  });

  it("the turn's end discards both: the next turn's PumpSteps starts empty, ordinals from 0", () => {
    const first = new PumpSteps(MESSAGE);
    const store = recordingStore();
    first.select(select("r1", "bash"), PUBLISHES, store);
    first.started("c1", first.nextOrdinal(), "read", null);
    expect([first.nextOrdinal(), first.nextOrdinal()]).toEqual([1, 2]);

    const next = new PumpSteps(MESSAGE + 1);
    expect(next.takeApproval("bash")).toBeUndefined();
    next.select(select("r2", "read"), PUBLISHES, store);
    expect(store.writes).toEqual([]);
    expect(next.nextOrdinal()).toBe(0);
    expect([...next.toolIds]).toEqual([]);
  });
});

describe("ApprovalRegistry.publishesRequest: publishRequest's own predicate, read-only", () => {
  function registryWorld() {
    const view = { id: 1 } as unknown as ApprovalView;
    const store = {
      insertApproval: () => ({ approvalId: 1, messageId: MESSAGE, expiresAt: 60_000 }),
      settleApproval: () => view,
    } as unknown as SessionStore;
    const published: string[] = [];
    const registry = new ApprovalRegistry({
      store,
      clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
      publish: (_slot, event) => {
        published.push(event.type);
        return Promise.resolve(true);
      },
      fault: (_slot, error) => {
        throw error;
      },
    });
    const slot = emptySlot("s1", null, "write");
    slot.runtime = {
      markPending: () => undefined,
      clearPending: () => undefined,
      respondApproval: () => undefined,
    } as unknown as SessionRuntime;
    // The registry publishes only into a live generation (`#emit`).
    slot.generation = { sealed: false } as unknown as typeof slot.generation;
    registry.register(slot, { id: "r1", title: "Allow tool: bash", tool: "bash" });
    return { registry, slot, published };
  }

  it("true while registered and unpublished; false once publishRequest published it", async () => {
    const { registry, slot, published } = registryWorld();
    expect(registry.publishesRequest(slot, select("r1", "bash"))).toBe(true);
    expect(registry.publishesRequest(slot, select("r9", "bash"))).toBe(false);
    expect(registry.publishesRequest(slot, { type: "tool_execution_start" })).toBe(false);
    expect(published).toEqual([]);

    await registry.publishRequest(slot, select("r1", "bash"));
    expect(published).toEqual(["approval.request"]);
    expect(registry.publishesRequest(slot, select("r1", "bash"))).toBe(false);
  });

  it("false once a settlement published the request and dropped the registration", async () => {
    const { registry, slot, published } = registryWorld();
    await registry.decide("s1", 1, "allow");
    expect(published).toEqual(["approval.request", "approval.resolved"]);
    expect(registry.pendingFor(slot)).toEqual([]);
    expect(registry.publishesRequest(slot, select("r1", "bash"))).toBe(false);

    const steps = new PumpSteps(MESSAGE);
    const store = recordingStore();
    steps.started("c1", 10, "bash", null);
    const frame = select("r1", "bash");
    steps.select(frame, () => registry.publishesRequest(slot, frame), store);
    expect(store.writes).toEqual([]);
    expect(steps.takeApproval("bash")).toBe("r1");
  });
});
