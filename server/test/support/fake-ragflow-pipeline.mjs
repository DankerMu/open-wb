/**
 * 假 RAGFlow 的编译资源（`fake-ragflow.mjs` 的兄弟文件，s2a-kb-ragflow 组 9 第二刀 #1869，design D17）：内置模板、模板组的建与删、
 * 内置 pipeline、画布的建与删，协议抄自实测记录 §5.1 (1)–(7) 与表 B。`parse_type:2` 的数据集在 `fake-ragflow.mjs`，经这里的
 * 画布表判定画布在不在。
 *
 * 夹具的 Compiler 不校验 DSL：画布原样存下，DSL 的正确性由纯函数用例与 `make smoke-kb` 负责（tasks 9.5）。
 *
 * 记录里没有的行为落到未知路由，不猜（处理函数返回 `undefined`）：
 * - 模板组：缺名字、`templates` 不是一到两项、两项同 `kind`、`tree` / `knowledge_graph` 之外的 `kind`、`config` 不是 §5.1 (2)
 *   提交过的形状（`tree` 去掉 `entity`、`relation`、`llm_id`，`knowledge_graph` 去掉 `llm_id`）。只有带内置 `entity`（一条空
 *   `type`）的 `tree` 有记录：`102`。
 * - 画布：缺 `title`、`canvas_category` 不是 `dataflow_canvas`、`dsl` 不是对象。
 * - 已存在的画布与模板组的 `GET`：读回的形状本组不用。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - 内置模板只给 `tree` 与 `knowledge_graph` 两项：其余六种只读过形状（§5.1 (2)）。长文本、`display_name`、`description` 与
 *   `llm_id` 的内置值是这里写的；`entity`、`relation` 的 `fields` 实测有 6 项，这里各给 1 项。
 * - 内置 pipeline 的节点 id、`component_name`、链的次序与节点 / 边数取自 §5.1 (3) 的表；`params`、`graph` 节点的 `type`
 *   （`beginNode` 等取自 §5.1 (6)，Extractor 的 `extractorNode` 是这里写的）、位置、边 id 与顶层六键的取值是这里写的。
 * - 应答里的时间、`user_id`、`release`、`tags` 的取值；模板组应答里 `templates` 的项形状。
 * - 画布同名改名不区分大小写：记录只有 `owb-cv-life(1)` 一例，沿用模板组的规则。
 */
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { failure, success } from "./fake-ragflow-script.mjs";

const API = "/api/v1";
const BUILTIN_LLM = "builtin-llm@builtin@Builtin";
const EXTRACTOR = "Extractor:AutoExtractDefault";
const CREATED_AT = 1_793_000_000_000;

const newId = () => randomBytes(16).toString("hex");
const foldCase = (text) => text.toLowerCase();

/** 重名时加序号，取第一个没被占的；`fold` 决定比较时算不算大小写（§4.5、§5.1 (2)、§7.1）。 */
export function numberedName(names, stem, tail, fold) {
  const taken = new Set(names.map(fold));
  let name = `${stem}${tail}`;
  for (let round = 1; taken.has(fold(name)); round += 1) {
    name = `${stem}(${round})${tail}`;
  }
  return name;
}

const emptyFields = () => ({ description: "", fields: [{ type: "", description: "", rule: "" }] });

/** §5.1 (2) 的两种内置 `config`。 */
const BUILTIN_CONFIGS = {
  tree: {
    kind: "tree",
    llm_id: BUILTIN_LLM,
    global_rules: "",
    raptor: {
      prompt: "Summarize the following passages.",
      claim_prompt: "Extract the claims of the following passages.",
      max_token: 512,
      clustering_threshold: 0.3,
      clustering_ratio: 0.5,
    },
    entity: emptyFields(),
    relation: emptyFields(),
  },
  knowledge_graph: {
    kind: "knowledge_graph",
    llm_id: BUILTIN_LLM,
    global_rules: "",
    rechunk_rules: "Split the text at entity boundaries.",
    entity: {
      description: "Things the text talks about.",
      fields: [{ type: "person", description: "A human being.", rule: "Use the full name." }],
    },
    relation: {
      description: "How the things relate.",
      fields: [{ type: "owns", description: "Ownership.", rule: "Owner first." }],
    },
  },
};

/** §5.1 (2)：本次提交、建组成功的 `config`。 */
const PRUNED = { tree: ["entity", "relation", "llm_id"], knowledge_graph: ["llm_id"] };

function submittedConfig(kind) {
  const config = structuredClone(BUILTIN_CONFIGS[kind]);
  for (const key of PRUNED[kind]) delete config[key];
  return config;
}

/** §5.1 (3) 的表：`parser_id` 到单链上 File 之后的节点。`naive` 回的 DSL 与 `general` 相同，`tag` 回 `102`。 */
const CHAINS = new Map([
  [
    "general",
    [
      "Parser:HipSignsRhyme",
      "GeneralChunker:SixApplesFall",
      EXTRACTOR,
      "Tokenizer:LegalReadersDecide",
    ],
  ],
  [
    "book",
    [
      "Parser:HipSignsRhyme",
      "TitleChunker:GrumpyGarlicsBake",
      EXTRACTOR,
      "Tokenizer:HotDonutsRing",
    ],
  ],
  [
    "email",
    [
      "Parser:BirdsFlutterHigh",
      "TokenChunker:WarmBreadSmells",
      EXTRACTOR,
      "Tokenizer:NiceWordsSpoken",
    ],
  ],
  [
    "laws",
    ["Parser:HipSignsRhyme", "TitleChunker:SpicyKeysKick", EXTRACTOR, "Tokenizer:PublicJobsTake"],
  ],
  [
    "manual",
    [
      "Parser:HipSignsRhyme",
      "ManualChunker:NineInsectsFind",
      EXTRACTOR,
      "Tokenizer:FunnyBalloonsGrin",
    ],
  ],
  [
    "one",
    ["Parser:HipSignsRhyme", "OneChunker:DryDrinksVisit", EXTRACTOR, "Tokenizer:FrankWeeksListen"],
  ],
  [
    "paper",
    [
      "Parser:HipSignsRhyme",
      "TitleChunker:SparklySchoolsTravel",
      EXTRACTOR,
      "Tokenizer:GreatCarsWash",
    ],
  ],
  [
    "picture",
    [
      "Parser:ViewsCaptureLight",
      "OneChunker:BrightColorsGlow",
      EXTRACTOR,
      "Tokenizer:SharpLensFocus",
    ],
  ],
  [
    "presentation",
    ["Parser:HipSignsRhyme", "PageChunker:HappyHillsGlow", EXTRACTOR, "Tokenizer:TallTreesDance"],
  ],
  ["qa", ["Parser:HipSignsRhyme", "QAChunker:TidyCloudsThink", "Tokenizer:ColdCloudsDream"]],
  ["table", ["Parser:HipSignsRhyme", "TableChunker:FastFoxesJump", "Tokenizer:DeepLakesShine"]],
  [
    "audio",
    ["Parser:SongsFillAir", "OneChunker:BlueSkiesLaugh", EXTRACTOR, "Tokenizer:KindEyesWatch"],
  ],
]);

function nodeType(componentName) {
  if (componentName.endsWith("Chunker")) {
    return "chunkerNode";
  }
  const types = { File: "beginNode", Parser: "parserNode", Extractor: "extractorNode" };
  return types[componentName] ?? "tokenizerNode";
}

/** 内置 DSL：`File → Parser → chunker → [Extractor] → Tokenizer` 的单链，带 `graph`（§5.1 (3)），顶层另有六键。 */
function chainDsl(chain) {
  const ids = ["File", ...chain];
  const components = {};
  const nodes = [];
  const edges = [];
  ids.forEach((id, at) => {
    const componentName = id.split(":")[0];
    components[id] = {
      upstream: at === 0 ? [] : [ids[at - 1]],
      downstream: at === ids.length - 1 ? [] : [ids[at + 1]],
      obj: { component_name: componentName, params: {} },
    };
    nodes.push({
      id,
      type: nodeType(componentName),
      data: { label: componentName, name: componentName, form: {} },
      position: { x: at * 300, y: 200 },
      sourcePosition: "right",
      targetPosition: "left",
      measured: { width: 200, height: 60 },
      dragging: false,
      selected: false,
    });
    if (at > 0) {
      edges.push({
        id: `e${at - 1}`,
        source: ids[at - 1],
        sourceHandle: "start",
        target: id,
        targetHandle: "end",
      });
    }
  });
  return {
    components,
    graph: { nodes, edges },
    globals: {},
    history: [],
    messages: [],
    path: [],
    retrieval: [],
    variables: {},
  };
}

/** 这个 `parser_id` 的内置 DSL 的副本；`tag` 与未知的为 `undefined`。用例拿它做故障注入的原料。 */
export function builtinPipeline(parserId) {
  const chain = CHAINS.get(parserId === "naive" ? "general" : parserId);
  return chain === undefined ? undefined : chainDsl(chain);
}

export function createPipelineState() {
  return { groups: new Map(), canvases: new Map() };
}

function listBuiltins() {
  return success(
    Object.entries(BUILTIN_CONFIGS).map(([id, config]) => ({
      id,
      kind: config.kind,
      display_name: id,
      description: `Built-in ${id} template.`,
      config: structuredClone(config),
    })),
  );
}

const isNamed = (value) => typeof value === "string" && value !== "";

/** 一项模板：记录里的四键，`kind` 与 `config` 是 §5.1 (2) 建组成功的组合。 */
function templateOutcome(template) {
  const { name, kind, description, config } = template ?? {};
  if (!isNamed(name) || description !== "" || !Object.hasOwn(PRUNED, kind)) {
    return "unknown";
  }
  if (kind === "tree" && config?.entity?.fields?.some((field) => field.type === "") === true) {
    return "entity";
  }
  return isDeepStrictEqual(config, submittedConfig(kind)) ? "ok" : "unknown";
}

/** `undefined`：建得成；`null`：记录里没有，落到未知路由；其余是记录里的 `102`。 */
function groupRejection(templates) {
  const names = templates.map((template) => template?.name);
  const duplicated = names.find((name, at) => names.indexOf(name) !== at);
  if (duplicated !== undefined) {
    return failure(102, `template name '${String(duplicated)}' is duplicated in this group.`);
  }
  const outcomes = templates.map(templateOutcome);
  if (outcomes.includes("unknown")) {
    return null;
  }
  return outcomes.includes("entity") ? failure(102, "Entity type is required") : undefined;
}

function createGroup(state, request) {
  const { groups } = state.pipeline;
  const { name, description, templates } = request.body;
  const shaped = Array.isArray(templates) && templates.length >= 1 && templates.length <= 2;
  if (!isNamed(name) || description !== "" || !shaped) {
    return undefined;
  }
  if (new Set(templates.map((template) => template?.kind)).size !== templates.length) {
    return undefined;
  }
  const rejection = groupRejection(templates);
  if (rejection === null) {
    return undefined;
  }
  if (rejection !== undefined) {
    return rejection;
  }
  const names = [...groups.values()].map((group) => group.name);
  const group = { id: newId(), name: numberedName(names, name, "", foldCase) };
  // §5.1 (2)：只有一个模板的组，模板 `name` 被改写成组名；两个模板的组保留提交的模板名。
  group.templates = templates.map((template) => ({
    ...template,
    name: templates.length === 1 ? group.name : template.name,
  }));
  groups.set(group.id, group);
  return success({
    ...group,
    description: "",
    scope: "file",
    create_time: CREATED_AT,
    update_time: CREATED_AT,
  });
}

function readPipeline(_state, _request, [parserId]) {
  const dsl = builtinPipeline(parserId);
  return dsl === undefined ? failure(102, "pipeline not found") : success({ dsl });
}

function createCanvas(state, request) {
  const { canvases } = state.pipeline;
  const { title, canvas_category: category, dsl } = request.body;
  if (dsl === undefined) {
    return failure(101, "no DSL data in request");
  }
  const typed = dsl !== null && typeof dsl === "object" && !Array.isArray(dsl);
  if (!isNamed(title) || category !== "dataflow_canvas" || !typed) {
    return undefined;
  }
  const titles = [...canvases.values()].map((canvas) => canvas.title);
  const canvas = { id: newId(), title: numberedName(titles, title, "", foldCase), dsl };
  canvases.set(canvas.id, canvas);
  return success({
    canvas_category: category,
    create_date: "Sun, 01 Nov 2026 08:00:00 GMT",
    create_time: CREATED_AT,
    dsl,
    id: canvas.id,
    permission: "me",
    release: false,
    tags: [],
    title: canvas.title,
    update_date: "Sun, 01 Nov 2026 08:00:00 GMT",
    update_time: CREATED_AT,
    user_id: "user-1",
  });
}

const AGENT_DENIED = "Only the owner of the agent is authorized for this operation.";
const AGENT_HIDDEN = "Make sure you have permission to access the agent.";
const groupMissing = (id) => failure(404, `Cannot find compilation template group ${id}.`);

/** 表 B 的「不存在」组合；存在时 `DELETE` 删掉它，`GET` 落到未知路由。 */
function resourceRoute(pick, absent, method) {
  return (state, _request, [id]) => {
    const resources = pick(state.pipeline);
    if (!resources.has(id)) {
      return absent(id);
    }
    if (method === "GET") {
      return undefined;
    }
    // §5.1 (7)：没有引用保护，被画布或数据集引用的同样删掉。
    resources.delete(id);
    return success(true);
  };
}

const canvasesOf = (pipeline) => pipeline.canvases;
const groupsOf = (pipeline) => pipeline.groups;

/** 用例的种子与两个视图。 */
export function pipelineViews(pipeline) {
  return {
    addTemplateGroup(name = "owb-seed-group") {
      const group = { id: newId(), name, templates: [] };
      pipeline.groups.set(group.id, group);
      return group.id;
    },
    addCanvas(title = "owb-seed-canvas") {
      const canvas = { id: newId(), title, dsl: {} };
      pipeline.canvases.set(canvas.id, canvas);
      return canvas.id;
    },
    templateGroups: () =>
      [...pipeline.groups.values()].map(({ id, name, templates }) => ({
        id,
        name,
        templates: structuredClone(templates),
      })),
    canvases: () =>
      [...pipeline.canvases.values()].map(({ id, title, dsl }) => ({
        id,
        title,
        dsl: structuredClone(dsl),
      })),
  };
}

const segment = "([^/]+)";
const AGENT = `${API}/agents/${segment}`;
const GROUP = `${API}/compilation-template-groups/${segment}`;
/** `[方法, 路径, 处理函数, 选项]`，同 `fake-ragflow.mjs` 的 `ROUTES`。`GET /pipelines` 无须鉴权（§15）。 */
export const PIPELINE_ROUTES = [
  ["GET", `${API}/compilation-templates/builtins`, listBuiltins],
  ["POST", `${API}/compilation-template-groups`, createGroup],
  ["GET", GROUP, resourceRoute(groupsOf, groupMissing, "GET")],
  ["DELETE", GROUP, resourceRoute(groupsOf, groupMissing, "DELETE")],
  ["GET", `${API}/pipelines/${segment}`, readPipeline, { open: true }],
  ["POST", `${API}/agents`, createCanvas],
  ["GET", AGENT, resourceRoute(canvasesOf, () => failure(103, AGENT_HIDDEN), "GET")],
  ["DELETE", AGENT, resourceRoute(canvasesOf, () => failure(103, AGENT_DENIED), "DELETE")],
];
