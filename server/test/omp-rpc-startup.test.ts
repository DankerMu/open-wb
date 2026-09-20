import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError } from "../src/sessions/omp/process.js";
import { createRpcHarness, startUnreadyFake } from "./support/omp-rpc.js";

const TOKEN = "wb-issue95-io-secret-token";
const harness = createRpcHarness();

describe("OmpProcess startup output termination", () => {
  it("rejects startup immediately when stdout ends before ready", async () => {
    const { child, observation, spawned, started } = startUnreadyFake(harness, TOKEN);
    await spawned;
    child.endStdout();
    await waitImmediate();

    expect(observation.outcome).toBe("rejected");
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("rejects startup immediately when stdout closes before ready", async () => {
    const { observation, spawned, started } = startUnreadyFake(harness, TOKEN, (child) => {
      setImmediate(() => {
        child.stdout.emit("close");
      });
    });
    await spawned;
    await waitImmediate();

    expect(observation.outcome).toBe("rejected");
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});
