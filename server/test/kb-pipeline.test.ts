/**
 * s2a-kb-ragflow tasks 9.5（#1869）：DSL 生成与模板组的模板项，纯函数（design「Sketch seams」的 DSL 生成函数，D9）。省掉
 * `graph` 或改错边时 RAGFlow 回 `code:0`、编译静默不运行（实测记录 §5.1 (6)、§18 #25），假 RAGFlow 也不会替你报错，所以
 * 期望值逐键取自记录：§5.1 (6) 手写 DSL 的 `components` 与 `graph`，§5.1 (3) 的节点表（在 `kb-bases-helpers.ts`），§5.1 (2)
 * 的 `config` 删键。输入是内置 DSL：手写 DSL 去掉 Compiler、chunker 直连 Tokenizer，以及夹具按 §5.1 (3) 给出的十一种。
 */
import { describe, expect, it } from "vitest";
import { groupTemplates, insertCompiler } from "../src/kb/pipeline.js";
import { BUILTIN_PIPELINES, COMPILER, componentOf, type DslShape } from "./kb-bases-helpers.js";
import { builtinPipeline } from "./support/fake-ragflow-pipeline.mjs";

const GROUP = "0123456789abcdef0123456789abcdef";
const PARAMS = {
  compilation_template_group_id: GROUP,
  llm_id: "",
  plan: false,
  outputs: { chunks: { type: "Array<Object>", value: [] } },
};
const TOKENIZER_PARAMS = {
  fields: "text",
  filename_embd_weight: 0.1,
  search_method: ["embedding", "full_text"],
  outputs: {},
};
const place = (x: number) => ({
  position: { x, y: 200 },
  sourcePosition: "right",
  targetPosition: "left",
});

/** 实测记录 §5.1 (6) 手写的最小 DSL，`<group_id>` 换成 `GROUP`。 */
const HANDWRITTEN = {
  components: {
    File: {
      upstream: [],
      downstream: ["Parser:Owb"],
      obj: { component_name: "File", params: {} },
    },
    "Parser:Owb": {
      upstream: ["File"],
      downstream: ["GeneralChunker:Owb"],
      obj: {
        component_name: "Parser",
        params: {
          "text&code": { output_format: "json", preprocess: ["main_content"], suffix: ["txt"] },
          enable_vision_enhancement: false,
          vlm: { llm_id: "" },
        },
      },
    },
    "GeneralChunker:Owb": {
      upstream: ["Parser:Owb"],
      downstream: ["Compiler:Owb"],
      obj: {
        component_name: "GeneralChunker",
        params: {
          children_delimiters: [],
          chunk_token_size: 512,
          delimiters: ["\n"],
          image_context_size: 0,
          overlapped_percent: 0,
          table_context_size: 0,
          outputs: { chunks: { type: "Array<Object>", value: [] } },
        },
      },
    },
    "Compiler:Owb": {
      upstream: ["GeneralChunker:Owb"],
      downstream: ["Tokenizer:Owb"],
      obj: { component_name: "Compiler", params: PARAMS },
    },
    "Tokenizer:Owb": {
      upstream: ["Compiler:Owb"],
      downstream: [],
      obj: { component_name: "Tokenizer", params: TOKENIZER_PARAMS },
    },
  },
  graph: {
    nodes: [
      {
        id: "File",
        type: "beginNode",
        data: { label: "File", name: "File", form: {} },
        ...place(0),
      },
      {
        id: "Parser:Owb",
        type: "parserNode",
        data: { label: "Parser", name: "Parser", form: {} },
        ...place(300),
      },
      {
        id: "GeneralChunker:Owb",
        type: "chunkerNode",
        data: { label: "GeneralChunker", name: "GeneralChunker", form: {} },
        ...place(600),
      },
      {
        id: "Compiler:Owb",
        type: "compilationNode",
        data: { label: "Compiler", name: "Compiler", form: PARAMS },
        ...place(900),
      },
      {
        id: "Tokenizer:Owb",
        type: "tokenizerNode",
        data: { label: "Tokenizer", name: "Tokenizer", form: TOKENIZER_PARAMS },
        ...place(1200),
      },
    ],
    edges: [
      {
        id: "e0",
        source: "File",
        sourceHandle: "start",
        target: "Parser:Owb",
        targetHandle: "end",
      },
      {
        id: "e1",
        source: "Parser:Owb",
        sourceHandle: "start",
        target: "GeneralChunker:Owb",
        targetHandle: "end",
      },
      {
        id: "e2",
        source: "GeneralChunker:Owb",
        sourceHandle: "start",
        target: "Compiler:Owb",
        targetHandle: "end",
      },
      {
        id: "e3",
        source: "Compiler:Owb",
        sourceHandle: "start",
        target: "Tokenizer:Owb",
        targetHandle: "end",
      },
    ],
  },
};

type Dsl = DslShape;

/** 手写 DSL 去掉 Compiler：chunker 直连 Tokenizer，原边 `e2` 是 chunker → Tokenizer。 */
function withoutCompiler(): Dsl {
  const dsl: Dsl = structuredClone(HANDWRITTEN);
  delete dsl.components[COMPILER];
  componentOf(dsl, "GeneralChunker:Owb").downstream = ["Tokenizer:Owb"];
  componentOf(dsl, "Tokenizer:Owb").upstream = ["GeneralChunker:Owb"];
  dsl.graph.nodes = dsl.graph.nodes.filter(({ id }) => id !== COMPILER);
  dsl.graph.edges = [
    ...dsl.graph.edges.filter(({ id }) => id === "e0" || id === "e1"),
    {
      id: "e2",
      source: "GeneralChunker:Owb",
      sourceHandle: "start",
      target: "Tokenizer:Owb",
      targetHandle: "end",
    },
  ];
  return dsl;
}

const link = ({ source, sourceHandle, target, targetHandle }: Record<string, unknown>) =>
  `${String(source)}:${String(sourceHandle)} -> ${String(target)}:${String(targetHandle)}`;

function compiled(builtin: Record<string, unknown> | undefined): Dsl {
  const dsl = insertCompiler(builtin ?? {}, GROUP);
  expect(dsl).toBeDefined();
  return dsl as Dsl;
}

describe("DSL 生成：§5.1 (6) 的手写 DSL", () => {
  it("components 与手写 DSL 逐键相等：Compiler 插在 chunker 与 Tokenizer 之间，上下游都改写", () => {
    expect(compiled(withoutCompiler()).components).toEqual(HANDWRITTEN.components);
  });

  it("graph 必在；graph.nodes 加 compilationNode，data.form 是同一份 params", () => {
    const byId = (nodes: { id: string }[]) => [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    const dsl = compiled(withoutCompiler());
    expect(byId(dsl.graph.nodes)).toEqual(byId(HANDWRITTEN.graph.nodes));
  });

  it("graph.edges 净增一条：原边 source 改为 Compiler 且不保留 chunker → Tokenizer，另加 chunker → Compiler", () => {
    const input = withoutCompiler();
    const { edges } = compiled(input).graph;
    expect(edges).toHaveLength(input.graph.edges.length + 1);
    expect(edges.map(link).sort()).toEqual(HANDWRITTEN.graph.edges.map(link).sort());
    expect(edges.map(link)).not.toContain("GeneralChunker:Owb:start -> Tokenizer:Owb:end");
    expect(new Set(edges.map(({ id }) => id)).size).toBe(edges.length);
  });

  it("不改输入", () => {
    const input = withoutCompiler();
    const before = structuredClone(input);
    compiled(input);
    expect(input).toEqual(before);
  });
});

describe("DSL 生成：十一种内置 pipeline（§5.1 (3)）", () => {
  it.each(BUILTIN_PIPELINES)(
    "%s：按 component_name 查到 %s，Compiler 插在它与原下游之间",
    (_template, parserId, chunker, downstream, nodes, edges) => {
      const builtin = builtinPipeline(parserId);
      const dsl = compiled(builtin);
      const { components, graph } = dsl;
      expect(componentOf(dsl, chunker).downstream).toEqual([COMPILER]);
      expect(components[COMPILER]).toEqual({
        upstream: [chunker],
        downstream: [downstream],
        obj: { component_name: "Compiler", params: PARAMS },
      });
      expect(componentOf(dsl, downstream).upstream).toEqual([COMPILER]);
      expect(graph.nodes).toHaveLength(nodes + 1);
      expect(graph.nodes.find(({ id }) => id === COMPILER)).toMatchObject({
        type: "compilationNode",
        data: { label: "Compiler", name: "Compiler", form: PARAMS },
        position: { x: expect.any(Number), y: expect.any(Number) },
      });
      const links = graph.edges.map(link);
      expect(links).toHaveLength(edges + 1);
      expect(links).toContain(`${chunker}:start -> ${COMPILER}:end`);
      expect(links).toContain(`${COMPILER}:start -> ${downstream}:end`);
      expect(links).not.toContain(`${chunker}:start -> ${downstream}:end`);
      // 内置 DSL 的顶层另有六键，原样带上（§5.1 (6) 的注）。
      expect(Object.keys(dsl).sort()).toEqual(Object.keys(builtin ?? {}).sort());
    },
  );
});

describe("DSL 无法改写即失败（故障注入：记录里全部内置模板都带 graph、恰一个 chunker）", () => {
  it("没有 graph", () => {
    const { graph: _graph, ...rest } = withoutCompiler();
    expect(insertCompiler(rest, GROUP)).toBeUndefined();
  });

  it("零个 chunker", () => {
    const dsl = withoutCompiler();
    componentOf(dsl, "GeneralChunker:Owb").obj.component_name = "Splitter";
    expect(insertCompiler(dsl, GROUP)).toBeUndefined();
  });

  it("两个 chunker", () => {
    const dsl = withoutCompiler();
    componentOf(dsl, "Tokenizer:Owb").obj.component_name = "TokenChunker";
    expect(insertCompiler(dsl, GROUP)).toBeUndefined();
  });
});

describe("模板组的模板项（§5.1 (2)）", () => {
  const TREE = {
    kind: "tree",
    llm_id: "builtin",
    global_rules: "",
    raptor: {
      prompt: "p",
      claim_prompt: "c",
      max_token: 512,
      clustering_threshold: 0.3,
      clustering_ratio: 0.5,
    },
    entity: { description: "", fields: [{ type: "", description: "", rule: "" }] },
    relation: { description: "", fields: [{ type: "", description: "", rule: "" }] },
  };
  const FIELDS = { description: "d", fields: [{ type: "person", description: "d", rule: "r" }] };
  const GRAPH = {
    kind: "knowledge_graph",
    llm_id: "builtin",
    global_rules: "",
    rechunk_rules: "r",
    entity: FIELDS,
    relation: FIELDS,
  };
  const BUILTINS = [
    { id: "timeline", config: { kind: "timeline" } },
    { id: "tree", config: TREE },
    { id: "knowledge_graph", config: GRAPH },
  ];
  /** §5.1 (2)：本次提交的 config，tree 去掉 entity、relation、llm_id，knowledge_graph 去掉 llm_id。 */
  const SUBMITTED_TREE = { kind: "tree", global_rules: "", raptor: TREE.raptor };
  const SUBMITTED_GRAPH = {
    kind: "knowledge_graph",
    global_rules: "",
    rechunk_rules: "r",
    entity: FIELDS,
    relation: FIELDS,
  };

  it("两个开关：tree 与 knowledge_graph 两项，形状同 §5.1 (2) 的 body，名字各自不同", () => {
    expect(groupTemplates(BUILTINS, "owb-x-g0", { raptor: true, graph: true })).toEqual([
      { name: "owb-x-g0-t", kind: "tree", description: "", config: SUBMITTED_TREE },
      { name: "owb-x-g0-g", kind: "knowledge_graph", description: "", config: SUBMITTED_GRAPH },
    ]);
  });

  it("只开一种：只含那一项", () => {
    expect(groupTemplates(BUILTINS, "n", { raptor: true, graph: false })).toEqual([
      { name: "n-t", kind: "tree", description: "", config: SUBMITTED_TREE },
    ]);
    expect(groupTemplates(BUILTINS, "n", { raptor: false, graph: true })).toEqual([
      { name: "n-g", kind: "knowledge_graph", description: "", config: SUBMITTED_GRAPH },
    ]);
  });

  it("要用的内置模板不在：失败；不改输入", () => {
    const before = structuredClone(BUILTINS);
    expect(
      groupTemplates(BUILTINS.slice(0, 2), "n", { raptor: true, graph: true }),
    ).toBeUndefined();
    groupTemplates(BUILTINS, "n", { raptor: true, graph: true });
    expect(BUILTINS).toEqual(before);
  });
});
