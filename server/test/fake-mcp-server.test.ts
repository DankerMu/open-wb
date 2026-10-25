/**
 * s1d-connectors group 2b (issue #1671): the stdio MCP fixture `support/fake-mcp-server.mjs` that
 * the official omp case registers in `mcp.json`. Spawned directly with node; every request is
 * written in one chunk (the fixture must split a multi-line buffer), stdin is then closed and the
 * process must exit 0 on its own. Proves: `initialize` answers the argv sentinel as `instructions`
 * with `capabilities.tools` (omp calls `tools/list` only then), `tools/list` holds exactly `echo`,
 * `tools/call` answers text content, notifications get no reply, an unknown request gets `-32601`,
 * and the argv marker file exists once the process started.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FIXTURE = fileURLToPath(new URL("./support/fake-mcp-server.mjs", import.meta.url));
const SENTINEL = "SELF-TEST-MCP-SENTINEL-1671";

type Message = Record<string, unknown>;

interface Running {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
}

const running: Running[] = [];
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fake-mcp-server-"));
});

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }),
  );
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes `messages` as newline-delimited JSON in one chunk, closes stdin, waits for close. */
async function exchange(
  args: string[],
  messages: Message[],
): Promise<{ code: number | null; replies: Message[]; stderr: string }> {
  const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: "pipe" });
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  running.push({ child, closed });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  child.stdin.end();
  const code = await closed;
  const replies = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Message);
  return { code, replies, stderr };
}

function replyTo(replies: Message[], id: unknown): Message {
  const reply = replies.find((message) => message.id === id);
  expect(reply, `reply to ${String(id)}`).toBeDefined();
  expect(reply?.jsonrpc).toBe("2.0");
  return reply as Message;
}

describe("fake-mcp-server.mjs", () => {
  it("answers the MCP handshake, lists and calls echo, writes its marker and exits on stdin close", async () => {
    const marker = join(tmp, "started.marker");
    const { code, replies, stderr } = await exchange(
      [SENTINEL, marker],
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "self-test", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "two", method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hello 1671" } },
        },
        { jsonrpc: "2.0", id: 4, method: "ping" },
        { jsonrpc: "2.0", id: 5, method: "resources/list", params: {} },
      ],
    );

    expect(code, stderr).toBe(0);
    // Five id-bearing requests, five replies: the notification was not answered.
    expect(replies.map((reply) => reply.id)).toEqual([1, "two", 3, 4, 5]);

    const init = replyTo(replies, 1).result as Message;
    expect(init.instructions).toBe(SENTINEL);
    expect(init.protocolVersion).toBe("2025-06-18");
    expect((init.capabilities as Message).tools).toEqual({});
    expect((init.serverInfo as Message).name).toEqual(expect.any(String));

    const tools = (replyTo(replies, "two").result as { tools: Message[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });

    expect(replyTo(replies, 3).result).toEqual({
      content: [{ type: "text", text: "hello 1671" }],
    });
    expect(replyTo(replies, 4).result).toEqual({});
    expect((replyTo(replies, 5).error as Message).code).toBe(-32601);

    expect(existsSync(marker)).toBe(true);
  });

  it("writes the marker at startup, before any request arrives", async () => {
    const marker = join(tmp, "idle.marker");
    const { code, replies } = await exchange([SENTINEL, marker], []);

    expect(code).toBe(0);
    expect(replies).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  });
});
