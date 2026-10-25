/**
 * s1d-connectors group 5 (task 5.2): connectors「连接器账号缺省」— `GET` / `PUT /api/connectors/defaults` on
 * the whole mount (createApp on a migrated `:memory:` database, `assembly.mcpPublish` = the real publisher
 * over a temp state layout). Every logged-in account reads and replaces its own list: the strict key set
 * `{disabledConnectors}`, at most 32 items, the connector-name rule, dedupe + dictionary order, names
 * need not be registered, 16 KiB body limit with content-parser errors as 400, no-store, no audit, and
 * `mcp.json` untouched. Oracles: spec literals, the `account_connector_prefs` rows, the audit table and the
 * file on disk.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createMcpPublisher } from "../src/connectors/mcp-json.js";
import { createConnectorStore } from "../src/connectors/store.js";
import { openDb } from "../src/core/db/index.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import {
  BAD_REQUEST,
  call,
  expectAnswer,
  type RawBody,
  UNAUTHORIZED,
} from "./models-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const URL = "/api/connectors/defaults";
const KIB16 = 16 * 1024;
const EMPTY_MCP = '{\n  "mcpServers": {}\n}\n';
/** 33 distinct names of lowercase letters only (`caa`, `cab`, …). */
const NAMES_33 = Array.from(
  { length: 33 },
  (_, i) => `c${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`,
);
const NAMES_32 = NAMES_33.slice(0, 32);

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  agentDir: string;
  /** member = zhangsan, admin = lisi; `other` (zhaoliu) is a second member. */
  cookies: { admin: string; member: string };
  other: string;
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

async function openWorld(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "connectors-defaults-")));
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
    },
  });
  opened.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { app, db, agentDir, cookies, other: await cookieFor(app, "zhaoliu") };
}

/** Every `account_connector_prefs` row (account id and stored text), by account. */
function prefs(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT a.account, p.disabled_connectors FROM account_connector_prefs p JOIN accounts a ON a.id = p.account_id ORDER BY a.account",
    )
    .all()
    .map((row) => ({ ...row }));
}

/** What a defaults write never moves (besides its own prefs row): audit rows and `mcp.json`. */
function untouched(world: World) {
  const audits = Number(
    (world.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number | bigint }).n,
  );
  const path = join(world.agentDir, "mcp.json");
  return { audits, mcp: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
}

function put(world: World, body: unknown, who: "admin" | "member" = "member") {
  return call(world, who, "PUT", URL, body);
}

function padded(totalBytes: number, fields: object): RawBody {
  const json = JSON.stringify(fields);
  const pad = totalBytes - Buffer.byteLength(json);
  return { raw: `${json.slice(0, -1)}${" ".repeat(pad)}}`, type: "application/json" };
}

describe("连接器账号缺省：GET / PUT /api/connectors/defaults", () => {
  it("没有行时 GET 为 []；普通成员与管理员都可读写，各自一行，互不影响；不审计、不动 mcp.json", async () => {
    const world = await openWorld();
    const before = untouched(world);
    expectAnswer(await call(world, "member", "GET", URL), 200, { disabledConnectors: [] });
    expectAnswer(await call(world, "admin", "GET", URL), 200, { disabledConnectors: [] });

    // Not registered, duplicated, out of order: stored deduplicated in dictionary order.
    const saved = await put(world, { disabledConnectors: ["wiki", "gitlab", "wiki"] });
    expectAnswer(saved, 200, { disabledConnectors: ["gitlab", "wiki"] });
    expect(Object.keys(saved.json() as object)).toEqual(["disabledConnectors"]);
    expectAnswer(await call(world, "member", "GET", URL), 200, {
      disabledConnectors: ["gitlab", "wiki"],
    });
    expectAnswer(await put(world, { disabledConnectors: ["ghost"] }, "admin"), 200, {
      disabledConnectors: ["ghost"],
    });
    expectAnswer(await call(world, "admin", "GET", URL), 200, { disabledConnectors: ["ghost"] });
    const other = await world.app.inject({
      method: "GET",
      url: URL,
      headers: { cookie: world.other },
    });
    expectAnswer(other, 200, { disabledConnectors: [] });

    expect(prefs(world.db)).toEqual([
      { account: "lisi", disabled_connectors: '["ghost"]' },
      { account: "zhangsan", disabled_connectors: '["gitlab","wiki"]' },
    ]);
    // Whole replacement, `[]` included.
    expectAnswer(await put(world, { disabledConnectors: [] }), 200, { disabledConnectors: [] });
    expectAnswer(await call(world, "member", "GET", URL), 200, { disabledConnectors: [] });
    expect(untouched(world)).toEqual(before);
    expect(readFileSync(join(world.agentDir, "mcp.json"), "utf8")).toBe(EMPTY_MCP);
  });

  it("32 项 200；33 项、多余键、名称规则与非数组一律 400 且行不变", async () => {
    const world = await openWorld();
    expectAnswer(await put(world, { disabledConnectors: NAMES_32 }), 200, {
      disabledConnectors: NAMES_32,
    });
    const before = { prefs: prefs(world.db), ...untouched(world) };

    const refused: unknown[] = [
      {},
      { disabledConnectors: NAMES_33 },
      // 33 raw items that dedupe to one: the limit counts items before deduplication.
      { disabledConnectors: Array.from({ length: 33 }, () => "gitlab") },
      { disabledConnectors: [], extra: 1 },
      { disabledSkills: [] },
      { disabledConnectors: ["Git"] },
      { disabledConnectors: ["git2lab"] },
      { disabledConnectors: ["git_lab"] },
      { disabledConnectors: [""] },
      { disabledConnectors: ["a".repeat(33)] },
      { disabledConnectors: [1] },
      { disabledConnectors: "gitlab" },
      { disabledConnectors: null },
      [],
      null,
      "x",
    ];
    for (const body of refused) {
      expectAnswer(await put(world, body), 400, BAD_REQUEST);
    }
    expect({ prefs: prefs(world.db), ...untouched(world) }).toEqual(before);
  });

  it("content-parser 错误 400（body limit 16 KiB）；恰 16 KiB 200", async () => {
    const world = await openWorld();
    const failures: RawBody[] = [
      { raw: '{"disabledConnectors": ', type: "application/json" },
      { raw: "", type: "application/json" },
      { raw: '{"disabledConnectors":[]}', type: "text/plain" },
      { raw: "binary", type: "application/octet-stream" },
      padded(KIB16 + 1, { disabledConnectors: ["gitlab"] }),
    ];
    for (const raw of failures) {
      expectAnswer(await put(world, raw), 400, BAD_REQUEST);
    }
    expect(prefs(world.db)).toEqual([]);
    expectAnswer(await put(world, padded(KIB16, { disabledConnectors: ["gitlab"] })), 200, {
      disabledConnectors: ["gitlab"],
    });
  });

  it("未认证 GET / PUT 401", async () => {
    const world = await openWorld();
    for (const response of [
      await call(world, "anonymous", "GET", URL),
      await call(world, "anonymous", "PUT", URL, { disabledConnectors: [] }),
    ]) {
      expect([response.statusCode, response.json()]).toEqual([401, UNAUTHORIZED]);
    }
    expect(prefs(world.db)).toEqual([]);
  });
});
