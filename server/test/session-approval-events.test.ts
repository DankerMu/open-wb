/**
 * Issue #453 approval.request / approval.resolved are ordinary ring events carried by the real SSE
 * endpoint. The supervisor's private generation ring cannot receive approval events yet (their
 * producer is #464), so subscribe is backed by a test-owned real RingBuffer; auth, sse.ts framing
 * and RingBuffer replay stay real. Expected ids, names and payloads are fixture literals.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import { RingBuffer } from "../src/sessions/stream/ring-buffer.js";
import type { SessionStreamLiveHandler } from "../src/sessions/supervisor.js";
import { type OpenStream, openEventStream, readUntil } from "./session-sse-helpers.js";
import {
  closeFixture,
  createRealFakeRuntime,
  openBareSession,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";

const EPOCH = 3;

type Decision = Extract<ChatEvent<number>, { type: "approval.resolved" }>["data"]["decision"];

const TURN_START = { type: "turn.start", data: { messageId: 1 } } as const;
const REQUEST = {
  type: "approval.request",
  data: { messageId: 1, approvalId: 7, tool: "bash", title: "t", expiresAt: 1700000060000 },
} as const;
const RESOLVED = {
  type: "approval.resolved",
  data: { messageId: 1, approvalId: 7, decision: "allow" },
} as const;
const TURN_END = { type: "turn.end", data: { messageId: 1, status: "done" } } as const;

interface Frame {
  id: string;
  event: string;
  data: unknown;
}

interface RingWorld {
  fixture: SupervisorApp;
  cookie: string;
  session: string;
  ring: RingBuffer;
  subscribe: ReturnType<typeof vi.spyOn>;
  live(): SessionStreamLiveHandler | undefined;
}

const opened: SupervisorApp[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of opened.splice(0)) {
    await closeFixture(fixture);
  }
});

async function openRingWorld(): Promise<RingWorld> {
  const runtime = createRealFakeRuntime();
  const { fixture, cookie, session } = await openBareSession(runtime.runtime);
  opened.push(fixture);
  const ring = new RingBuffer(EPOCH);
  let deliver: SessionStreamLiveHandler | undefined;
  const subscribe = vi
    .spyOn(fixture.app.sessions.supervisor, "subscribe")
    .mockImplementation((_sessionId, cursor, handler) => {
      deliver = handler;
      const read = ring.since(cursor, { turnRunning: true });
      return {
        mode: read.mode,
        replay: read.events,
        unsubscribe() {
          deliver = undefined;
        },
      };
    });
  return { fixture, cookie, session, ring, subscribe, live: () => deliver };
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const colon = line.indexOf(": ");
      if (colon > 0) {
        fields.set(line.slice(0, colon), line.slice(colon + 2));
      }
    }
    const id = fields.get("id");
    const event = fields.get("event");
    const data = fields.get("data");
    if (id !== undefined && event !== undefined && data !== undefined) {
      frames.push({ id, event, data: JSON.parse(data) });
    }
  }
  return frames;
}

async function readFrames(stream: OpenStream, lastEvent: string): Promise<Frame[]> {
  const text = await readUntil(stream, (bytes) =>
    parseFrames(bytes).some((frame) => frame.event === lastEvent),
  );
  return parseFrames(text);
}

describe("approval events are ordinary ring events", () => {
  it("assigns consecutive sequence ids and keeps both approval payloads before turn.end", () => {
    const ring = new RingBuffer(EPOCH);

    const ids = [
      ring.push(TURN_START),
      ring.push(REQUEST),
      ring.push(RESOLVED),
      ring.push(TURN_END),
    ];

    expect(ids).toEqual(["3:1", "3:2", "3:3", "3:4"]);
    const retained = ring.since("3:0", { turnRunning: false });
    expect(retained.mode).toBe("replay");
    expect(retained.events).toEqual([
      { id: "3:1", type: "turn.start", data: { messageId: 1 } },
      {
        id: "3:2",
        type: "approval.request",
        data: { messageId: 1, approvalId: 7, tool: "bash", title: "t", expiresAt: 1700000060000 },
      },
      {
        id: "3:3",
        type: "approval.resolved",
        data: { messageId: 1, approvalId: 7, decision: "allow" },
      },
      { id: "3:4", type: "turn.end", data: { messageId: 1, status: "done" } },
    ]);
  });

  it("replays request, resolved and turn.end exactly once after the Last-Event-ID preceding the request", async () => {
    const world = await openRingWorld();
    world.ring.push(TURN_START);
    world.ring.push(REQUEST);
    world.ring.push(RESOLVED);
    world.ring.push(TURN_END);

    const stream = await openEventStream(world.fixture, world.session, world.cookie, "3:1");
    const frames = await readFrames(stream, "turn.end");

    expect(world.subscribe).toHaveBeenCalledWith(world.session, "3:1", expect.any(Function));
    expect(frames).toEqual([
      {
        id: "3:2",
        event: "approval.request",
        data: { messageId: 1, approvalId: 7, tool: "bash", title: "t", expiresAt: 1700000060000 },
      },
      {
        id: "3:3",
        event: "approval.resolved",
        data: { messageId: 1, approvalId: 7, decision: "allow" },
      },
      { id: "3:4", event: "turn.end", data: { messageId: 1, status: "done" } },
    ]);
    stream.abort();
  });

  it("refreshes a pending approval from turn.start and delivers the later resolution live", async () => {
    const world = await openRingWorld();
    world.ring.push(TURN_START);
    world.ring.push(REQUEST);

    const stream = await openEventStream(world.fixture, world.session, world.cookie);
    const replayed = await readFrames(stream, "approval.request");

    expect(world.subscribe).toHaveBeenCalledWith(world.session, null, expect.any(Function));
    expect(replayed).toEqual([
      { id: "3:1", event: "turn.start", data: { messageId: 1 } },
      {
        id: "3:2",
        event: "approval.request",
        data: { messageId: 1, approvalId: 7, tool: "bash", title: "t", expiresAt: 1700000060000 },
      },
    ]);

    world.ring.push(RESOLVED);
    const latest = world.ring.latest();
    const deliver = world.live();
    if (latest === undefined || deliver === undefined) {
      throw new Error("ring event or live subscriber missing after replay");
    }
    deliver(latest);
    const frames = await readFrames(stream, "approval.resolved");

    expect(frames.slice(2)).toEqual([
      {
        id: "3:3",
        event: "approval.resolved",
        data: { messageId: 1, approvalId: 7, decision: "allow" },
      },
    ]);
    stream.abort();
  });

  it("carries every approval decision value through SSE unchanged", async () => {
    const world = await openRingWorld();
    world.ring.push(TURN_START);
    world.ring.push({
      type: "approval.resolved",
      data: { messageId: 1, approvalId: 7, decision: "allow" },
    });
    world.ring.push({
      type: "approval.resolved",
      data: { messageId: 1, approvalId: 8, decision: "deny" },
    });
    world.ring.push({
      type: "approval.resolved",
      data: { messageId: 1, approvalId: 9, decision: "timeout" },
    });

    const stream = await openEventStream(world.fixture, world.session, world.cookie, "3:1");
    const text = await readUntil(stream, (bytes) => bytes.includes('"decision":"timeout"'));

    expect(parseFrames(text)).toEqual([
      {
        id: "3:2",
        event: "approval.resolved",
        data: { messageId: 1, approvalId: 7, decision: "allow" },
      },
      {
        id: "3:3",
        event: "approval.resolved",
        data: { messageId: 1, approvalId: 8, decision: "deny" },
      },
      {
        id: "3:4",
        event: "approval.resolved",
        data: { messageId: 1, approvalId: 9, decision: "timeout" },
      },
    ]);
    stream.abort();
  });

  it("accepts only allow, deny and timeout as approval decisions", () => {
    expectTypeOf<Decision>().toEqualTypeOf<"allow" | "deny" | "timeout">();
    // @ts-expect-error "approve" is not an approval decision
    const rejected: Decision = "approve";
    expect(rejected).toBe("approve");
  });
});
