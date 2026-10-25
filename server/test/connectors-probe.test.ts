/**
 * s1d-connectors group 4 (task 4.2): `POST /api/connectors/probe?name=` through the whole mount
 * (connectors「连接器探活」and its scenarios「http 与 stdio」「SSE 应答、超时与在途删除」, the probe leg of
 * 「非管理员」; http-service-skeleton「连接器的归属路由」for the bodyless probe). createApp on a migrated
 * `:memory:` database with `assembly.mcpPublish` = the real `createMcpPublisher(...).publish` over a temp
 * state layout (published once before anything, so `mcp.json`'s mtime is comparable). Oracles: the spec
 * and design D6 literals, the table, `core/audit` `query`, the http MCP fixture's request record, the
 * test-local listeners' connection records, `mcp.json` bytes and mtime, and a marker file the stdio
 * fixture would write if it were ever run.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createMcpPublisher } from "../src/connectors/mcp-json.js";
import { createConnectorStore } from "../src/connectors/store.js";
import { query } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { closedPort, holdServer, scriptedServer } from "./models-probe-helpers.js";
import {
  BAD_REQUEST,
  call,
  expectAnswer,
  FORBIDDEN,
  NOT_FOUND,
  type RawBody,
  UNAUTHORIZED,
} from "./models-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { type FakeMcpHttpStartOptions, start } from "./support/fake-mcp-http.mjs";

/** Low-entropy sentinels (gitleaks): credential values that must never leave `mcp.json` or the probe request. */
const HEADER_KEY = "wb-issue1673-header-key";
const HEADER_TRACE = "wb-issue1673-header-trace";
const ENV_SECRET = "wb-issue1673-env-token";
const SENTINELS = [HEADER_KEY, HEADER_TRACE, ENV_SECRET];
/** Registered headers; `Accept` / `Content-Type` are replaced by the probe's fixed two (D6 判定细则). */
const HEADERS = {
  "x-api-key": HEADER_KEY,
  "x-trace": HEADER_TRACE,
  Accept: "text/plain",
  "Content-Type": "text/xml",
};
/** Design D6's request body, verbatim. */
const INITIALIZE =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"workbuddy-probe","version":"1"}}}';
const NOT_MCP = "响应不是 MCP 初始化结果";
const UNREACHABLE = "无法连接";
const TIMED_OUT = "超时";
const NO_COMMAND = "命令不存在或不可执行";
const RESULT_JSON = '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}';
const MALFORMED: RawBody = { raw: '{"name": ', type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };
const SECOND = { totalDeadlineMs: 1000 };
const ADMIN_VIEW_KEYS = [
  "args",
  "command",
  "description",
  "enabled",
  "envKeys",
  "headerKeys",
  "name",
  "probe",
  "type",
  "updatedAt",
  "url",
];

type Expected = { status: "ok" | "failed"; message: string | null };

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  root: string;
  agentDir: string;
  cookies: { admin: string; member: string };
}

const opened: Array<() => Promise<void>> = [];
let outputs: Array<MockInstance<typeof process.stdout.write>> = [];
beforeEach(() => {
  outputs = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
});
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
  const written = outputs.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));
  for (const spy of outputs) spy.mockRestore();
  for (const secret of SENTINELS) expect(written.join("")).not.toContain(secret);
});

async function openWorld(probeDeadlines?: { totalDeadlineMs: number }): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "connectors-probe-")));
  const stateDir = join(root, "state");
  ensureOmpStateLayout(stateDir);
  const agentDir = ompAgentDir(stateDir);
  const db = openDb(":memory:");
  const publisher = createMcpPublisher({
    agentDir: () => agentDir,
    store: createConnectorStore(db),
  });
  await publisher.publish();
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: {
        bin: join(root, "omp"),
        sandboxRoot: join(root, "sandbox"),
        stateDir,
        modelId: "m1",
        idleMs: 600_000,
      },
      mcpPublish: publisher.publish,
      ...(probeDeadlines === undefined ? {} : { probeDeadlines }),
    },
  });
  opened.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { app, db, root, agentDir, cookies };
}

async function mcpServer(options?: FakeMcpHttpStartOptions) {
  const server = await start(options);
  opened.push(() => server.close());
  return server;
}

const local = (port: number, path = "/mcp") => `http://127.0.0.1:${String(port)}${path}`;
const probeUrl = (name: string) => `/api/connectors/probe?name=${name}`;

async function addHttp(world: World, name: string, url: string, extra = {}): Promise<void> {
  const body = { name, type: "http", url, headers: HEADERS, ...extra };
  expectAnswer(await call(world, "admin", "POST", "/api/connectors", body), 201);
}

async function addStdio(world: World, name: string, command: string): Promise<void> {
  const body = { name, type: "stdio", command, env: { TOKEN: ENV_SECRET } };
  expectAnswer(await call(world, "admin", "POST", "/api/connectors", body), 201);
}

function probeColumns(db: DatabaseSync, name: string): unknown {
  const row = db
    .prepare("SELECT probe_status, probe_message, probe_at FROM connectors WHERE name = ?")
    .get(name);
  return row === undefined ? undefined : { ...row };
}

function probeAudits(db: DatabaseSync) {
  return query(db, { id: "u3", role: "管理员" }, { limit: 200 })
    .filter((event) => event.kind === "connector.probe")
    .reverse()
    .map(({ actorId, kind, title, detail, workspaceId }) => ({
      actorId,
      kind,
      title,
      detail,
      workspaceId,
    }));
}

/** What a refused request must not move: table, audit, `mcp.json` bytes and mtime. */
function footprint(world: World) {
  const file = join(world.agentDir, "mcp.json");
  return {
    rows: world.db
      .prepare("SELECT * FROM connectors ORDER BY name")
      .all()
      .map((row) => ({ ...row })),
    audits: query(world.db, { id: "u3", role: "管理员" }, { limit: 200 }),
    mcp: readFileSync(file, "utf8"),
    mtime: statSync(file).mtimeMs,
  };
}

/** One admin probe: `mcp.json` bytes and mtime untouched, no sentinel in the answer; with its time window. */
async function probe(world: World, name: string) {
  const file = join(world.agentDir, "mcp.json");
  const bytes = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;
  const from = Date.now();
  const response = await call(world, "admin", "POST", probeUrl(name));
  const to = Date.now();
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(statSync(file).mtimeMs).toBe(mtime);
  for (const secret of SENTINELS) expect(response.body).not.toContain(secret);
  return { response, from, to };
}

/** 200 admin view whose probe is `expected` with `at` inside the call; the row agrees; `enabled` kept. */
function expectProbed(
  world: World,
  name: string,
  { response, from, to }: { response: LightMyRequestResponse; from: number; to: number },
  expected: Expected,
  enabled = true,
): void {
  expectAnswer(response, 200);
  const view = response.json() as { name: string; enabled: boolean; probe: { at: number } };
  expect(Object.keys(view).sort()).toEqual(ADMIN_VIEW_KEYS);
  expect([view.name, view.enabled]).toEqual([name, enabled]);
  expect(view.probe).toEqual({ ...expected, at: view.probe.at });
  expect(view.probe.at).toBeGreaterThanOrEqual(from);
  expect(view.probe.at).toBeLessThanOrEqual(to);
  expect(probeColumns(world.db, name)).toEqual({
    probe_status: expected.status,
    probe_message: expected.message,
    probe_at: view.probe.at,
  });
}

const audit = (name: string, type: string, status: string) => ({
  actorId: "u3",
  kind: "connector.probe",
  title: `探活连接器 ${name}`,
  detail: { name, type, status },
  workspaceId: null,
});

/** A shell script that would leave `marker` behind if anything ran it. */
function executable(root: string, marker: string): string {
  const path = join(root, "fake-mcp-stdio");
  writeFileSync(path, `#!/bin/sh\necho ran > '${marker}'\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("次序：401 / 403 / 400 / 404 先于 body 与探活", () => {
  const VARIANTS = [
    ["malformed body", probeUrl("wiki")],
    ["missing name", "/api/connectors/probe"],
    ["unknown name", probeUrl("nope")],
  ] as const;
  const CASES = (["anonymous", "member"] as const).flatMap((who) =>
    VARIANTS.map(([variant, url]) => [who, variant, url] as const),
  );

  it.each(CASES)("%s (%s) → 401 / 403, nothing probed or written", async (who, _variant, url) => {
    const world = await openWorld();
    const server = await mcpServer();
    await addHttp(world, "wiki", local(server.port));
    const before = footprint(world);
    const response = await call(world, who, "POST", url, MALFORMED);
    if (who === "anonymous") {
      expectAnswer(response, 401, UNAUTHORIZED);
    } else {
      expectAnswer(response, 403, FORBIDDEN);
    }
    expect(footprint(world)).toEqual(before);
    expect(server.requests()).toEqual([]);
  });

  it("admin: name 400 / unknown 404 ahead of a malformed body; any body ({} too) is the content-parser 400", async () => {
    const world = await openWorld();
    const server = await mcpServer();
    await addHttp(world, "wiki", local(server.port));
    const before = footprint(world);
    const cases: Array<[string, unknown, number, unknown]> = [
      ["/api/connectors/probe", MALFORMED, 400, BAD_REQUEST],
      ["/api/connectors/probe?name=", MALFORMED, 400, BAD_REQUEST],
      ["/api/connectors/probe?name=wiki&name=wiki", MALFORMED, 400, BAD_REQUEST],
      [probeUrl("nope"), MALFORMED, 404, NOT_FOUND],
      [probeUrl("wiki"), {}, 400, BAD_REQUEST],
      [probeUrl("wiki"), MALFORMED, 400, BAD_REQUEST],
      [probeUrl("wiki"), TEXT, 400, BAD_REQUEST],
    ];
    for (const [url, body, status, envelope] of cases) {
      expectAnswer(await call(world, "admin", "POST", url, body), status, envelope);
    }
    expect(footprint(world)).toEqual(before);
    expect(server.requests()).toEqual([]);
  });
});

describe("http 与 stdio", () => {
  it("ok / HTTP 401 / not an initialize result / 无法连接 / stdio ok / three stdio refusals, one audit each", async () => {
    const world = await openWorld();
    const mcp = await mcpServer();
    const echo = await mcpServer({
      status: 401,
      body: (request) => JSON.stringify({ error: "unauthorized", headers: request.headers }),
    });
    const notMcp = await mcpServer({ body: '{"ok":true}' });
    const marker = join(world.root, "ran");
    const directory = join(world.root, "a-directory");
    mkdirSync(directory);
    const plain = join(world.root, "plain-file");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    // A disabled connector is probed all the same, with its credentials.
    await addHttp(world, "mcp", local(mcp.port, "/mcp/v1?tenant=a"), { enabled: false });
    await addHttp(world, "echo", local(echo.port));
    await addHttp(world, "notmcp", local(notMcp.port));
    await addHttp(world, "down", local(await closedPort()));
    await addStdio(world, "tool", executable(world.root, marker));
    await addStdio(world, "missing", join(world.root, "no-such-command"));
    await addStdio(world, "plain", plain);
    await addStdio(world, "folder", directory);

    const ok = await probe(world, "mcp");
    expectProbed(world, "mcp", ok, { status: "ok", message: null }, false);
    const unauthorized = await probe(world, "echo");
    expectAnswer(unauthorized.response, 200);
    const message = (unauthorized.response.json() as { probe: { message: string } }).probe.message;
    expect(message.startsWith("HTTP 401：")).toBe(true);
    expect(message).toContain("[已移除]");
    // The excerpt after the prefix is at most 200 code points (spec: 摘要 ≤200 码点).
    expect(Array.from(message.slice("HTTP 401：".length)).length).toBeLessThanOrEqual(200);
    expectProbed(world, "echo", unauthorized, { status: "failed", message });
    const cases: Array<[string, "http" | "stdio", Expected]> = [
      ["notmcp", "http", { status: "failed", message: NOT_MCP }],
      ["down", "http", { status: "failed", message: UNREACHABLE }],
      ["tool", "stdio", { status: "ok", message: null }],
      ["missing", "stdio", { status: "failed", message: NO_COMMAND }],
      ["plain", "stdio", { status: "failed", message: NO_COMMAND }],
      ["folder", "stdio", { status: "failed", message: NO_COMMAND }],
    ];
    for (const [name, , expected] of cases) {
      expectProbed(world, name, await probe(world, name), expected);
    }
    expect(probeAudits(world.db)).toEqual([
      audit("mcp", "http", "ok"),
      audit("echo", "http", "failed"),
      ...cases.map(([name, type, expected]) => audit(name, type, expected.status)),
    ]);
    // The echoed request really carried both sentinels: the excerpt had them to redact.
    for (const value of [HEADER_KEY, HEADER_TRACE]) {
      expect(JSON.stringify(echo.requests())).toContain(value);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("the request: POST to the url as registered, registered headers with the fixed two, D6's initialize body", async () => {
    const world = await openWorld();
    const mcp = await mcpServer();
    await addHttp(world, "mcp", local(mcp.port, "/mcp/v1?tenant=a"));
    expectProbed(world, "mcp", await probe(world, "mcp"), { status: "ok", message: null });
    const requests = mcp.requests();
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect([request?.method, request?.url]).toEqual(["POST", "/mcp/v1?tenant=a"]);
    expect(request?.headers).toMatchObject({
      "x-api-key": HEADER_KEY,
      "x-trace": HEADER_TRACE,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(request?.body).toEqual(JSON.parse(INITIALIZE));
  });

  it("a 302 is not followed: HTTP 302 with its body as the excerpt", async () => {
    const world = await openWorld();
    const target = await mcpServer();
    const port = await scriptedServer((response) => {
      response.writeHead(302, { location: local(target.port) });
      response.end("moved");
    });
    await addHttp(world, "moved", local(port));
    const result = await probe(world, "moved");
    expectProbed(world, "moved", result, { status: "failed", message: "HTTP 302：moved" });
    expect(target.requests()).toEqual([]);
  });

  it("a connection reset while the 2xx body is read is 无法连接", async () => {
    const world = await openWorld();
    const port = await scriptedServer((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"jsonrpc":');
      setTimeout(() => response.socket?.destroy(), 50);
    });
    await addHttp(world, "reset", local(port));
    const result = await probe(world, "reset");
    expectProbed(world, "reset", result, { status: "failed", message: UNREACHABLE });
  });
});

describe("判定：JSON 与 SSE 的应答体", () => {
  const OVERSIZE = `{"jsonrpc":"2.0","id":1,"result":{"pad":"${"x".repeat(64 * 1024)}"}}`;
  const CASES: Array<[string, string, string, Expected]> = [
    [
      "JSON with charset",
      "application/json; charset=utf-8",
      RESULT_JSON,
      { status: "ok", message: null },
    ],
    [
      "SSE, upper case, CR line ends",
      "Text/Event-Stream; charset=utf-8",
      `: hi\rdata: ${RESULT_JSON}\r\r`,
      { status: "ok", message: null },
    ],
    [
      "SSE: an event without data is skipped",
      "text/event-stream",
      `event: ping\n\ndata: ${RESULT_JSON}\n\n`,
      { status: "ok", message: null },
    ],
    [
      "SSE ends before any event is dispatched",
      "text/event-stream",
      `: hi\ndata: ${RESULT_JSON}\n`,
      { status: "failed", message: NOT_MCP },
    ],
    [
      "SSE first event is not a result",
      "text/event-stream",
      `data: {"jsonrpc":"2.0","id":1,"error":{}}\n\ndata: ${RESULT_JSON}\n\n`,
      { status: "failed", message: NOT_MCP },
    ],
    ["over 64 KiB", "application/json", OVERSIZE, { status: "failed", message: NOT_MCP }],
    ["an array", "application/json", `[${RESULT_JSON}]`, { status: "failed", message: NOT_MCP }],
    [
      "result null",
      "application/json",
      '{"jsonrpc":"2.0","id":1,"result":null}',
      { status: "failed", message: NOT_MCP },
    ],
    [
      "result a string",
      "application/json",
      '{"jsonrpc":"2.0","id":1,"result":"x"}',
      { status: "failed", message: NOT_MCP },
    ],
    [
      "jsonrpc 1.0",
      "application/json",
      '{"jsonrpc":"1.0","id":1,"result":{}}',
      { status: "failed", message: NOT_MCP },
    ],
    ["not JSON", "text/html", "<html></html>", { status: "failed", message: NOT_MCP }],
  ];

  it.each(CASES)("%s", async (_label, contentType, body, expected) => {
    const world = await openWorld();
    const server = await mcpServer({ contentType, body });
    await addHttp(world, "mcp", local(server.port));
    expectProbed(world, "mcp", await probe(world, "mcp"), expected);
  });
});

describe("SSE 应答、超时与在途删除", () => {
  it("SSE: comment, multi-line data, stream left open → ok well inside a 1 s deadline", async () => {
    const world = await openWorld(SECOND);
    const server = await mcpServer({ reply: "sse" });
    await addHttp(world, "stream", local(server.port));
    const result = await probe(world, "stream");
    expectProbed(world, "stream", result, { status: "ok", message: null });
    expect(result.to - result.from).toBeLessThan(1000);
    expect(probeAudits(world.db)).toEqual([audit("stream", "http", "ok")]);
  });

  it("a listener that never answers: 超时 under the injected 1 s deadline", async () => {
    const world = await openWorld(SECOND);
    const hold = await holdServer();
    await addHttp(world, "hang", local(hold.port));
    const result = await probe(world, "hang");
    expectProbed(world, "hang", result, { status: "failed", message: TIMED_OUT });
    expect(result.to - result.from).toBeGreaterThanOrEqual(900);
    expect(probeAudits(world.db)).toEqual([audit("hang", "http", "failed")]);
  });

  it("two probes of one connector run one after the other", async () => {
    const world = await openWorld(SECOND);
    const hold = await holdServer();
    await addHttp(world, "hang", local(hold.port));
    const both = await Promise.all([probe(world, "hang"), probe(world, "hang")]);
    const at = both.map(({ response }) => {
      expectAnswer(response, 200);
      const view = response.json() as { probe: { status: string; at: number; message: string } };
      expect([view.probe.status, view.probe.message]).toEqual(["failed", TIMED_OUT]);
      return view.probe.at;
    });
    const [first = 0, second = 0] = [...at].sort((a, b) => a - b);
    expect(second).toBeGreaterThanOrEqual(first + 900);
    expect(hold.openBefore).toEqual([0, 0]);
    expect(probeAudits(world.db)).toHaveLength(2);
  });

  it("DELETE while the probe is in flight: 204, then the probe is 404 and nothing is written", async () => {
    const world = await openWorld(SECOND);
    const hold = await holdServer();
    const mcp = await mcpServer();
    await addHttp(world, "hang", local(hold.port));
    await addHttp(world, "other", local(mcp.port));
    expectProbed(world, "other", await probe(world, "other"), { status: "ok", message: null });
    const other = probeColumns(world.db, "other");
    const pending = call(world, "admin", "POST", probeUrl("hang"));
    await hold.accepted(1);
    expectAnswer(await call(world, "admin", "DELETE", "/api/connectors?name=hang"), 204);
    const response = await pending;
    expectAnswer(response, 404, NOT_FOUND);
    for (const secret of SENTINELS) expect(response.body).not.toContain(secret);
    expect(probeColumns(world.db, "hang")).toBeUndefined();
    expect(probeColumns(world.db, "other")).toEqual(other);
    expect(probeAudits(world.db)).toEqual([audit("other", "http", "ok")]);
  });
});
