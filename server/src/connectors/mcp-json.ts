/**
 * connectors/mcp-json — 托管 `mcp.json`（s1d-connectors design D4；connectors「托管 mcp.json」）。
 *
 * - `mcpJsonText`：唯一的内容写法。`JSON.stringify({mcpServers}, null, 2) + "\n"`，名称按字典序；stdio
 *   条目恰为 `{type, command, args, env}`，http 条目恰为 `{type, url, headers}`（不带描述、启停）。没有条目时
 *   同一写法得到 `{\n  "mcpServers": {}\n}\n`（覆盖残留）。
 * - `writeManagedMcpJson`：经 `replaceFile` 原子替换写出 `<agentDir>/mcp.json`，终态 `0640`；写不成即抛出。
 *   `agentDir` 由托管布局建出，这里从不建目录。
 * - `createMcpPublisher`：单飞发布（与 `models/publish.ts` 同一写法）：一轮开跑时读一次 store 的启用行；
 *   同一时刻只有一轮，期间到达的调用合并为紧随其后的一轮（开跑时读最新状态），合并在同一轮上的调用方共享
 *   它的结果；一轮失败只拒绝合并在它上面的调用方。`agentDir()` 为 null（启动阶段 `mcp_json` 之前）时不写。
 *
 * 凭证：`env` / `headers` 的值只进这个文件（omp uid 可读，ADR-0015），不进本模块抛出的任何 message。
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { replaceFile } from "../core/replace-file.js";

type Entries = Readonly<Record<string, string>>;

/** 一个启用连接器写进 `mcp.json` 的部分；store 的整行（多出描述与启停）也满足它。 */
export interface McpEntry {
  name: string;
  fields:
    | { type: "stdio"; command: string; args: readonly string[]; env: Entries }
    | { type: "http"; url: string; headers: Entries };
}

export function mcpJsonText(entries: readonly McpEntry[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const { name, fields } of [...entries].sort(byName)) {
    // 逐键写字面量：键序即 omp 读到的次序，store 行上的其它字段不得带进来。
    mcpServers[name] =
      fields.type === "stdio"
        ? { type: "stdio", command: fields.command, args: fields.args, env: fields.env }
        : { type: "http", url: fields.url, headers: fields.headers };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** `agentDir` 必须已存在：托管布局建出它，这个写出器从不建目录。 */
export async function writeManagedMcpJson(
  agentDir: string,
  entries: readonly McpEntry[],
): Promise<void> {
  await replaceFile(agentDir, "mcp.json", mcpJsonText(entries));
  // 负对照（#1670，不合入）：以 0600 写出，omp uid 读不到。
  await chmod(join(agentDir, "mcp.json"), 0o600);
}

interface PublisherOptions {
  /** 托管 agent 目录；启动阶段 `mcp_json` 之前为 null。 */
  agentDir: () => string | null;
  store: { enabledForMcp(): readonly McpEntry[] };
  /** 缺省为 `writeManagedMcpJson`。 */
  write?: (agentDir: string, entries: readonly McpEntry[]) => Promise<void>;
}

export function createMcpPublisher(options: PublisherOptions) {
  const { store, write = writeManagedMcpJson } = options;

  const round = async (): Promise<void> => {
    const agentDir = options.agentDir();
    if (agentDir === null) {
      return;
    }
    await write(agentDir, store.enabledForMcp());
  };

  // 单飞的全部状态：在跑的一轮与排在它后面的那一轮（两者各至多一个）。
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const current = round().finally(() => {
      running = null;
    });
    running = current;
    return current;
  };

  return {
    publish(): Promise<void> {
      if (queued !== null) {
        return queued;
      }
      if (running === null) {
        return start();
      }
      // 不论上一轮成败都接着跑；它的拒绝只交给合并在它上面的调用方。
      queued = running
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return start();
        });
      return queued;
    },
  };
}

function byName(a: McpEntry, b: McpEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
