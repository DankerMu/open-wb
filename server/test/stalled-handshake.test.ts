/**
 * Issue #909 task 1.3: the stalled-handshake listener of support/stalled-handshake.ts counts the
 * connections it accepts, and `close` destroys every socket it holds and stops listening.
 */
import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { startStalledHandshake } from "./support/stalled-handshake.js";

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("stalled-handshake listener", () => {
  it("counts accepted connections and never writes to them", async () => {
    const listener = await startStalledHandshake();
    try {
      const first = await open(listener.port);
      const second = await open(listener.port);
      await until(() => listener.accepted() === 2, 1_000);
      let received = 0;
      first.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toBe(0);
      expect(listener.released()).toBe(0);
      second.destroy();
      await until(() => listener.released() === 1, 1_000);
      first.destroy();
    } finally {
      await listener.close();
    }
  });

  it("close destroys the held sockets and stops listening", async () => {
    const listener = await startStalledHandshake();
    const client = await open(listener.port);
    await until(() => listener.accepted() === 1, 1_000);
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await listener.close();
    await until(() => client.destroyed, 1_000);
    await closed;
    await expect(open(listener.port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
