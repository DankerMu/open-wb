/**
 * 编译资源：模板组、画布与 pipeline 数据集的建与删，以及 DSL 生成（s2a-kb-ragflow D7、D9、D14；knowledge-bases「知识库端点」）。
 * RAPTOR 与知识图谱不是数据集字段：开了开关的库是「模板组 → 画布 → `parse_type:2` 数据集」三样资源，建库与重建共用这里。
 *
 * `createPipeline` 的第一步只读账号缺省（D7 的账号缺省不变量，实测记录 §13）：`chat` 与 `embedding` 缺一种即 `kb_not_ready`，
 * 不发后续请求。之后读内置模板、建模板组、读内置 DSL 插 Compiler 节点、建画布、建数据集；任一步失败，逆序删掉这一次已建的
 * 资源，再返回这一步的结果。
 *
 * `deletePipeline` 的次序固定为数据集 → 画布 → 模板组：两个删除接口没有引用保护（§5.1 (7)），删了在用的画布或模板组，
 * RAGFlow 回 `code:0`，之后解析 `FAILED`。上一步确认已删（成功或不存在）之前不发下一步，任一步失败即停。`ragflow-client`
 * 的删画布与删模板组只有这里调用。删除失败时 `discard` 写一行 leak，不带名称与内容。
 *
 * 不取锁（D20：锁不可重入）：调用方持有设置锁（建库）或该库的写锁（删库与重建）。结果是类型化的，不抛 `HttpError`：建库把它
 * 映射成应答，重建器（`kb/rebuild.ts`）把失败记成 `rebuild_failed`。三个入口都收可选的 `signal`，每个出站请求都带它：关停时
 * 重建器中止在途的请求，中止的那一步与期限到期一样是 `kb_unavailable`。
 */
import { type createRagflowClient, isRecord } from "./ragflow-client.js";

type Json = Record<string, unknown>;
type Client = Pick<
  ReturnType<typeof createRagflowClient>,
  | "readDefaultModels"
  | "listBuiltinTemplates"
  | "createTemplateGroup"
  | "readBuiltinPipeline"
  | "createCanvas"
  | "createDataset"
  | "deleteDataset"
  | "deleteCanvas"
  | "deleteTemplateGroup"
>;

const COMPILER = "Compiler:Owb";
const UNAVAILABLE = { kind: "kb_unavailable" } as const;
const NOT_READY = { kind: "kb_not_ready" } as const;
const OK = { kind: "ok" } as const;
/** 数据集级合并读账号缺省对话模型，文档阶段的 Compiler 读账号缺省嵌入模型（§5.5、§13）。 */
const REQUIRED_DEFAULTS = ["chat", "embedding"];
/** §5.1 (2)：内置 `tree` 的 `entity.fields` 带一条空 `type`，原样提交回 `102`；`llm_id` 留给建数据集时固化（§5.5）。 */
const TEMPLATES = [
  { switch: "raptor", id: "tree", suffix: "t", drop: ["entity", "relation", "llm_id"] },
  { switch: "graph", id: "knowledge_graph", suffix: "g", drop: ["llm_id"] },
] as const;

/** 一代的 RAGFlow 资源。普通库的画布与模板组为 `null`；回滚时还没建出的也是 `null`。 */
export interface PipelineResources {
  datasetId: string | null;
  canvasId: string | null;
  templateGroupId: string | null;
}

/** RAGFlow 资源留在了 RAGFlow、本地却没有行：删除失败时写的 stderr 记录（D8、D9）。 */
export type KbPipelineRecord =
  | { event: "kb_dataset_leak"; datasetId: string }
  | { event: "kb_pipeline_leak"; canvasId: string | null; groupId: string | null };

type Failure = { kind: "kb_unavailable" | "kb_rejected" };
type Step = "dataset" | "canvas" | "group";
type Deleted = typeof OK | (Failure & { step: Step; id: string });
type Created =
  | { kind: "ok"; value: { datasetId: string; canvasId: string; templateGroupId: string } }
  | Failure
  | typeof NOT_READY;

interface Switches {
  raptor: boolean;
  graph: boolean;
}

/**
 * 一代 RAGFlow 资源的名字 `owb-<id 前 16 位>-g<代数>`：数据集、模板组与画布同名（D2），建库与重建都经这里。长度不超过 32（代数
 * 不超过 10 位时）：RAGFlow 建入库任务时把画布标题拷进 `pipeline_operation_log.pipeline_title`（`varchar(32)`），超长时任务建
 * 不出来，解析触发回 `code:0`、`success_count:0`，日志里没有记录（#1900）。
 */
export function resourceName(id: string, generation: number): string {
  return `owb-${id.slice(0, 16)}-g${String(generation)}`;
}

/** 建一代编译资源的输入：`name` 是 `resourceName` 的结果，模板组、画布与数据集同名（D2）。 */
interface PipelineInput extends Switches {
  name: string;
  parserId: string;
  embeddingModel: string;
}

/**
 * 模板组的模板项（§5.1 (2)）：开着的类型各一项，`config` 取内置值删掉 `TEMPLATES` 列的键。要用的内置模板不在即 `undefined`。
 * 两项的名字不同：同一组里模板同名回 `102`。
 */
export function groupTemplates(
  builtins: readonly { id: string; config: Json }[],
  name: string,
  switches: Switches,
): Json[] | undefined {
  const templates: Json[] = [];
  for (const template of TEMPLATES.filter((entry) => switches[entry.switch])) {
    const builtin = builtins.find(({ id }) => id === template.id);
    if (builtin === undefined) {
      return undefined;
    }
    const config = Object.fromEntries(
      Object.entries(builtin.config).filter(
        ([key]) => !(template.drop as readonly string[]).includes(key),
      ),
    );
    templates.push({
      name: `${name}-${template.suffix}`,
      kind: template.id,
      description: "",
      config,
    });
  }
  return templates;
}

const isChunker = (node: unknown): boolean => {
  const name = isRecord(node) && isRecord(node.obj) ? node.obj.component_name : undefined;
  return typeof name === "string" && name.includes("Chunker");
};

const compilerParams = (groupId: string): Json => ({
  compilation_template_group_id: groupId,
  llm_id: "",
  plan: false,
  outputs: { chunks: { type: "Array<Object>", value: [] } },
});

const isPoint = (value: unknown): value is { x: number; y: number } =>
  isRecord(value) && typeof value.x === "number" && typeof value.y === "number";

/** 画在 chunker 与它原来的下游之间；位置只影响界面，读不到就放原点。 */
function between(nodes: unknown[], from: unknown, to: unknown): { x: number; y: number } {
  const positionOf = (id: unknown): unknown => {
    const node = nodes.find((candidate) => isRecord(candidate) && candidate.id === id);
    return isRecord(node) ? node.position : undefined;
  };
  const [a, b] = [positionOf(from), positionOf(to)];
  return isPoint(a) && isPoint(b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
}

/** `components` 里的改写：Compiler 接到 chunker 之后，原下游的 `upstream` 里 chunker 换成它。下游读不到即 `false`。 */
function rewireComponents(components: Json, chunkerId: string, groupId: string): boolean {
  const chunker = components[chunkerId] as Json;
  const downstream = chunker.downstream;
  if (!Array.isArray(downstream)) {
    return false;
  }
  const targets = downstream.map((id) => components[String(id)]);
  if (!targets.every((node) => isRecord(node) && Array.isArray(node.upstream))) {
    return false;
  }
  components[COMPILER] = {
    upstream: [chunkerId],
    downstream: [...downstream],
    obj: { component_name: "Compiler", params: compilerParams(groupId) },
  };
  chunker.downstream = [COMPILER];
  for (const node of targets as { upstream: unknown[] }[]) {
    node.upstream = node.upstream.map((id) => (id === chunkerId ? COMPILER : id));
  }
  return true;
}

/** `graph` 里的改写：加 `compilationNode`；chunker 原来的出边改从 Compiler 出发、原边不留，再加 chunker → Compiler。 */
function rewireGraph(
  graph: { nodes: unknown[]; edges: unknown[] },
  chunkerId: string,
  groupId: string,
  next: unknown,
) {
  graph.nodes.push({
    id: COMPILER,
    type: "compilationNode",
    data: { label: "Compiler", name: "Compiler", form: compilerParams(groupId) },
    position: between(graph.nodes, chunkerId, next),
    sourcePosition: "right",
    targetPosition: "left",
  });
  graph.edges = [
    ...graph.edges.map((edge) =>
      isRecord(edge) && edge.source === chunkerId ? { ...edge, source: COMPILER } : edge,
    ),
    {
      id: `${COMPILER}:in`,
      source: chunkerId,
      sourceHandle: "start",
      target: COMPILER,
      targetHandle: "end",
    },
  ];
}

/**
 * 内置 DSL 插一个 `Compiler:Owb` 节点（D9，§5.1 (3)、(6)），不改输入。`graph` 不能省：省掉时建画布、建库都回 `code:0`，
 * 编译静默不运行（§18 #25）。没有 `graph`、按 `obj.component_name` 含 `Chunker` 查到的不是恰一个，或结构读不懂：`undefined`。
 */
export function insertCompiler(builtin: Json, groupId: string): Json | undefined {
  const dsl = structuredClone(builtin);
  const { components, graph } = dsl;
  if (!isRecord(components) || !isRecord(graph)) {
    return undefined;
  }
  const { nodes, edges } = graph;
  const chunkers = Object.keys(components).filter((id) => isChunker(components[id]));
  if (!Array.isArray(nodes) || !Array.isArray(edges) || chunkers.length !== 1) {
    return undefined;
  }
  const [chunkerId] = chunkers as [string];
  if (!rewireComponents(components, chunkerId, groupId)) {
    return undefined;
  }
  const [next] = (components[COMPILER] as { downstream: unknown[] }).downstream;
  rewireGraph(graph as { nodes: unknown[]; edges: unknown[] }, chunkerId, groupId, next);
  return dsl;
}

export function createKbPipeline(dependencies: {
  client: Client;
  /** 受管 stderr writer。 */
  log: (record: KbPipelineRecord) => void;
}) {
  const { client, log } = dependencies;

  /** 次序与即停见文件头；`not_found` 视为已删（表 B：数据集 `403`、画布 `103`、模板组 `404`）。 */
  async function deletePipeline(
    resources: PipelineResources,
    signal?: AbortSignal,
  ): Promise<Deleted> {
    const steps = [
      ["dataset", resources.datasetId, client.deleteDataset],
      ["canvas", resources.canvasId, client.deleteCanvas],
      ["group", resources.templateGroupId, client.deleteTemplateGroup],
    ] as const;
    for (const [step, id, remove] of steps) {
      if (id === null) {
        continue;
      }
      const result = await remove(id, signal);
      if (result.kind !== "ok" && result.kind !== "not_found") {
        return { kind: result.kind, step, id };
      }
    }
    return OK;
  }

  /** 删掉这一代，删不掉的写一行 leak（D8 第 5 步、D9 的回滚）：画布删除失败时模板组还在，两个 id 都写。 */
  async function discard(resources: PipelineResources, signal?: AbortSignal): Promise<void> {
    const result = await deletePipeline(resources, signal);
    if (result.kind === "ok") {
      return;
    }
    const { step, id } = result;
    if (step === "dataset") {
      log({ event: "kb_dataset_leak", datasetId: id });
      return;
    }
    const canvasId = step === "canvas" ? id : null;
    log({ event: "kb_pipeline_leak", canvasId, groupId: resources.templateGroupId });
  }

  /** 模板组已建好之后的三步：读内置 DSL 并改写、建画布、建数据集。 */
  async function onGroup(
    input: PipelineInput,
    templateGroupId: string,
    signal: AbortSignal | undefined,
  ): Promise<Created> {
    const built: PipelineResources = { datasetId: null, canvasId: null, templateGroupId };
    const fail = async (result: Failure): Promise<Failure> => {
      await discard(built, signal);
      return result;
    };
    const builtin = await client.readBuiltinPipeline(input.parserId, signal);
    if (builtin.kind !== "ok") {
      return fail(builtin);
    }
    const dsl = insertCompiler(builtin.value, templateGroupId);
    if (dsl === undefined) {
      return fail(UNAVAILABLE);
    }
    const canvas = await client.createCanvas(input.name, dsl, signal);
    if (canvas.kind !== "ok") {
      return fail(canvas);
    }
    built.canvasId = canvas.value.id;
    const { name, embeddingModel } = input;
    const dataset = await client.createDataset(
      { name, pipelineId: canvas.value.id, embeddingModel },
      signal,
    );
    if (dataset.kind !== "ok") {
      return fail(dataset);
    }
    const value = { datasetId: dataset.value.id, canvasId: canvas.value.id, templateGroupId };
    return { kind: "ok", value };
  }

  return {
    /** 建一代编译资源（D9 的五步）。 */
    async createPipeline(input: PipelineInput, signal?: AbortSignal): Promise<Created> {
      const defaults = await client.readDefaultModels(signal);
      if (defaults.kind !== "ok") {
        return defaults;
      }
      if (!REQUIRED_DEFAULTS.every((type) => defaults.value.includes(type))) {
        return NOT_READY;
      }
      const builtins = await client.listBuiltinTemplates(signal);
      if (builtins.kind !== "ok") {
        return builtins;
      }
      const templates = groupTemplates(builtins.value, input.name, input);
      if (templates === undefined) {
        return UNAVAILABLE;
      }
      const group = await client.createTemplateGroup(input.name, templates, signal);
      return group.kind === "ok" ? onGroup(input, group.value.id, signal) : group;
    },

    deletePipeline,

    discard,
  };
}
