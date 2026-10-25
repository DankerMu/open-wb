/**
 * s1d-connectors group 2b (issue #1671): the omp premises of connectors「托管 mcp.json」scenario
 * 「官方 omp 读取并按会话停用」against the pinned official binary (design Context「omp 读 MCP 配置」
 * 「`--no-extensions` 不挡 `mcp.json`」「单个 server 停用」「生命周期」「工具名、挂载与审批」; Risks
 * 「`mcp:<名>` 被 omp 称为 legacy」「MCP 发现是后台的」):
 * - under the host's `--no-extensions` omp still reads the user-level `<agentDir>/mcp.json`, written by
 *   group 2a's `writeManagedMcpJson`;
 * - `mcp:other` in the session config file's `disabledExtensions` drops exactly that server: omp never
 *   launches it (its marker file stays absent) and its instructions never reach the system prompt;
 * - with `read` + `write` and no code mode, the MCP tool is mounted under `xd://mcp__echo_echo` and
 *   listed in the `## MCP Tool Routes` section (line suffixes vary by version: contains only).
 *
 * Both servers are support/fake-mcp-server.mjs with their own sentinel and marker path (distinct
 * args, so omp's equivalent-connection dedup keeps both). Discovery runs in the background after the
 * session is set up, so the case polls `get_state.systemPrompt` (no prompt is sent) until echo's
 * sentinel appears in `## MCP Server Instructions` — the positive control — and only then asserts.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-connectors.test.ts --coverage=false
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type McpEntry, writeManagedMcpJson } from "../src/connectors/mcp-json.js";
import type { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { OMP_TEST_OFF, OMP_VERSION, onTeardown } from "./support/omp-official.js";
import { openProxiedWorld } from "./support/omp-official-proxied.js";

const FIXTURE = fileURLToPath(new URL("./support/fake-mcp-server.mjs", import.meta.url));
const ECHO = "ECHO-MCP-SENTINEL-1671";
const OTHER = "OTHER-MCP-SENTINEL-1671";
const DISCOVERY_BOUND_MS = 30_000;
const POLL_MS = 250;
const CASE = { timeout: 90_000 };

function fixtureEntry(name: string, sentinel: string, markerPath: string): McpEntry {
  return {
    name,
    fields: {
      type: "stdio",
      command: process.execPath,
      args: [FIXTURE, sentinel, markerPath],
      env: {},
    },
  };
}

/** The `## <title>` section of `prompt` through the next `## ` heading (`### ` sub-headings stay in). */
function section(prompt: string, title: string): string {
  const start = prompt.indexOf(`## ${title}\n`);
  if (start === -1) {
    return "";
  }
  const next = prompt.indexOf("\n## ", start + 3);
  return next === -1 ? prompt.slice(start) : prompt.slice(start, next);
}

async function systemPrompt(runtime: SessionRuntime): Promise<string> {
  const state = (await runtime.command({ type: "get_state" })) as {
    systemPrompt: string | string[];
  };
  return Array.isArray(state.systemPrompt) ? state.systemPrompt.join("\n") : state.systemPrompt;
}

/** Polls `get_state` until echo's sentinel is in `## MCP Server Instructions`; the last prompt on timeout. */
async function promptOnceEchoIsUp(runtime: SessionRuntime): Promise<string> {
  const deadline = Date.now() + DISCOVERY_BOUND_MS;
  for (;;) {
    const prompt = await systemPrompt(runtime);
    if (section(prompt, "MCP Server Instructions").includes(ECHO) || Date.now() >= deadline) {
      return prompt;
    }
    await delay(POLL_MS);
  }
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: managed mcp.json`, () => {
  it(
    "reads the user-level mcp.json under --no-extensions, drops mcp:other and mounts echo under xd://",
    CASE,
    async () => {
      // Registered before the world, so it is removed after the runtime shut down (last-first).
      const markers = realpathSync(mkdtempSync(join(tmpdir(), "omp-official-connectors-")));
      onTeardown(() => rmSync(markers, { recursive: true, force: true }));
      const echoMarker = join(markers, "echo.started");
      const otherMarker = join(markers, "other.started");
      const world = await openProxiedWorld({
        capabilities: { disabledExtensions: ["mcp:other"], appendSystemPrompt: null },
      });
      // Before the first command: omp spawns lazily, and reads mcp.json at startup.
      await writeManagedMcpJson(world.agentDir, [
        fixtureEntry("echo", ECHO, echoMarker),
        fixtureEntry("other", OTHER, otherMarker),
      ]);

      const prompt = await promptOnceEchoIsUp(world.runtime);

      expect(section(prompt, "MCP Server Instructions")).toContain(`### echo\n${ECHO}`);
      expect(prompt).not.toContain(OTHER);
      expect({ echo: existsSync(echoMarker), other: existsSync(otherMarker) }).toEqual({
        echo: true,
        other: false,
      });
      expect(section(prompt, "MCP Tool Routes")).toContain("`xd://mcp__echo_echo`");
    },
  );
});
