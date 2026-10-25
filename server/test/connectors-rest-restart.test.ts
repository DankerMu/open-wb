/**
 * s1d-connectors group 3 (task 3.2): omp-runtime「托管 mcp.json 的模式与属主」second half and connectors
 * 「发布失败」on the compiled production entry — the proof that `server.ts` hands the one `mcp.json`
 * publisher and `writeRecord` to the `connectors` module. Cold start reports the eleven modules
 * (`connectors` last) and writes the empty-table bytes; an admin `POST` of a stdio connector rewrites
 * `mcp.json` (a 0640 regular file of this uid, agent dir still 2750, no temp file left); with the agent
 * dir replaced by a regular file the next `POST` is the generic 500, the row stays, and the entry's stderr
 * is exactly the one `mcp_publish_failed` record. The credential sentinel reaches neither stdout nor stderr.
 */
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
  type StartedServer,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const ELEVEN_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
  "models",
  "experts",
  "skills",
  "connectors",
];
/** Low-entropy sentinel (gitleaks): an `env` value that must stay inside `mcp.json`. */
const SECRET = "wb-issue1672-restart-env-token";
const COMMAND = "/usr/bin/gitlab-mcp";
const EMPTY_MCP = '{\n  "mcpServers": {}\n}\n';
const SQLITE_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n\(Use `node[^\n]*\n/u;

let compiled: CompiledServerEntry;
const scratch: string[] = [];

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function adminCookie(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "lisi", password: "demo" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.slice(0, cookie.indexOf(";"));
}

function post(port: number, cookie: string, body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/api/connectors`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function stopped(server: StartedServer): Promise<string> {
  try {
    expect(await server.stop()).toBe(0);
    return server.stderr().replace(SQLITE_WARNING, "");
  } finally {
    await server.dispose();
  }
}

describe("connectors on the compiled entry", () => {
  it("eleven modules; a POST rewrites a 0640 mcp.json; with the agent dir gone the next POST is a 500 with one mcp_publish_failed record", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-wb-connectors-restart-"));
    scratch.push(root);
    const agent = join(root, "state", "home", ".omp", "agent");
    const mcpPath = join(agent, "mcp.json");
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (free) => ({
      env: compiledFixtureEnv(root, free, join(root, "bin", "omp"), {}),
    }));
    let stderr: string;
    try {
      expect(await server.waitForStarted()).toMatchObject({ modules: ELEVEN_MODULES });
      expect(readFileSync(mcpPath, "utf8")).toBe(EMPTY_MCP);
      const cookie = await adminCookie(port);

      const created = await post(port, cookie, {
        name: "gitlab",
        type: "stdio",
        command: COMMAND,
        env: { TOKEN: SECRET },
      });
      expect(created.status).toBe(201);
      expect(await created.text()).not.toContain(SECRET);
      const written = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(written.mcpServers).toEqual({
        gitlab: { type: "stdio", command: COMMAND, args: [], env: { TOKEN: SECRET } },
      });
      expect(lstatSync(mcpPath).isFile()).toBe(true);
      expect(lstatSync(mcpPath).isSymbolicLink()).toBe(false);
      expect(statSync(mcpPath).uid).toBe(process.getuid?.());
      expect(statSync(mcpPath).mode & 0o7777).toBe(0o640);
      expect(statSync(agent).mode & 0o7777).toBe(0o2750);
      expect(readdirSync(agent).sort()).toEqual(["host-overlay.yml", "mcp.json", "models.yml"]);

      rmSync(agent, { recursive: true, force: true });
      writeFileSync(agent, "");
      const failed = await post(port, cookie, {
        name: "wiki",
        type: "stdio",
        command: COMMAND,
        env: { TOKEN: SECRET },
      });
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe('{"error":{"message":"服务器内部错误"}}');
      const listed = await fetch(`http://127.0.0.1:${String(port)}/api/connectors`, {
        headers: { cookie },
      });
      expect(listed.status).toBe(200);
      const { connectors } = (await listed.json()) as { connectors: Array<{ name: string }> };
      expect(connectors.map((connector) => connector.name)).toEqual(["gitlab", "wiki"]);
    } finally {
      stderr = await stopped(server);
    }
    expect(stderr).toBe('{"event":"mcp_publish_failed"}\n');
    for (const output of [server.stdout(), server.stderr()]) {
      expect(output).not.toContain(SECRET);
    }
  }, 120_000);
});
