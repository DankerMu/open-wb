/**
 * `kb-ingest-workspace*.test.ts` 与 `kb-source-file.test.ts` 共用（s2a-kb-ragflow tasks 10.2，#1847）：`mounts-file-endpoints-helpers.ts`
 * 的世界（`createApp` + 真实挂载 manager，假 rclone，挂载点是普通目录）加假 RAGFlow。账号：zhangsan 是 `member`，拥有 W1–W3；
 * lisi 是 `admin`，拥有 `W_LISI`，在这里就是「别的账号」。知识库行由 store 直接插入，不走建库：这里不关心建库的请求序列。
 *
 * 每个用例收尾沿用 `kb-settings-helpers.ts` 的不变量：版本请求之外都带交下来的密钥，版本请求不带，没有落到未知路由，账号缺省
 * 没被清空；stdout、stderr 全程不得出现文件内容与 RAGFlow message 的哨兵。期望值是 spec 与实测记录的字面量。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, expect, type MockInstance, vi } from "vitest";
import type { KbDependencies } from "../src/kb/index.js";
import { createKbLocks } from "../src/kb/locks.js";
import { createKbStore } from "../src/kb/store.js";
import { expectDefaultNeverCleared, routes } from "./kb-settings-helpers.js";
import { type FileWorld, openFileWorld, put } from "./mounts-file-endpoints-helpers.js";
import { disposeWorlds, OWNER, W1 } from "./mounts-manager-helpers.js";
import { closeApps, send } from "./mounts-rest-helpers.js";
import { type FakeRagflowRequest, type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

export const RAGFLOW_KEY = "wb-issue1847-ragflow-key";
const VERSION_PATH = "/api/v1/system/version";
export const UPLOAD_MAX_BYTES = 1024;
export const LIST = "GET /api/v1/datasets/*/documents";
export const UPLOAD = "POST /api/v1/datasets/*/documents";
export const PARSE = "POST /api/v1/datasets/*/documents/parse";
export const STOP = "POST /api/v1/datasets/*/documents/stop";
export const DELETE_DOCUMENT = "DELETE /api/v1/datasets/*/documents";
export const NOT_FOUND = { error: { code: "not_found", message: "请求的资源不存在" } };
export const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };
export const REBUILDING = {
  error: { code: "kb_rebuilding", message: "知识库正在重建，请稍后再试" },
};
/** 哨兵：文件内容与 RAGFlow 的 message。 */
export const CONTENT_SENTINEL = "Snt1nelFileContent1847";
export const MESSAGE_SENTINEL = "Snt1nelRagflowMessage1847";
/** §7.1 的 message。 */
export const UNSUPPORTED_MESSAGE = (name: string): string =>
  `${name}: This type of file has not been supported yet!`;

type Who = "admin" | "member" | "anonymous";

interface IngestSetup {
  /** 知识库的模板，缺省 `naive`。 */
  template?: string;
  online?: Array<{ name: string; readOnly?: boolean }>;
  offline?: string[];
  overrides?: Parameters<typeof openFileWorld>[0]["overrides"];
  /** 覆盖 `KbDependencies` 的可选项与上限。 */
  kb?: Partial<KbDependencies>;
}

interface IngestOptions {
  baseId?: string;
  workspaceId?: string;
  who?: Who;
}

export interface IngestWorld {
  fw: FileWorld;
  /** W1 的根。 */
  root: string;
  fake: FakeRagflowServer;
  store: ReturnType<typeof createKbStore>;
  locks: ReturnType<typeof createKbLocks>;
  logged: unknown[];
  baseId: string;
  datasetId: string;
  /** zhangsan 的另一个知识库。 */
  addBase(template: string): { baseId: string; datasetId: string };
  /** 在 W1 里写一个文件，写入父目录。 */
  write(path: string, bytes: string | Buffer): void;
  ingest(paths: unknown, options?: IngestOptions): Promise<LightMyRequestResponse>;
  /** 用任意 body 请求入库路由。 */
  post(body: unknown, options?: IngestOptions): Promise<LightMyRequestResponse>;
  /** 假 RAGFlow 收到的全部请求，`方法 路径`。 */
  lines(): string[];
  uploads(): FakeRagflowRequest[];
  /** 一种路由的请求数，`route` 同 `fake.answer`。 */
  countOf(route: string): number;
  /** 经下载路由读回文档字节（§9）。 */
  contentOf(documentId: string): Promise<Buffer>;
  /** `kind` 的全部审计，旧的在前。 */
  audits(kind: string): Array<{
    actorId: string;
    title: string;
    detail: Record<string, unknown>;
    workspaceId: string | null;
  }>;
  rows(): ReturnType<ReturnType<typeof createKbStore>["listDocuments"]>;
  /** 把库行的 `state` 直接改掉：造重建中与重建失败。 */
  setState(state: "ready" | "rebuilding" | "rebuild_failed"): void;
}

function routeMatcher(route: string): RegExp {
  const pattern = route.split("*").join("[^/]+");
  return new RegExp(`^${pattern}$`, "u");
}

/** 第一个请求照常走，`script` 接管第二个：同一路由的请求按到达次序消耗脚本，第一个占住之后才登记。 */
export async function scriptSecond(
  world: IngestWorld,
  route: string,
  script: () => void,
  run: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> {
  const gate = world.fake.fault(route, { kind: "hold" });
  const pending = run();
  await gate.reached;
  script();
  gate.release();
  return pending;
}

export const scriptSecondUpload = (
  world: IngestWorld,
  script: () => void,
  run: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> => scriptSecond(world, UPLOAD, script, run);

type OpenWorld = (setup?: IngestSetup) => Promise<IngestWorld>;

/** 在所在文件登记收尾，返回开世界函数。 */
export function useIngestWorlds(): OpenWorld {
  const fakes: FakeRagflowServer[] = [];
  let outputs: Array<MockInstance<typeof process.stdout.write>> = [];
  beforeEach(() => {
    outputs = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
  });
  afterEach(async () => {
    try {
      for (const fake of fakes) {
        const requests = fake.requests();
        expect(fake.unknownRoutes()).toEqual([]);
        expect(
          requests.filter(({ bearer, path }) =>
            path === VERSION_PATH ? bearer !== "missing" : bearer !== "ok",
          ),
        ).toEqual([]);
        expectDefaultNeverCleared(requests);
      }
    } finally {
      await closeApps();
      await disposeWorlds();
      for (const fake of fakes.splice(0)) await fake.close();
      const written = outputs.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));
      for (const spy of outputs) spy.mockRestore();
      const text = written.join("");
      expect(text).not.toContain(CONTENT_SENTINEL);
      expect(text).not.toContain(MESSAGE_SENTINEL);
    }
  });

  return async (setup = {}) => {
    const fake = await start({ apiKey: RAGFLOW_KEY });
    fakes.push(fake);
    const logged: unknown[] = [];
    const locks = createKbLocks();
    const kb: KbDependencies = {
      key: { read: () => RAGFLOW_KEY },
      baseUrl: fake.baseUrl,
      uploadMaxBytes: UPLOAD_MAX_BYTES,
      uploadMaxFiles: 10,
      locks,
      log: (record) => {
        logged.push(record);
      },
      documentDelete: { retryMs: 2, deadlineMs: 20 },
      ...setup.kb,
    };
    const fw = await openFileWorld({
      ...(setup.online === undefined ? {} : { online: setup.online }),
      ...(setup.offline === undefined ? {} : { offline: setup.offline }),
      ...(setup.overrides === undefined ? {} : { overrides: setup.overrides }),
      kb,
    });
    const { db } = fw.world;
    const store = createKbStore(db);
    const addBase = (template: string) => {
      const baseId = store.newId();
      const datasetId = fake.addDataset(`owb-${baseId}-g0`);
      store.createBase({
        id: baseId,
        ownerId: OWNER,
        name: `库 ${baseId}`,
        template,
        raptor: false,
        graph: false,
        datasetId,
        canvasId: null,
        templateGroupId: null,
      });
      return { baseId, datasetId };
    };
    const first = addBase(setup.template ?? "naive");
    const requestsOf = (route: string) =>
      fake.requests().filter((entry) => routeMatcher(route).test(`${entry.method} ${entry.path}`));
    const post = (body: unknown, options: IngestOptions = {}) =>
      send(
        fw.rest,
        options.who ?? "member",
        "POST",
        `/api/kb/bases/${options.baseId ?? first.baseId}/documents`,
        body,
      );
    return {
      fw,
      root: fw.root,
      fake,
      store,
      locks,
      logged,
      ...first,
      addBase,
      write: (path, bytes) => {
        put(fw.root, path, bytes);
      },
      post,
      ingest: (paths, options = {}) =>
        post({ workspaceId: options.workspaceId ?? W1, paths }, options),
      lines: () => routes(fake.requests()),
      uploads: () => requestsOf(UPLOAD),
      countOf: (route) => requestsOf(route).length,
      async contentOf(documentId) {
        const url = `${fake.baseUrl}/api/v1/datasets/${first.datasetId}/documents/${documentId}`;
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${RAGFLOW_KEY}` },
        });
        return Buffer.from(await response.arrayBuffer());
      },
      audits: (kind) =>
        db
          .prepare(
            "SELECT actor_id, CAST(title AS BLOB) AS title, detail, workspace_id FROM audit_events WHERE kind = ? ORDER BY id",
          )
          .all(kind)
          .map((row) => ({
            actorId: String(row.actor_id),
            title: Buffer.from(row.title as Uint8Array).toString("utf8"),
            detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
            workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
          })),
      rows: () => store.listDocuments(first.baseId),
      setState(state) {
        db.prepare("UPDATE knowledge_bases SET state = ? WHERE id = ?").run(state, first.baseId);
      },
    };
  };
}

/** 经真实入库的一份工作空间来源的文档（W1），返回它的行。 */
export async function ingestedRow(
  world: IngestWorld,
  path: string,
  bytes: string,
): Promise<ReturnType<IngestWorld["rows"]>[number]> {
  world.write(path, bytes);
  expect((await world.ingest([path])).statusCode).toBe(201);
  const row = world.rows().find((document) => document.sourcePath === path);
  if (row === undefined) {
    throw new Error(`ingest left no row for ${path}`);
  }
  return row;
}

/** 文件字节读回：源文件在用例里可能已被改写，比对用写入时的值。 */
export function bytesOf(world: IngestWorld, path: string): Buffer {
  return readFileSync(join(world.root, path));
}
