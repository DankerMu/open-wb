/**
 * s1d-connectors group 3 (task 3.2): connectors「连接器管理端点」and its scenarios, plus「托管 mcp.json」's
 * 「内容与启停」/「发布失败」through REST and omp-runtime「托管 mcp.json 的模式与属主」after REST writes, on the
 * whole mount: createApp on a migrated `:memory:` database with `assembly.mcpPublish` = the real
 * `createMcpPublisher(...).publish` over a temp state layout (the entry's single publisher minus its stage
 * gate) and a recording `onPublishFailed`. Oracles: spec literals (envelopes, views, audit detail, the
 * `mcp.json` text rule), the table, `core/audit` `query` and the file on disk. The compiled-entry half
 * (startup modules, stderr record) is `connectors-rest-restart.test.ts`.
 */
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createMcpPublisher } from "../src/connectors/mcp-json.js";
import { createConnectorStore } from "../src/connectors/store.js";
import { query } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import {
  BAD_REQUEST,
  CONFLICT,
  call,
  expectAnswer,
  FORBIDDEN,
  GENERIC_500,
  NOT_FOUND,
  type RawBody,
  UNAUTHORIZED,
} from "./models-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

/** Low-entropy sentinels (gitleaks): credential values that must never leave `mcp.json`. */
const ENV_SECRET = "wb-issue1672-env-token";
const HEADER_SECRET = "wb-issue1672-header-token";
const COMMAND = "/usr/bin/gitlab-mcp";
const URL = "https://wiki.example/mcp";
const KIB64 = 64 * 1024;
const MALFORMED: RawBody = { raw: '{"name": ', type: "application/json" };
const EMPTY_BODY: RawBody = { raw: "", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };
const EMPTY_MCP = '{\n  "mcpServers": {}\n}\n';
const NEVER = { status: "never", at: null, message: null };
const GITLAB = { name: "gitlab", type: "stdio", command: COMMAND, env: { TOKEN: ENV_SECRET } };
const WIKI = { name: "wiki", type: "http", url: URL, headers: { authorization: HEADER_SECRET } };
const STDIO = { type: "stdio", command: COMMAND } as const;
const HTTP = { type: "http", url: URL } as const;

/** omp's `${NAME}` interpolation, spelled so no string literal carries a template placeholder. */
const interp = (name: string) => `$\{${name}}`;

/** The spec's `mcp.json` text rule, written out independently of `mcp-json.ts`. */
function mcpText(servers: Record<string, unknown>): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/** A JSON body padded with whitespace to exactly `totalBytes`. */
function padded(totalBytes: number, fields: object): RawBody {
  const json = JSON.stringify(fields);
  const pad = totalBytes - Buffer.byteLength(json);
  return { raw: `${json.slice(0, -1)}${" ".repeat(pad)}}`, type: "application/json" };
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  stateDir: string;
  agentDir: string;
  failed: Array<{ event: string }>;
  cookies: { admin: string; member: string };
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

async function openWorld(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "connectors-rest-")));
  const stateDir = join(root, "state");
  ensureOmpStateLayout(stateDir);
  const agentDir = ompAgentDir(stateDir);
  const db = openDb(":memory:");
  const publisher = createMcpPublisher({
    agentDir: () => agentDir,
    store: createConnectorStore(db),
  });
  // The entry's startup publication (`mcp_json`): the empty-table bytes are on disk before any write.
  await publisher.publish();
  const failed: Array<{ event: string }> = [];
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
      onPublishFailed: (record) => {
        failed.push(record);
      },
    },
  });
  opened.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { app, db, stateDir, agentDir, failed, cookies };
}

function mcpBytes(world: World): string {
  return readFileSync(join(world.agentDir, "mcp.json"), "utf8");
}

function rows(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT * FROM connectors ORDER BY name")
    .all()
    .map((row) => ({ ...row }));
}

/** Every `connector.*` audit event, oldest first, as the admin audit view reads them. */
function audits(db: DatabaseSync) {
  return query(db, { id: "u3", role: "管理员" }, { limit: 200 })
    .filter((event) => event.kind.startsWith("connector."))
    .reverse()
    .map(({ actorId, kind, title, detail, workspaceId }) => ({
      actorId,
      kind,
      title,
      detail,
      workspaceId,
    }));
}

/** What a refused request must not move: table, audit, `mcp.json` bytes and mtime, failure records. */
function footprint(world: World) {
  return {
    rows: rows(world.db),
    audits: audits(world.db),
    mcp: mcpBytes(world),
    mtime: statSync(join(world.agentDir, "mcp.json")).mtimeMs,
    failed: world.failed.length,
  };
}

async function register(world: World, body: object): Promise<void> {
  expectAnswer(await call(world, "admin", "POST", "/api/connectors", body), 201);
}

/** No credential sentinel in any text the request side or audit side can see. */
function expectNoSecrets(...texts: string[]): void {
  for (const text of texts) {
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain(HEADER_SECRET);
  }
}

function auditText(db: DatabaseSync): string {
  return JSON.stringify(query(db, { id: "u3", role: "管理员" }, { limit: 200 }));
}

function gitlabView(extra: Record<string, unknown> = {}) {
  return {
    name: "gitlab",
    type: "stdio",
    description: "",
    enabled: true,
    command: COMMAND,
    args: [],
    envKeys: ["TOKEN"],
    url: null,
    headerKeys: null,
    probe: NEVER,
    updatedAt: expect.any(Number),
    ...extra,
  };
}

describe("非管理员与未认证先于 body 与 name", () => {
  const WRITES = ["POST", "PUT", "DELETE"] as const;
  const VARIANTS = [
    ["malformed body", "/api/connectors?name=gitlab"],
    ["missing name", "/api/connectors"],
    ["unknown name", "/api/connectors?name=nope"],
  ] as const;
  const CASES = (["anonymous", "member"] as const).flatMap((who) =>
    WRITES.flatMap((method) =>
      VARIANTS.map(([variant, url]) => [who, method, variant, url] as const),
    ),
  );

  it.each(CASES)("%s %s (%s) → 401 / 403, nothing moves", async (who, method, _variant, url) => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    const response = await call(world, who, method, url, MALFORMED);
    if (who === "anonymous") {
      expectAnswer(response, 401, UNAUTHORIZED);
    } else {
      expectAnswer(response, 403, FORBIDDEN);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("GET: anonymous 401; a member sees only enabled rows as exactly {name, type, description}", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    await register(world, { ...WIKI, enabled: false });
    expectAnswer(await call(world, "anonymous", "GET", "/api/connectors"), 401, UNAUTHORIZED);
    const member = await call(world, "member", "GET", "/api/connectors");
    expectAnswer(member, 200, { connectors: [{ name: "gitlab", type: "stdio", description: "" }] });
    const admin = await call(world, "admin", "GET", "/api/connectors");
    expectAnswer(admin, 200, {
      connectors: [
        gitlabView(),
        {
          name: "wiki",
          type: "http",
          description: "",
          enabled: false,
          command: null,
          args: null,
          envKeys: null,
          url: URL,
          headerKeys: ["authorization"],
          probe: NEVER,
          updatedAt: expect.any(Number),
        },
      ],
    });
    expectNoSecrets(member.payload, admin.payload, auditText(world.db));
  });
});

describe("name 与查找", () => {
  it("PUT / DELETE: missing, empty or repeated name 400 and an unknown name 404, ahead of a malformed body", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    for (const method of ["PUT", "DELETE"] as const) {
      for (const url of [
        "/api/connectors",
        "/api/connectors?name=",
        "/api/connectors?name=gitlab&name=gitlab",
      ]) {
        expectAnswer(await call(world, "admin", method, url, MALFORMED), 400, BAD_REQUEST);
      }
      expectAnswer(
        await call(world, "admin", method, "/api/connectors?name=nope", MALFORMED),
        404,
        NOT_FOUND,
      );
    }
    expectAnswer(await call(world, "admin", "DELETE", "/api/connectors?name=nope"), 404, NOT_FOUND);
    expect(footprint(world)).toEqual(before);
  });

  it("a second POST of the same name is 409 conflict and moves nothing", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    const response = await call(world, "admin", "POST", "/api/connectors", GITLAB);
    expectAnswer(response, 409, CONFLICT);
    expect(footprint(world)).toEqual(before);
  });
});

describe("键集、上限与保留值的拒绝", () => {
  it.each([
    ["stdio with url", { name: "x", type: "stdio", command: COMMAND, url: URL }],
    ["http with env", { name: "y", type: "http", url: URL, env: { A: "1" } }],
    ["unknown key", { name: "z", type: "stdio", command: COMMAND, extra: 1 }],
    ["null on create", { name: "z", type: "stdio", command: COMMAND, env: { TOKEN: null } }],
  ])("POST %s → 400, nothing moves", async (_label, body) => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    expectAnswer(await call(world, "admin", "POST", "/api/connectors", body), 400, BAD_REQUEST);
    expect(footprint(world)).toEqual(before);
  });

  it.each([
    ["null for a missing key", { command: COMMAND, env: { NOPE: null } }],
    ["a name key", { name: "gitlab", command: COMMAND, env: { TOKEN: null } }],
    ["a type key", { type: "stdio", command: COMMAND, env: { TOKEN: null } }],
    ["the other type's key", { command: COMMAND, env: { TOKEN: null }, url: URL }],
  ])("PUT %s → 400, nothing moves", async (_label, body) => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    const url = "/api/connectors?name=gitlab";
    expectAnswer(await call(world, "admin", "PUT", url, body), 400, BAD_REQUEST);
    expect(footprint(world)).toEqual(before);
  });

  it("with 32 connectors the 33rd POST is 400 and moves nothing", async () => {
    const world = await openWorld();
    const store = createConnectorStore(world.db);
    for (let i = 0; i < 32; i += 1) {
      store.create({ name: "a".repeat(i + 1), ...STDIO });
    }
    const before = footprint(world);
    expect(before.rows).toHaveLength(32);
    const response = await call(world, "admin", "POST", "/api/connectors", GITLAB);
    expectAnswer(response, 400, BAD_REQUEST);
    expect(footprint(world)).toEqual(before);
  });
});

describe("omp 会改写的取值被拒", () => {
  const BEARER = `Bearer ${interp("WORKBUDDY_MODEL_TOKEN")}`;
  const REFUSED: Array<[string, Record<string, unknown>]> = [
    ["!cat /etc/passwd", { name: "gitlab", ...STDIO, env: { TOKEN: "!cat /etc/passwd" } }],
    [BEARER, { name: "wiki", ...HTTP, headers: { authorization: BEARER } }],
    [
      "WORKBUDDY_MODEL_TOKEN",
      { name: "wiki", ...HTTP, headers: { authorization: "WORKBUDDY_MODEL_TOKEN" } },
    ],
    ["PATH", { name: "gitlab", ...STDIO, env: { X: "PATH" } }],
    ["HOME", { name: "gitlab", ...STDIO, env: { X: "HOME" } }],
    [interp("HOME"), { name: "gitlab", ...STDIO, args: [interp("HOME")] }],
    ["git2", { name: "git2", ...STDIO }],
    ["Git", { name: "Git", ...STDIO }],
    ["git_lab", { name: "git_lab", ...STDIO }],
    ["node", { name: "gitlab", type: "stdio", command: "node" }],
  ];

  it.each(REFUSED)(
    "%s → 400 without echo; table, audit and mcp.json unchanged",
    async (value, body) => {
      const world = await openWorld();
      const before = footprint(world);
      const response = await call(world, "admin", "POST", "/api/connectors", body);
      expectAnswer(response, 400, BAD_REQUEST);
      expect(response.payload).not.toContain(value);
      expect(footprint(world)).toEqual(before);
      expect(mcpBytes(world)).toBe(EMPTY_MCP);
    },
  );
});

describe("PUT 整体替换", () => {
  it("两种视图与保留值: a null keeps TOKEN, EXTRA is added, no sentinel in any view", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    await register(world, { ...WIKI, enabled: false });
    const url = "/api/connectors?name=gitlab";
    const put = await call(world, "admin", "PUT", url, {
      command: COMMAND,
      env: { TOKEN: null, EXTRA: "1" },
    });
    expectAnswer(put, 200, gitlabView({ envKeys: ["EXTRA", "TOKEN"] }));
    expect(mcpBytes(world)).toBe(
      mcpText({
        gitlab: {
          type: "stdio",
          command: COMMAND,
          args: [],
          env: { EXTRA: "1", TOKEN: ENV_SECRET },
        },
      }),
    );
    const member = await call(world, "member", "GET", "/api/connectors");
    expectNoSecrets(put.payload, member.payload, auditText(world.db));
  });

  it("omitted keys take the POST defaults: description, args, env and enabled", async () => {
    const world = await openWorld();
    await register(world, { ...GITLAB, description: "代码库", args: ["--stdio"], enabled: false });
    const put = await call(world, "admin", "PUT", "/api/connectors?name=gitlab", {
      command: COMMAND,
    });
    expectAnswer(put, 200, gitlabView({ envKeys: [] }));
    expect(mcpBytes(world)).toBe(
      mcpText({ gitlab: { type: "stdio", command: COMMAND, args: [], env: {} } }),
    );
  });

  it("启用开关不丢凭证: disabling drops gitlab from mcp.json, re-enabling brings TOKEN back", async () => {
    const world = await openWorld();
    await register(world, { ...GITLAB, args: ["--stdio"] });
    const url = "/api/connectors?name=gitlab";
    const toggle = { command: COMMAND, args: ["--stdio"], env: { TOKEN: null } };
    const off = await call(world, "admin", "PUT", url, { ...toggle, enabled: false });
    expectAnswer(off, 200, gitlabView({ args: ["--stdio"], enabled: false }));
    expect(mcpBytes(world)).toBe(EMPTY_MCP);
    const on = await call(world, "admin", "PUT", url, { ...toggle, enabled: true });
    expectAnswer(on, 200, gitlabView({ args: ["--stdio"] }));
    expect(mcpBytes(world)).toBe(
      mcpText({
        gitlab: { type: "stdio", command: COMMAND, args: ["--stdio"], env: { TOKEN: ENV_SECRET } },
      }),
    );
    expectNoSecrets(off.payload, on.payload, auditText(world.db));
  });

  it("探活状态随连接参数复位: a description change keeps an ok probe, an args change resets it", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    const probeAt = FIXED_NOW - 1000;
    world.db
      .prepare("UPDATE connectors SET probe_status = 'ok', probe_at = ? WHERE name = 'gitlab'")
      .run(probeAt);
    const url = "/api/connectors?name=gitlab";
    const ok = { status: "ok", at: probeAt, message: null };
    const described = await call(world, "admin", "PUT", url, {
      description: "代码库",
      command: COMMAND,
      env: { TOKEN: null },
    });
    expectAnswer(described, 200, gitlabView({ description: "代码库", probe: ok }));
    const reargued = await call(world, "admin", "PUT", url, {
      command: COMMAND,
      args: ["--verbose"],
      env: { TOKEN: null },
    });
    expectAnswer(reargued, 200, gitlabView({ args: ["--verbose"], probe: NEVER }));
  });
});

describe("托管 mcp.json 随写入", () => {
  it("内容与启停: register stdio b and http a, disable b, delete a — three exact files, 0640, no temp files", async () => {
    const world = await openWorld();
    const entries = readdirSync(world.agentDir).sort();
    expect(entries).toContain("mcp.json");
    const b = { command: "/usr/bin/b-mcp", args: ["--stdio"], env: { TOKEN: ENV_SECRET } };
    const a = { url: URL, headers: { authorization: HEADER_SECRET } };
    const responses = [
      await call(world, "admin", "POST", "/api/connectors", { name: "b", type: "stdio", ...b }),
      await call(world, "admin", "POST", "/api/connectors", { name: "a", type: "http", ...a }),
    ];
    const both = mcpBytes(world);
    expect(both).toBe(mcpText({ a: { type: "http", ...a }, b: { type: "stdio", ...b } }));
    responses.push(
      await call(world, "admin", "PUT", "/api/connectors?name=b", {
        ...b,
        env: { TOKEN: null },
        enabled: false,
      }),
    );
    const onlyA = mcpBytes(world);
    expect(onlyA).toBe(mcpText({ a: { type: "http", ...a } }));
    responses.push(await call(world, "admin", "DELETE", "/api/connectors?name=a"));
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 200, 204]);
    expect(mcpBytes(world)).toBe(EMPTY_MCP);

    const path = join(world.agentDir, "mcp.json");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(statSync(path).uid).toBe(process.getuid?.());
    expect(statSync(path).mode & 0o7777).toBe(0o640);
    expect(readdirSync(world.agentDir).sort()).toEqual(entries);
    expectNoSecrets(...responses.map((response) => response.payload), auditText(world.db));
    expect(world.failed).toEqual([]);
  });

  it("发布失败: generic 500, exactly one record, row and audit kept; after recovery the next write lands both", async () => {
    const world = await openWorld();
    rmSync(world.agentDir, { recursive: true, force: true });
    writeFileSync(world.agentDir, "");
    const failed = await call(world, "admin", "POST", "/api/connectors", GITLAB);
    expectAnswer(failed, 500, GENERIC_500);
    expect(world.failed).toEqual([{ event: "mcp_publish_failed" }]);
    expect(rows(world.db)).toHaveLength(1);
    expect(audits(world.db).map((event) => event.kind)).toEqual(["connector.create"]);
    expectNoSecrets(failed.payload);

    rmSync(world.agentDir, { force: true });
    ensureOmpStateLayout(world.stateDir);
    await register(world, WIKI);
    expect(world.failed).toHaveLength(1);
    expect(mcpBytes(world)).toBe(
      mcpText({
        gitlab: { type: "stdio", command: COMMAND, args: [], env: { TOKEN: ENV_SECRET } },
        wiki: { type: "http", url: URL, headers: { authorization: HEADER_SECRET } },
      }),
    );
  });
});

describe("审计", () => {
  it("create / update / delete: kinds connector.*, actor, title with the name only, detail exactly {name, type}", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    await register(world, WIKI);
    const url = "/api/connectors?name=gitlab";
    const put = await call(world, "admin", "PUT", url, { command: COMMAND, env: { TOKEN: null } });
    expectAnswer(put, 200);
    expectAnswer(await call(world, "admin", "DELETE", url), 204);
    const event = (kind: string, title: string, name: string, type: string) => ({
      actorId: "u3",
      kind,
      title,
      detail: { name, type },
      workspaceId: null,
    });
    expect(audits(world.db)).toEqual([
      event("connector.create", "登记连接器 gitlab", "gitlab", "stdio"),
      event("connector.create", "登记连接器 wiki", "wiki", "http"),
      event("connector.update", "修改连接器 gitlab", "gitlab", "stdio"),
      event("connector.delete", "删除连接器 gitlab", "gitlab", "stdio"),
    ]);
    const text = auditText(world.db);
    expectNoSecrets(text);
    expect(text).not.toContain(COMMAND);
    expect(text).not.toContain(URL);
  });
});

describe("content-parser 归属", () => {
  const BODIES: Array<[string, RawBody]> = [
    ["malformed JSON", MALFORMED],
    ["an empty JSON body", EMPTY_BODY],
    ["text/plain", TEXT],
    ["a body over 64 KiB", padded(KIB64 + 1, GITLAB)],
  ];
  const CASES = (["/api/connectors", "/api/connectors?name=gitlab"] as const).flatMap((url) =>
    BODIES.map(([label, body]) => [url === "/api/connectors" ? "POST" : "PUT", url, label, body]),
  ) as Array<["POST" | "PUT", string, string, RawBody]>;

  it.each(CASES)(
    "admin %s %s with %s → exact 400, nothing moves",
    async (method, url, _l, body) => {
      const world = await openWorld();
      await register(world, GITLAB);
      const before = footprint(world);
      expectAnswer(await call(world, "admin", method, url, body), 400, BAD_REQUEST);
      expect(footprint(world)).toEqual(before);
    },
  );

  it("a body just under 64 KiB is parsed (the limit is the route's, not the default)", async () => {
    const world = await openWorld();
    const body = padded(KIB64 - 512, GITLAB);
    expectAnswer(await call(world, "admin", "POST", "/api/connectors", body), 201);
  });

  it("DELETE with a malformed JSON body stays the generic 500 and deletes nothing", async () => {
    const world = await openWorld();
    await register(world, GITLAB);
    const before = footprint(world);
    const url = "/api/connectors?name=gitlab";
    expectAnswer(await call(world, "admin", "DELETE", url, MALFORMED), 500, GENERIC_500);
    expect(footprint(world)).toEqual(before);
  });
});
