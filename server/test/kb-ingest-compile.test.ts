/**
 * #1900：开编译的库能入库（knowledge-bases「知识库端点」的「开编译的库能入库（画布名不超过 32 字符）」）。RAGFlow 建入库任务时
 * 把画布标题拷进 `pipeline_operation_log.pipeline_title`（`varchar(32)`），超长时解析触发回 `success_count:0`；假 RAGFlow 照此
 * 行为（`fake-ragflow.mjs` 的 `MAX_PIPELINE_TITLE`）。库经真实的 `POST /api/kb/bases` 建出，再从工作空间入库，世界是
 * `kb-ingest-helpers.ts` 的（挂载是真实 manager）。期望的名字按规格字面计算，不经 `resourceName`。
 */
import { describe, expect, it } from "vitest";
import { type IngestWorld, RAGFLOW_KEY, useIngestWorlds } from "./kb-ingest-helpers.js";
import { insertRow, MODEL_ROW } from "./kb-store-helpers.js";
import { W1 } from "./mounts-manager-helpers.js";
import { CASE_MS, send } from "./mounts-rest-helpers.js";
import { callFake } from "./support/fake-ragflow-call.js";

const open = useIngestWorlds();

const EMBEDDING_NAME = "bge-m3";
const CHAT_MODEL = "m2";

/** 嵌入模型已保存、知识库对话模型已指定、账号两种缺省都在（经假 RAGFlow 自己的 `PATCH /models/default` 写入）。 */
async function compileReady(world: IngestWorld): Promise<void> {
  const { db } = world.fw.world;
  insertRow(db, "models", { ...MODEL_ROW, id: CHAT_MODEL, name: CHAT_MODEL });
  db.prepare(
    "UPDATE kb_settings SET embedding_name = ?, embedding_base_url = 'http://embed.upstream.test/v1', embedding_api_key = 'wb-issue1900-embed-key', chat_model_id = ?, updated_at = 1",
  ).run(EMBEDDING_NAME, CHAT_MODEL);
  world.fake.addModel("owb-embed", EMBEDDING_NAME, "embedding");
  world.fake.addModel("owb-chat", CHAT_MODEL, "chat");
  for (const [type, instance, name] of [
    ["embedding", "owb-embed", EMBEDDING_NAME],
    ["chat", "owb-chat", CHAT_MODEL],
  ]) {
    const json = {
      model_provider: "OpenAI-API-Compatible",
      model_instance: instance,
      model_name: name,
      model_type: type,
    };
    const { baseUrl } = world.fake;
    const answer = await callFake(baseUrl, RAGFLOW_KEY, "PATCH", "/api/v1/models/default", {
      json,
    });
    expect(answer.body.code).toBe(0);
  }
}

/** 这次请求之后假 RAGFlow 收到的某一路由的 JSON body。 */
function sentBodies(world: IngestWorld, from: number, route: string): Record<string, unknown>[] {
  return world.fake
    .requests()
    .slice(from)
    .filter(({ method, path }) => `${method} ${path}` === route)
    .map(({ json }) => json as Record<string, unknown>);
}

describe("开编译的库能入库（#1900）", () => {
  it.each([
    ["raptor", { raptor: true }],
    ["graph", { graph: true }],
  ])(
    "开 %s 的 naive 库：三种资源名都是 owb-<id 前 16 位>-g0，工作空间文件入库 201",
    {
      timeout: CASE_MS,
    },
    async (_label, switches) => {
      const world = await open();
      await compileReady(world);
      const from = world.fake.requests().length;
      const created = await send(world.fw.rest, "member", "POST", "/api/kb/bases", {
        name: "编译库",
        template: "naive",
        ...switches,
      });
      expect(created.statusCode).toBe(201);
      const view = created.json<{ id: string }>();
      const name = `owb-${view.id.slice(0, 16)}-g0`;
      expect(name.length).toBeLessThanOrEqual(32);
      expect(sentBodies(world, from, "POST /api/v1/compilation-template-groups")).toMatchObject([
        { name },
      ]);
      expect(sentBodies(world, from, "POST /api/v1/agents")).toMatchObject([{ title: name }]);
      expect(sentBodies(world, from, "POST /api/v1/datasets")).toMatchObject([
        { name, parse_type: 2 },
      ]);

      world.write("notes.md", "# notes\n");
      const response = await world.post(
        { workspaceId: W1, paths: ["notes.md"] },
        { baseId: view.id },
      );
      expect(response.statusCode).toBe(201);
      const body = response.json<{ documents: { path: string }[]; rejected: unknown[] }>();
      expect(body.rejected).toEqual([]);
      expect(body.documents.map(({ path }) => path)).toEqual(["notes.md"]);
    },
  );
});
