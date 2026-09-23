import { afterEach, describe, expect, it } from "vitest";
import { connectSessionEvents } from "../src/features/chat/stream.js";
import {
  assistantContent,
  CLOSED,
  CONNECTING,
  callableThenable,
  chatSnapshot,
  connectChat,
  ENCODED_SESSION_EVENTS_URL,
  ENCODED_SESSION_ID,
  FakeEventSource,
  ForeignNamedEvent,
  latestSource,
  observeUnhandledRejections,
  onceThenGetter,
  resetFakeEventSources,
  settle,
} from "./chat-stream-support.js";

afterEach(() => {
  resetFakeEventSources();
});

describe("Chat stream recovery", () => {
  it("serializes live reentrant delivery so nested successors complete after the outer callback", async () => {
    const order: string[] = [];
    const context = connectChat(chatSnapshot(), {
      onEvent(current, event) {
        if (event.type !== "text.delta") {
          return;
        }
        order.push(`enter:${event.data.delta}`);
        if (event.data.delta === "A") {
          current.source.emitData("text.delta", "1:2", { messageId: 0, delta: "B" });
        }
        order.push(`exit:${event.data.delta}`);
      },
    });
    context.source.emitOpen();
    context.loads[0]?.resolve(chatSnapshot());
    await settle();
    context.source.emitData("text.delta", "1:1", { messageId: 0, delta: "A" });
    expect(assistantContent(context.state)).toBe("AB");
    context.source.emitData("text.delta", "1:2", { messageId: 0, delta: "B" });
    expect(assistantContent(context.state)).toBe("AB");
    expect(order).toEqual(["enter:A", "exit:A", "enter:B", "exit:B"]);
    context.handle.close();
  });

  it("contains a callable thenable consumer, reports the contract violation, and consumes its rejection", async () => {
    const observer = observeUnhandledRejections();
    const failure = new Error("callable async consumer");
    try {
      const context = connectChat(chatSnapshot(), {
        onSnapshot() {
          const owned = Promise.reject(failure);
          const callable = callableThenable((self) =>
            self === callable
              ? owned
              : Promise.reject(new Error("thenable lost its callable receiver")),
          );
          return callable;
        },
      });
      context.source.emitOpen();
      context.loads[0]?.resolve(chatSnapshot());
      await settle();
      expect(context.errors).toHaveLength(1);
      expect(context.source.closeCount).toBe(1);
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });

  it("captures a consumer then getter once and contains the owned rejection", async () => {
    const observer = observeUnhandledRejections();
    const failure = new Error("owned getter rejection");
    try {
      let fixture: { owner: object; reads: () => number } | undefined;
      const context = connectChat(chatSnapshot(), {
        onSnapshot() {
          const owned = Promise.reject(failure);
          fixture = onceThenGetter(owned.then.bind(owned));
          return fixture.owner;
        },
      });
      context.source.emitOpen();
      context.loads[0]?.resolve(chatSnapshot());
      await settle();
      expect(fixture?.reads()).toBe(1);
      expect(context.errors).toHaveLength(1);
      expect(observer.unhandled).toEqual([]);
      context.handle.close();
    } finally {
      observer.stop();
    }
  });

  it("contains a loader promise even if close reenters before its handlers attach", async () => {
    const observer = observeUnhandledRejections();
    const failure = new Error("abandoned loader rejection");
    try {
      const snapshot = chatSnapshot();
      const context = {
        handle: undefined as { close(): void } | undefined,
      };
      context.handle = connectSessionEvents(snapshot.session.id, {
        EventSourceCtor: FakeEventSource,
        initialCursor: snapshot.streamCursor,
        loadSnapshot() {
          context.handle?.close();
          return Promise.reject(failure);
        },
        onSnapshot() {
          throw new Error("must not install after close");
        },
        onEvent() {
          throw new Error("must not deliver after close");
        },
        onError() {
          throw new Error("must not report after close");
        },
      });
      latestSource().emitOpen();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });

  it("does not start a newer loader when aborting the previous recovery synchronously closes", () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    context.loads[0]?.signal.addEventListener("abort", () => context.handle.close(), {
      once: true,
    });
    context.source.emitOpen();
    expect(context.source.closeCount).toBe(1);
    expect(context.loads).toHaveLength(1);
    expect(context.errors).toEqual([]);
  });

  it("accepts structurally named data frames that are not same-realm MessageEvents", async () => {
    const snapshot = chatSnapshot({ content: "X", cursor: { epoch: 1, seq: 4 } });
    const context = connectChat(snapshot);
    context.source.emitOpen();
    context.loads[0]?.resolve(snapshot);
    await settle();
    const foreign = new ForeignNamedEvent(
      "text.delta",
      JSON.stringify({ messageId: 0, delta: "Y" }),
      "1:5",
    );
    expect(foreign instanceof MessageEvent).toBe(false);
    context.source.dispatchEvent(foreign);
    expect(assistantContent(context.state)).toBe("XY");
    expect(context.errors).toEqual([]);
    context.handle.close();
  });

  it("filters a covered 2048-character prefix and appends only the successor Z", async () => {
    const context = connectChat(chatSnapshot({ content: "prior", cursor: { epoch: 1, seq: 10 } }));
    context.source.emitOpen();
    context.source.emitGap();
    expect(context.loads).toHaveLength(2);
    expect(context.loads[0]?.signal.aborted).toBe(true);
    context.source.emitData("turn.start", "1:11", { messageId: 0 });
    context.source.emitData("text.delta", "1:1002", { messageId: 0, delta: "y".repeat(1048) });
    context.source.emitData("text.delta", "1:1003", { messageId: 0, delta: "Z" });
    context.loads[1]?.resolve(
      chatSnapshot({ content: "x".repeat(2048), cursor: { epoch: 1, seq: 1002 } }),
    );
    await settle();
    expect(assistantContent(context.state)).toBe(`${"x".repeat(2048)}Z`);
    expect(context.events).toHaveLength(1);
    context.source.emitData("text.delta", "1:1003", { messageId: 0, delta: "Z" });
    expect(assistantContent(context.state)?.length).toBe(2049);
    context.loads[0]?.resolve(chatSnapshot({ content: "stale", cursor: { epoch: 1, seq: 10 } }));
    await settle();
    expect(assistantContent(context.state)?.length).toBe(2049);
    expect(context.snapshots).toHaveLength(1);
    expect(context.gaps).toBe(1);
    context.handle.close();
  });

  it("seals an equal-epoch null cursor and only accepts a later epoch", async () => {
    const context = connectChat(chatSnapshot({ content: "old", cursor: { epoch: 1, seq: null } }));
    context.source.emitOpen();
    context.source.emitData("text.delta", "1:999", { messageId: 0, delta: "covered" });
    context.source.emitData("turn.start", "1:998", { messageId: 0 });
    context.source.emitData("text.delta", "2:1", { messageId: 0, delta: "new" });
    context.loads[0]?.resolve(chatSnapshot({ content: "sealed", cursor: { epoch: 1, seq: null } }));
    await settle();
    expect(assistantContent(context.state)).toBe("sealednew");
    expect(context.events).toHaveLength(1);
    context.source.emitData("text.delta", "1:1000", { messageId: 0, delta: "lateold" });
    expect(assistantContent(context.state)).toBe("sealednew");
    context.handle.close();
  });

  it("overflows the pending queue into a newer snapshot instead of continuing the truncated FIFO", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    for (let n = 1; n <= 1001; n += 1) {
      context.source.emitData("text.delta", `1:${n}`, { messageId: 0, delta: "x" });
    }
    expect(context.loads).toHaveLength(2);
    expect(context.loads[0]?.signal.aborted).toBe(true);
    context.loads[1]?.resolve(
      chatSnapshot({ content: "x".repeat(1001), cursor: { epoch: 1, seq: 1001 } }),
    );
    await settle();
    expect(assistantContent(context.state)).toBe("x".repeat(1001));
    context.loads[0]?.resolve(chatSnapshot({ content: "wrong" }));
    await settle();
    expect(assistantContent(context.state)?.length).toBe(1001);
    context.source.emitData("text.delta", "1:1002", { messageId: 0, delta: "Z" });
    expect(assistantContent(context.state)).toBe(`${"x".repeat(1001)}Z`);
    expect(context.snapshots).toHaveLength(1);
    context.handle.close();
  });

  it("ignores late snapshot success and rejection after close", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    const old = context.loads[0];
    context.handle.close();
    context.handle.close();
    expect(context.source.closeCount).toBe(1);
    expect(old?.signal.aborted).toBe(true);
    old?.resolve(chatSnapshot({ content: "wrong", cursor: { epoch: 1, seq: 10 } }));
    context.source.emitGap();
    context.source.emitData("text.delta", "1:11", { messageId: 0, delta: "late" });
    await settle();
    expect(context.snapshots).toEqual([]);
    expect(context.events).toEqual([]);
    expect(context.errors).toEqual([]);
    expect(context.loads).toHaveLength(1);

    const later = connectChat(chatSnapshot());
    later.source.emitOpen();
    const failure = new Error("ignored late failure");
    later.handle.close();
    later.loads[0]?.reject(failure);
    await settle();
    expect(later.errors).toEqual([]);
  });

  it("queues reentrant live successors behind the current drain and stops after a closing callback", async () => {
    const context = connectChat(chatSnapshot({ cursor: { epoch: 1, seq: 10 } }), {
      onEvent(current, event) {
        if (event.type === "text.delta" && event.data.delta === "A") {
          current.source.emitData("text.delta", "1:13", { messageId: 0, delta: "C" });
        }
      },
    });
    context.source.emitOpen();
    context.source.emitData("text.delta", "1:11", { messageId: 0, delta: "A" });
    context.source.emitData("text.delta", "1:12", { messageId: 0, delta: "B" });
    context.loads[0]?.resolve(chatSnapshot({ cursor: { epoch: 1, seq: 10 } }));
    await settle();
    expect(assistantContent(context.state)).toBe("ABC");
    expect(
      context.events.map((event) => (event.type === "text.delta" ? event.data.delta : "")).join(""),
    ).toBe("ABC");
    context.handle.close();

    const stop = connectChat(chatSnapshot({ cursor: { epoch: 1, seq: 10 } }), {
      onEvent(current) {
        current.handle.close();
      },
    });
    stop.source.emitOpen();
    stop.source.emitData("text.delta", "1:11", { messageId: 0, delta: "A" });
    stop.source.emitData("text.delta", "1:12", { messageId: 0, delta: "B" });
    stop.loads[0]?.resolve(chatSnapshot({ cursor: { epoch: 1, seq: 10 } }));
    await settle();
    expect(assistantContent(stop.state)).toBe("A");
    expect(stop.events).toHaveLength(1);
    expect(stop.source.closeCount).toBe(1);
  });

  it("invalidates an in-progress drain when onSnapshot reenters with a newer gap", async () => {
    let first = true;
    const context = connectChat(chatSnapshot({ cursor: { epoch: 1, seq: 10 } }), {
      onSnapshot(current) {
        if (first) {
          first = false;
          current.source.emitGap();
        }
      },
    });
    context.source.emitOpen();
    context.source.emitData("text.delta", "1:11", { messageId: 0, delta: "obsolete" });
    context.loads[0]?.resolve(chatSnapshot({ content: "first", cursor: { epoch: 1, seq: 10 } }));
    await settle();
    expect(context.loads).toHaveLength(2);
    expect(context.events).toHaveLength(0);
    context.source.emitData("text.delta", "1:21", { messageId: 0, delta: "Z" });
    context.loads[1]?.resolve(chatSnapshot({ content: "new", cursor: { epoch: 1, seq: 20 } }));
    await settle();
    expect(assistantContent(context.state)).toBe("newZ");
    expect(context.events).toHaveLength(1);
    context.handle.close();
  });

  it("keeps connecting transport errors silent and applies a named business error", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    context.loads[0]?.resolve(chatSnapshot());
    await settle();
    context.source.emitTransport(CONNECTING);
    expect(context.state.status).toBe("running");
    expect(context.errors).toHaveLength(0);
    expect(context.source.closeCount).toBe(0);
    context.source.emitOpen();
    context.loads[1]?.resolve(chatSnapshot());
    await settle();
    context.source.emitData("error", "1:1", { messageId: 0, message: "exact failure 世界" });
    expect(context.state.messages.find((message) => message.id === 0)?.error).toBe(
      "exact failure 世界",
    );
    expect(context.state.messages.find((message) => message.id === 0)?.status).toBe("failed");
    expect(context.state.status).toBe("running");
    context.source.emitData("turn.end", "1:2", { messageId: 0, status: "failed" });
    expect(context.state.status).toBe("failed");
    context.source.emitTransport(CLOSED);
    expect(context.errors).toHaveLength(1);
    expect(context.source.closeCount).toBe(1);
  });

  it("reports owned load and callback failures once and contains a failing onError", async () => {
    const failure = new Error("owned load failure");
    const loadFailure = connectChat(chatSnapshot());
    loadFailure.source.emitOpen();
    loadFailure.loads[0]?.reject(failure);
    await settle();
    expect(loadFailure.errors[0]).toBe(failure);
    expect(loadFailure.source.closeCount).toBe(1);

    const callbackFailure = new Error("owned callback failure");
    const bad = connectChat(chatSnapshot(), {
      onEvent() {
        throw callbackFailure;
      },
      onError() {
        return Promise.reject(new Error("notification failure"));
      },
    });
    bad.source.emitOpen();
    bad.loads[0]?.resolve(chatSnapshot());
    await settle();
    bad.source.emitData("text.delta", "1:1", { messageId: 0, delta: "A" });
    await settle();
    expect(bad.errors[0]).toBe(callbackFailure);
    expect(bad.source.closeCount).toBe(1);

    const asynchronous = connectChat(chatSnapshot(), {
      onSnapshot() {
        return Promise.reject(new Error("unsupported async install"));
      },
    });
    asynchronous.source.emitOpen();
    asynchronous.loads[0]?.resolve(chatSnapshot());
    await settle();
    expect(asynchronous.errors).toHaveLength(1);
    expect(asynchronous.source.closeCount).toBe(1);
  });

  it("rejects mismatched and regressive snapshots without installing them", async () => {
    for (const replacement of [
      chatSnapshot({ content: "older", cursor: { epoch: 1, seq: 4 } }),
      chatSnapshot({ content: "foreign", cursor: { epoch: 1, seq: 5 }, sessionId: "b".repeat(32) }),
    ]) {
      const context = connectChat(
        chatSnapshot({ content: "current", cursor: { epoch: 1, seq: 5 } }),
      );
      context.source.emitOpen();
      context.loads[0]?.resolve(replacement);
      await settle();
      expect(assistantContent(context.state)).toBe("current");
      expect(context.snapshots).toHaveLength(0);
      expect(context.errors).toHaveLength(1);
      expect(context.source.closeCount).toBe(1);
    }
  });

  it("resyncs on a malformed data id and ignores unknown event types", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    context.loads[0]?.resolve(chatSnapshot());
    await settle();
    context.source.emitData("text.delta", "1:01", { messageId: 0, delta: "bad" });
    expect(context.loads).toHaveLength(2);
    expect(context.events).toHaveLength(0);
    expect(context.gaps).toBe(0);
    context.loads[1]?.resolve(chatSnapshot({ content: "recovered", cursor: { epoch: 1, seq: 1 } }));
    await settle();
    context.source.emitData("future.event", "1:2", { anything: true });
    expect(context.loads).toHaveLength(2);
    expect(assistantContent(context.state)).toBe("recovered");
    context.handle.close();
  });

  it("encodes a non-canonical session id on the constructor without opening a snapshot", () => {
    const handle = connectSessionEvents(ENCODED_SESSION_ID, {
      EventSourceCtor: FakeEventSource,
      initialCursor: { epoch: 1, seq: 1 },
      loadSnapshot() {
        throw new Error("constructor must not load");
      },
      onSnapshot() {
        throw new Error("constructor must not install");
      },
      onEvent() {
        throw new Error("constructor must not deliver");
      },
      onError() {
        throw new Error("constructor must not fail");
      },
    });
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe(ENCODED_SESSION_EVENTS_URL);
    expect(source?.withCredentials).toBe(true);
    handle.close();
    expect(source?.closeCount).toBe(1);
  });
});
