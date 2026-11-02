/**
 * s2a-kb-ragflow tasks 14.2（#1852）：重建的续做与关停，真实 compiled production 入口（ragflow-backend「嵌入模型更换与全量重建」的
 * 「崩溃后续做」「编译库的残留清理」「关停时在途重建」「续做失败不影响进程」「知识库关闭时不动重建状态」，design D8）。
 *
 * 「进程退出时库处于 rebuilding」由种子 DB 给出：上一次运行留下的就是这几列，入口只看得到它们。假 RAGFlow 在用例进程里，旧一代与
 * 残留的一代都是它自己建的资源；账号缺省经它自己的 `PATCH /models/default` 写入，种子请求在断言之前切掉。等的是终态（库行的
 * `state`），请求序列与审计在终态之后断言，不依赖时长。期望值是 spec 的字面量。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { routes } from "./kb-settings-helpers.js";
import { COMPILE_ROW, hex, insertRow, UPLOAD_ROW } from "./kb-store-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  login,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
} from "./server-startup-helpers.js";
import { applicationStderr } from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";
import { type FakeRagflowServer, start as startFakeRagflow } from "./support/fake-ragflow.mjs";
import { callFake } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1852-ragflow-key";
const CASE_MS = 90_000;
const STATE_MS = 30_000;
const ID = hex(0x1852);
const DOWNLOAD = "GET /api/v1/datasets/*/documents/*";
const DELETE_DATASETS = "DELETE /api/v1/datasets";
const CONTENT = "alpha-content";
const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Seed {
  /** 开了 RAPTOR；否则两个开关都关。 */
  compile: boolean;
  /** 上一次运行已建出残留的一代。 */
  residual: boolean;
}

interface Fixture {
  root: string;
  dbPath: string;
  fake: FakeRagflowServer;
  /** 种子之后的请求从这里起。 */
  mark: number;
  /** 当前一代的三个 id；普通库只有数据集。 */
  current: { datasetId: string; canvasId: string | null; templateGroupId: string | null };
  residual: { datasetId: string; canvasId: string | null; templateGroupId: string | null } | null;
  ragflowDocumentId: string;
}

/** 账号已有两种缺省（§11.2）：经假 RAGFlow 自己的路由写入，不另开口子。 */
async function seedDefaults(fake: FakeRagflowServer): Promise<void> {
  fake.addModel("owb-chat", "m2", "chat");
  for (const [type, instance, name] of [
    ["embedding", "owb-embed", "bge-large"],
    ["chat", "owb-chat", "m2"],
  ]) {
    const json = {
      model_provider: "OpenAI-API-Compatible",
      model_instance: instance,
      model_name: name,
      model_type: type,
    };
    const answer = await callFake(fake.baseUrl, KEY, "PATCH", "/api/v1/models/default", { json });
    expect(answer.body.code).toBe(0);
  }
}

/** 上一次运行留下的 DB 与 RAGFlow：一个 rebuilding 的库、一份原件，发起者是 lisi（`u3`）。 */
async function fixture(seed: Seed): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-kb-rebuild-")));
  scratch.push(root);
  const fake = await startFakeRagflow({ apiKey: KEY });
  fake.addModel("owb-embed", "bge-large", "embedding");
  if (seed.compile) {
    await seedDefaults(fake);
  }
  const generation = (n: number) => ({
    datasetId: fake.addDataset(`owb-${ID}-g${String(n)}`),
    canvasId: seed.compile ? fake.addCanvas(`owb-${ID}-g${String(n)}`) : null,
    templateGroupId: seed.compile ? fake.addTemplateGroup(`owb-${ID}-g${String(n)}`) : null,
  });
  const current = generation(0);
  const residual = seed.residual ? generation(1) : null;
  const ragflowDocumentId = fake.addDocument(current.datasetId, { name: "a.md", content: CONTENT });
  mkdirSync(join(root, "db"));
  const dbPath = join(root, "db", "dev.db");
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE kb_settings SET embedding_name = 'bge-large', embedding_base_url = 'http://embed.upstream.test/v1', embedding_api_key = 'wb-issue1852-embed-key', embedding_generation = 1, rebuild_actor_id = 'u3', updated_at = 1",
    ).run();
    insertRow(db, "knowledge_bases", {
      ...COMPILE_ROW,
      id: ID,
      ...(seed.compile ? {} : { raptor: 0 }),
      dataset_id: current.datasetId,
      canvas_id: current.canvasId,
      template_group_id: current.templateGroupId,
      rebuild_dataset_id: residual?.datasetId ?? null,
      rebuild_canvas_id: residual?.canvasId ?? null,
      rebuild_template_group_id: residual?.templateGroupId ?? null,
      state: "rebuilding",
    });
    insertRow(db, "kb_documents", {
      ...UPLOAD_ROW,
      kb_id: ID,
      ragflow_document_id: ragflowDocumentId,
      name: "a.md",
      size: Buffer.byteLength(CONTENT),
    });
  } finally {
    db.close();
  }
  writeFileSync(join(root, "ragflow-key"), KEY, { mode: 0o600 });
  return { root, dbPath, fake, mark: fake.requests().length, current, residual, ragflowDocumentId };
}

function envOf(fx: Fixture, port: number, baseUrl: string | null): Record<string, string> {
  const kb =
    baseUrl === null
      ? {}
      : { RAGFLOW_BASE_URL: baseUrl, RAGFLOW_API_KEY_FILE: join(fx.root, "ragflow-key") };
  return compiledFixtureEnv(fx.root, port, join(fx.root, "bin", "omp"), kb);
}

async function launch(fx: Fixture, baseUrl: string | null = fx.fake.baseUrl) {
  let trace = "";
  const started = await startCompiledServerWithRetry(compiled.entry, (port) => {
    trace = join(fx.root, `order-${String(port)}.log`);
    return { env: envOf(fx, port, baseUrl), orderTrace: trace };
  });
  await started.server.waitForStarted();
  return { ...started, trace: () => readFileSync(trace, "utf8").split("\n") };
}

function query<T>(fx: Fixture, sql: string): T[] {
  const db = new DatabaseSync(fx.dbPath);
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const baseRow = (fx: Fixture) =>
  query<Record<string, unknown>>(fx, `SELECT * FROM knowledge_bases WHERE id = '${ID}'`)[0];

const rebuildAudits = (fx: Fixture) =>
  query<{ actor_id: string; detail: string }>(
    fx,
    "SELECT actor_id, detail FROM audit_events WHERE kind = 'kb.rebuild' ORDER BY id",
  ).map(({ actor_id: actorId, detail }) => ({ actorId, detail: JSON.parse(detail) as unknown }));

async function waitForState(fx: Fixture, state: string): Promise<void> {
  const deadline = Date.now() + STATE_MS;
  while (baseRow(fx)?.state !== state) {
    if (Date.now() > deadline) throw new Error(`knowledge base never reached ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sentSince = (fx: Fixture, mark = fx.mark) => fx.fake.requests().slice(mark);

/** 普通库新一代的建库、转移与删旧数据集。 */
function plainTail(fx: Fixture, next: string): string[] {
  return [
    "POST /api/v1/datasets",
    `GET /api/v1/datasets/${fx.current.datasetId}/documents/${fx.ragflowDocumentId}`,
    `POST /api/v1/datasets/${next}/documents`,
    `POST /api/v1/datasets/${next}/documents/parse`,
    DELETE_DATASETS,
  ];
}

async function stopped(server: StartedServer): Promise<void> {
  try {
    expect(await server.stop()).toBe(0);
  } finally {
    await server.dispose();
  }
}

describe("续做", () => {
  it(
    "崩溃后续做：先删残留的数据集，再从建新数据集开始，最终 ready；kb.rebuild 的 actor 是原发起人",
    async () => {
      const fx = await fixture({ compile: false, residual: true });
      const { server } = await launch(fx);
      try {
        await waitForState(fx, "ready");
        const next = String(baseRow(fx)?.dataset_id);
        expect(routes(sentSince(fx))).toEqual([DELETE_DATASETS, ...plainTail(fx, next)]);
        expect(
          sentSince(fx)
            .map(({ json }) => json)
            .filter((json) => json !== null)[0],
        ).toEqual({
          ids: [fx.residual?.datasetId],
        });
        expect(rebuildAudits(fx)).toEqual([
          { actorId: "u3", detail: { id: ID, result: "ok", skipped: [] } },
        ]);
        expect(applicationStderr(server.stderr())).toBe("");
      } finally {
        await stopped(server);
        await fx.fake.close();
      }
    },
    CASE_MS,
  );

  it(
    "编译库的残留清理：先删残留一代的数据集、画布、模板组，再走新一代的建库序列，最终 ready",
    async () => {
      const fx = await fixture({ compile: true, residual: true });
      const { server } = await launch(fx);
      try {
        await waitForState(fx, "ready");
        const row = baseRow(fx);
        const [residual, current] = [fx.residual, fx.current];
        expect(routes(sentSince(fx))).toEqual([
          DELETE_DATASETS,
          `DELETE /api/v1/agents/${String(residual?.canvasId)}`,
          `DELETE /api/v1/compilation-template-groups/${String(residual?.templateGroupId)}`,
          "GET /api/v1/models/default",
          "GET /api/v1/compilation-templates/builtins",
          "POST /api/v1/compilation-template-groups",
          "GET /api/v1/pipelines/general",
          "POST /api/v1/agents",
          "POST /api/v1/datasets",
          `GET /api/v1/datasets/${current.datasetId}/documents/${fx.ragflowDocumentId}`,
          `POST /api/v1/datasets/${String(row?.dataset_id)}/documents`,
          `POST /api/v1/datasets/${String(row?.dataset_id)}/documents/parse`,
          DELETE_DATASETS,
          `DELETE /api/v1/agents/${String(current.canvasId)}`,
          `DELETE /api/v1/compilation-template-groups/${String(current.templateGroupId)}`,
        ]);
        expect(row).toMatchObject({
          state: "ready",
          rebuild_dataset_id: null,
          rebuild_canvas_id: null,
          rebuild_template_group_id: null,
          embedding_generation: 1,
        });
      } finally {
        await stopped(server);
        await fx.fake.close();
      }
    },
    CASE_MS,
  );

  it(
    "续做失败不影响进程：RAGFlow 不可达时 success record 照常，没有 failure record，退出码 0；该库 rebuild_failed",
    async () => {
      const fx = await fixture({ compile: false, residual: false });
      const closed = await reserveWildcardPort();
      const { server, port } = await launch(fx, `http://127.0.0.1:${String(closed)}`);
      try {
        await waitForState(fx, "rebuild_failed");
        expect(JSON.parse(server.stdout())).toMatchObject({ event: "server_started", port });
        expect(applicationStderr(server.stderr())).toBe("");
        expect(rebuildAudits(fx)).toEqual([
          { actorId: "u3", detail: { id: ID, result: "failed" } },
        ]);
      } finally {
        await stopped(server);
        await fx.fake.close();
      }
      expect(applicationStderr(server.stderr())).toBe("");
    },
    CASE_MS,
  );

  it(
    "知识库关闭时不动重建状态：未配置时仍 rebuilding、没有 kb.rebuild；配置之后重启即续做到 ready",
    async () => {
      const fx = await fixture({ compile: false, residual: false });
      const disabled = await launch(fx, null);
      try {
        const cookie = await login(disabled.port);
        const status = await fetch(`http://127.0.0.1:${String(disabled.port)}/api/kb/status`, {
          headers: { cookie },
        });
        expect(await status.json()).toEqual({ enabled: false });
      } finally {
        await stopped(disabled.server);
      }
      expect(baseRow(fx)?.state).toBe("rebuilding");
      expect(rebuildAudits(fx)).toEqual([]);
      expect(sentSince(fx)).toEqual([]);

      const enabled = await launch(fx);
      try {
        await waitForState(fx, "ready");
        expect(rebuildAudits(fx)).toHaveLength(1);
      } finally {
        await stopped(enabled.server);
        await fx.fake.close();
      }
    },
    CASE_MS,
  );
});

describe("关停时在途重建", () => {
  it(
    "切换之前（下载挂起）收到 SIGTERM：退出 0，DB 已关闭，库仍 rebuilding；重启后续做到 ready",
    async () => {
      const fx = await fixture({ compile: false, residual: false });
      const gate = fx.fake.fault(DOWNLOAD, { kind: "hold" });
      const first = await launch(fx);
      await gate.reached;
      await stopped(first.server);
      expect(first.trace()).toContain("db-close");
      const row = baseRow(fx);
      expect(row).toMatchObject({ state: "rebuilding", dataset_id: fx.current.datasetId });
      expect(row?.rebuild_dataset_id).not.toBeNull();
      expect(rebuildAudits(fx)).toEqual([]);

      const mark = fx.fake.requests().length;
      const second = await launch(fx);
      try {
        await waitForState(fx, "ready");
        expect(routes(sentSince(fx, mark))).toEqual([
          DELETE_DATASETS,
          ...plainTail(fx, String(baseRow(fx)?.dataset_id)),
        ]);
        expect(sentSince(fx, mark)[0]?.json).toEqual({ ids: [row?.rebuild_dataset_id] });
      } finally {
        await stopped(second.server);
        gate.release();
        await fx.fake.close();
      }
    },
    CASE_MS,
  );

  it(
    "切换之后（删旧一代挂起）收到 SIGTERM：退出 0，DB 已关闭，库已 ready，旧数据集记一行 kb_dataset_leak；重启后不续删",
    async () => {
      const fx = await fixture({ compile: false, residual: false });
      const gate = fx.fake.fault(DELETE_DATASETS, { kind: "hold" });
      const first = await launch(fx);
      await gate.reached;
      await stopped(first.server);
      expect(first.trace()).toContain("db-close");
      expect(baseRow(fx)).toMatchObject({ state: "ready", rebuild_dataset_id: null });
      expect(applicationStderr(first.server.stderr())).toBe(
        `${JSON.stringify({ event: "kb_dataset_leak", datasetId: fx.current.datasetId })}\n`,
      );

      const mark = fx.fake.requests().length;
      const second = await launch(fx);
      try {
        const cookie = await login(second.port);
        await fetch(`http://127.0.0.1:${String(second.port)}/api/kb/status`, {
          headers: { cookie },
        });
        expect(routes(sentSince(fx, mark))).toEqual(["GET /api/v1/system/version"]);
      } finally {
        await stopped(second.server);
        gate.release();
        await fx.fake.close();
      }
    },
    CASE_MS,
  );
});
