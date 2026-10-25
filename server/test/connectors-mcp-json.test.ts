/**
 * s1d-connectors group 2a (task 2a.2): the managed `mcp.json` (connectors「托管 mcp.json」; design D4) —
 * the content function `mcpJsonText`, the writer `writeManagedMcpJson` (temp dirs) and the single-flight
 * publisher `createMcpPublisher`. Expected bytes are hand-written literals of the spec's shape
 * (`JSON.stringify({mcpServers}, null, 2) + "\n"`, stdio `{type, command, args, env}`, http
 * `{type, url, headers}`), never recomputed the way the module computes them. Snapshots for the
 * publisher come from the real connector store on `:memory:` databases through the real migrations.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpPublisher,
  type McpEntry,
  mcpJsonText,
  writeManagedMcpJson,
} from "../src/connectors/mcp-json.js";
import { createConnectorStore } from "../src/connectors/store.js";
import type { ConnectorFields } from "../src/connectors/validate.js";
import { openDb } from "../src/core/db/index.js";

const SECRET = "SENTINEL-MCP-JSON-4471";
const HEADER_SECRET = "Bearer SENTINEL-MCP-JSON-9023";
const EMPTY = '{\n  "mcpServers": {}\n}\n';

const opened: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "connectors-mcp-json-"));
  dirs.push(dir);
  return dir;
}

function store() {
  const db = openDb(":memory:");
  opened.push(db);
  return createConnectorStore(db);
}

/** Lets every queued promise reaction run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function track(promise: Promise<void>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = {
    status: "pending",
  };
  promise.then(
    () => {
      state.status = "resolved";
    },
    (error: unknown) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}

/** The store's own row shape (description and enabled included): the writer must drop both. */
type StoreRow = { name: string; fields: ConnectorFields };
const gitlab: StoreRow = {
  name: "gitlab",
  fields: {
    type: "stdio",
    description: "内网 GitLab",
    enabled: true,
    command: "/usr/bin/gitlab-mcp",
    args: ["--stdio"],
    env: { TOKEN: SECRET },
  },
};
const wiki: StoreRow = {
  name: "wiki",
  fields: {
    type: "http",
    description: "",
    enabled: true,
    url: "https://wiki.example/mcp",
    headers: { authorization: HEADER_SECRET },
  },
};

const GITLAB_AND_WIKI = [
  "{",
  '  "mcpServers": {',
  '    "gitlab": {',
  '      "type": "stdio",',
  '      "command": "/usr/bin/gitlab-mcp",',
  '      "args": [',
  '        "--stdio"',
  "      ],",
  '      "env": {',
  `        "TOKEN": "${SECRET}"`,
  "      }",
  "    },",
  '    "wiki": {',
  '      "type": "http",',
  '      "url": "https://wiki.example/mcp",',
  '      "headers": {',
  `        "authorization": "${HEADER_SECRET}"`,
  "      }",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

const ONLY_GITLAB = [
  "{",
  '  "mcpServers": {',
  '    "gitlab": {',
  '      "type": "stdio",',
  '      "command": "/usr/bin/gitlab-mcp",',
  '      "args": [',
  '        "--stdio"',
  "      ],",
  '      "env": {',
  `        "TOKEN": "${SECRET}"`,
  "      }",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

describe("mcpJsonText", () => {
  it("writes entries sorted by name, stdio as {type, command, args, env} and http as {type, url, headers}", () => {
    expect(mcpJsonText([wiki, gitlab])).toBe(GITLAB_AND_WIKI);
  });

  it("no connectors give exactly the empty-table bytes", () => {
    expect(mcpJsonText([])).toBe(EMPTY);
  });

  it("empty args, env and headers are written as [] and {}", () => {
    const entries: McpEntry[] = [
      { name: "b", fields: { type: "stdio", command: "/bin/b", args: [], env: {} } },
      { name: "a", fields: { type: "http", url: "http://a.example/mcp", headers: {} } },
    ];
    expect(mcpJsonText(entries)).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "a": {',
        '      "type": "http",',
        '      "url": "http://a.example/mcp",',
        '      "headers": {}',
        "    },",
        '    "b": {',
        '      "type": "stdio",',
        '      "command": "/bin/b",',
        '      "args": [],',
        '      "env": {}',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("escapes quotes, backslashes and line breaks as JSON and keeps non-ASCII text as is", () => {
    const entries: McpEntry[] = [
      {
        name: "esc",
        fields: {
          type: "stdio",
          command: "/opt/mcp server",
          args: ['say "hi"', "C:\\dir", "a\nb", "测试"],
          env: { NOTE: "tab\there" },
        },
      },
    ];
    expect(mcpJsonText(entries)).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "esc": {',
        '      "type": "stdio",',
        '      "command": "/opt/mcp server",',
        '      "args": [',
        String.raw`        "say \"hi\"",`,
        String.raw`        "C:\\dir",`,
        String.raw`        "a\nb",`,
        '        "测试"',
        "      ],",
        '      "env": {',
        String.raw`        "NOTE": "tab\there"`,
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });
});

describe("writeManagedMcpJson", () => {
  it("replaces a residual file with the content at mode 0640 and leaves no temporary file", async () => {
    const agentDir = tempAgentDir();
    writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{"stale":{"command":"/x"}}}');
    await writeManagedMcpJson(agentDir, [gitlab]);
    const file = join(agentDir, "mcp.json");
    expect(readFileSync(file, "utf8")).toBe(ONLY_GITLAB);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(lstatSync(file).mode & 0o7777).toBe(0o640);
    expect(readdirSync(agentDir)).toEqual(["mcp.json"]);
  });

  it("no connectors write exactly the empty-table bytes", async () => {
    const agentDir = tempAgentDir();
    await writeManagedMcpJson(agentDir, []);
    expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(EMPTY);
  });

  it("rejects when the target cannot be replaced (mcp.json is a directory), without the values in the error", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(join(agentDir, "mcp.json"));
    const error: unknown = await writeManagedMcpJson(agentDir, [gitlab]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(readdirSync(agentDir)).toEqual(["mcp.json"]);
    expect(lstatSync(join(agentDir, "mcp.json")).isDirectory()).toBe(true);
  });
});

describe("createMcpPublisher", () => {
  it("writes only the enabled connectors of the store", async () => {
    const connectors = store();
    connectors.create({
      name: "gitlab",
      type: "stdio",
      description: "内网 GitLab",
      command: "/usr/bin/gitlab-mcp",
      args: ["--stdio"],
      env: { TOKEN: SECRET },
    });
    connectors.create({
      name: "wiki",
      type: "http",
      url: "https://wiki.example/mcp",
      headers: { authorization: HEADER_SECRET },
      enabled: false,
    });
    const agentDir = tempAgentDir();
    const publisher = createMcpPublisher({ agentDir: () => agentDir, store: connectors });
    await publisher.publish();
    expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(ONLY_GITLAB);
    expect(lstatSync(join(agentDir, "mcp.json")).mode & 0o7777).toBe(0o640);
  });

  it("writes nothing while agentDir() is null, and the first publish after it is known writes the current table", async () => {
    const connectors = store();
    const agentDir = tempAgentDir();
    let dir: string | null = null;
    const publisher = createMcpPublisher({ agentDir: () => dir, store: connectors });
    connectors.create({ name: "gitlab", type: "stdio", command: "/usr/bin/gitlab-mcp" });
    await expect(publisher.publish()).resolves.toBeUndefined();
    expect(readdirSync(agentDir)).toEqual([]);

    dir = agentDir;
    await publisher.publish();
    expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { gitlab: { type: "stdio", command: "/usr/bin/gitlab-mcp", args: [], env: {} } },
    });
  });

  it("three publishes while the first write is held: two writes, the second with the latest table", async () => {
    const connectors = store();
    const calls: Array<{ dir: string; names: string[] }> = [];
    const gates = [deferred(), deferred()];
    const publisher = createMcpPublisher({
      agentDir: () => "/srv/wb/omp/home/.omp/agent",
      store: connectors,
      write: async (dir, entries) => {
        calls.push({ dir, names: entries.map((entry) => entry.name) });
        await gates[calls.length - 1]?.promise;
      },
    });

    connectors.create({ name: "a", type: "stdio", command: "/bin/a" });
    const first = track(publisher.publish());
    await settle();
    connectors.create({ name: "b", type: "stdio", command: "/bin/b" });
    const second = track(publisher.publish());
    connectors.create({ name: "c", type: "stdio", command: "/bin/c" });
    const third = track(publisher.publish());
    await settle();
    expect(calls).toHaveLength(1);

    gates[0]?.resolve();
    await settle();
    expect([first.status, second.status, third.status]).toEqual(["resolved", "pending", "pending"]);
    expect(calls).toHaveLength(2);

    gates[1]?.resolve();
    await settle();
    expect([second.status, third.status]).toEqual(["resolved", "resolved"]);
    expect(calls).toStrictEqual([
      { dir: "/srv/wb/omp/home/.omp/agent", names: ["a"] },
      { dir: "/srv/wb/omp/home/.omp/agent", names: ["a", "b", "c"] },
    ]);

    // The coalesced round is over: the next publish is a third write.
    await publisher.publish();
    expect(calls).toHaveLength(3);
  });

  it("a failed write rejects; the single flight is reset and the next publish writes again", async () => {
    const connectors = store();
    const agentDir = tempAgentDir();
    mkdirSync(join(agentDir, "mcp.json"));
    const publisher = createMcpPublisher({ agentDir: () => agentDir, store: connectors });
    await expect(publisher.publish()).rejects.toThrow();

    rmSync(join(agentDir, "mcp.json"), { recursive: true });
    await publisher.publish();
    expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(EMPTY);
  });

  it("only callers coalesced on the failed round are rejected; the queued round still runs with the latest table", async () => {
    const connectors = store();
    const calls: string[][] = [];
    const round1 = deferred();
    const publisher = createMcpPublisher({
      agentDir: () => "/srv/wb/omp/home/.omp/agent",
      store: connectors,
      write: async (_dir, entries) => {
        calls.push(entries.map((entry) => entry.name));
        if (calls.length === 1) {
          await round1.promise;
        }
      },
    });

    connectors.create({ name: "a", type: "stdio", command: "/bin/a" });
    const first = track(publisher.publish());
    await settle();
    connectors.create({ name: "b", type: "stdio", command: "/bin/b" });
    const second = track(publisher.publish());
    const boom = new Error("mcp.json write failed");
    round1.reject(boom);
    await settle();

    expect(first).toStrictEqual({ status: "rejected", error: boom });
    expect(second.status).toBe("resolved");
    expect(calls).toStrictEqual([["a"], ["a", "b"]]);

    // The queued round is over too: one more publish writes again.
    connectors.create({ name: "c", type: "stdio", command: "/bin/c" });
    await publisher.publish();
    expect(calls).toStrictEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
  });
});
