import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError, OmpProcess } from "../src/sessions/omp/process.js";
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

  it("does not send a second SIGKILL after a successful owned SIGKILL", async () => {
    const { child, proc, signals, started } = await openStartupKillCase(
      (signal, _signals, originalKill) => (signal === "SIGKILL" ? true : originalKill(signal)),
    );
    expect(proc.child).toBeDefined();
    expect(proc.kill("SIGKILL")).toBe(true);
    child.endStdout();
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(signals).toEqual(["SIGKILL"]);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("still terminates startup after an accepted TERM", async () => {
    const { child, proc, signals, started } = await openStartupKillCase(
      (signal, _signals, originalKill) => (signal === "SIGTERM" ? true : originalKill(signal)),
    );
    expect(proc.child).toBeDefined();
    expect(proc.kill("SIGTERM")).toBe(true);
    child.endStdout();
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("still terminates startup after a failed SIGKILL", async () => {
    const { child, proc, signals, started } = await openStartupKillCase(
      (signal, signals, originalKill) => (signals.length === 1 ? false : originalKill(signal)),
    );
    expect(proc.child).toBeDefined();
    expect(proc.kill("SIGKILL")).toBe(false);
    child.endStdout();
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(signals).toEqual(["SIGKILL", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });
});

async function openStartupKillCase(
  killBehavior: (
    signal: NodeJS.Signals,
    signals: NodeJS.Signals[],
    originalKill: (signal?: NodeJS.Signals) => boolean,
  ) => boolean,
) {
  const child = harness.fake();
  const signals: NodeJS.Signals[] = [];
  const originalKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals) => {
    const chosen = signal ?? "SIGKILL";
    signals.push(chosen);
    return killBehavior(chosen, signals, originalKill);
  }) as typeof child.kill;
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(TOKEN, "omp-rpc-kill-"),
      spawnImpl: (command, args, options) => {
        const spawnedChild = child.spawnImpl(command, args, options);
        markSpawned();
        return spawnedChild;
      },
    }),
  );
  const started = proc.start();
  void started.catch(() => {});
  await spawned;
  await waitImmediate();
  return { child, proc, signals, started };
}
