/**
 * Issue #987（S1g 任务 2.2）：模型白名单 `MODEL_CATALOG` 的解析与推理强度集合。
 * 期望值逐条取自 model-selection「模型白名单配置」「推理强度集合」的条文与场景，不引用源码常量。
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgentSettings } from "../src/agent-config.js";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type CatalogModel,
  defaultEffort,
  type Effort,
  effectiveComposer,
  type ModelCatalog,
  resolveModelCatalog,
  selectableEfforts,
} from "../src/model-catalog.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const KEY = "MODEL_CATALOG";
const THREE_MODELS =
  '[{"id":"m1","name":"通用","reasoning":true,"efforts":["minimal","low","medium","high","xhigh","max"]},{"id":"m2"},{"id":"m3","name":"深度","reasoning":true,"vision":true,"efforts":["low","high"]}]';
const THREE_MODELS_PARSED: readonly CatalogModel[] = [
  {
    id: "m1",
    name: "通用",
    reasoning: true,
    vision: false,
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  { id: "m2", name: "m2", reasoning: false, vision: false },
  { id: "m3", name: "深度", reasoning: true, vision: true, efforts: ["low", "high"] },
];

function messageOf(env: Record<string, string | undefined>): string {
  try {
    resolveModelCatalog(env);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("模型白名单配置 — 未配置白名单等于单模型", () => {
  it("MODEL_ID 与 MODEL_REASONING 均未设置：恰一项缺省模型，不带 efforts 键", () => {
    expect(resolveModelCatalog({})).toStrictEqual({
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "deepseek-v4.1-flash",
          reasoning: true,
          vision: false,
        },
      ],
      defaultModelId: "deepseek-v4.1-flash",
    });
  });

  it("MODEL_ID=qwen-x、MODEL_REASONING=off：恰一项，不支持推理", () => {
    expect(resolveModelCatalog({ MODEL_ID: "qwen-x", MODEL_REASONING: "off" })).toStrictEqual({
      models: [{ id: "qwen-x", name: "qwen-x", reasoning: false, vision: false }],
      defaultModelId: "qwen-x",
    });
  });

  it("显式 undefined 与未设置相同", () => {
    expect(
      resolveModelCatalog({
        MODEL_CATALOG: undefined,
        MODEL_ID: undefined,
        MODEL_REASONING: undefined,
      }),
    ).toStrictEqual(resolveModelCatalog({}));
  });

  it.each([" custom-model ", "", "a\u0000b", "x".repeat(200)])(
    "旧式单模型的 MODEL_ID 原样保留，不受白名单的 id 规则约束（%j）",
    (raw) => {
      expect(resolveModelCatalog({ MODEL_ID: raw })).toStrictEqual({
        models: [{ id: raw, name: raw, reasoning: true, vision: false }],
        defaultModelId: raw,
      });
    },
  );

  it.each(["", "ON", "true", " on"])("MODEL_REASONING 非法取值 %j 的错误文本不变", (raw) => {
    expect(messageOf({ MODEL_REASONING: raw })).toBe("MODEL_REASONING must be exactly on or off");
  });
});

describe("模型白名单配置 — 多模型白名单与缺省模型", () => {
  it("MODEL_ID 未设置：三项次序不变，缺省补齐，第一项为缺省模型", () => {
    expect(resolveModelCatalog({ [KEY]: THREE_MODELS })).toStrictEqual({
      models: THREE_MODELS_PARSED,
      defaultModelId: "m1",
    });
  });

  it("MODEL_ID=m3：同一份白名单，缺省模型为 m3", () => {
    expect(resolveModelCatalog({ [KEY]: THREE_MODELS, MODEL_ID: "m3" })).toStrictEqual({
      models: THREE_MODELS_PARSED,
      defaultModelId: "m3",
    });
  });

  it("m2 不带 efforts 键", () => {
    const m2 = resolveModelCatalog({ [KEY]: THREE_MODELS }).models[1];
    expect(m2 !== undefined && Object.hasOwn(m2, "efforts")).toBe(false);
  });

  it("恰 32 项、128 字节的 id 与 64 码点的 name 都在界内", () => {
    const items = Array.from({ length: 32 }, (_, index) => ({ id: `m${index}` }));
    expect(resolveModelCatalog({ [KEY]: JSON.stringify(items) }).models).toHaveLength(32);
    const id = "é".repeat(64);
    const name = "😀".repeat(64);
    expect(resolveModelCatalog({ [KEY]: JSON.stringify([{ id, name }]) })).toStrictEqual({
      models: [{ id, name, reasoning: false, vision: false }],
      defaultModelId: id,
    });
  });
});

/** 规格场景「非法白名单使启动失败」逐一列出的十六个取值。 */
const SPEC_ILLEGAL: readonly string[] = [
  "",
  "not json",
  "{}",
  "[]",
  JSON.stringify(Array.from({ length: 33 }, (_, index) => ({ id: `m${index}` }))),
  '[{"name":"x"}]',
  '[{"id":""}]',
  '[{"id":"a"},{"id":"a"}]',
  '[{"id":"a","extra":1}]',
  '[{"id":"a","reasoning":"yes"}]',
  '[{"id":"a","reasoning":true}]',
  '[{"id":"a","efforts":["low"]}]',
  '[{"id":"a","reasoning":true,"efforts":[]}]',
  '[{"id":"a","reasoning":true,"efforts":["high","low"]}]',
  '[{"id":"a","reasoning":true,"efforts":["ultra"]}]',
  '[{"id":"a","reasoning":true,"efforts":["auto"]}]',
];

/** 条文里写明、场景未逐一枚举的约束（id / name 的长度与控制字符、类型不符、重复强度等）。 */
const REQUIREMENT_ILLEGAL: readonly string[] = [
  "null",
  "7",
  '"m1"',
  "[null]",
  '["m1"]',
  "[[]]",
  '[{"id":7}]',
  JSON.stringify([{ id: `${"é".repeat(64)}x` }]),
  JSON.stringify([{ id: "a\u0000b" }]),
  JSON.stringify([{ id: "a\u001fb" }]),
  JSON.stringify([{ id: "a\u007fb" }]),
  '[{"id":"a","name":""}]',
  '[{"id":"a","name":7}]',
  JSON.stringify([{ id: "a", name: "😀".repeat(65) }]),
  JSON.stringify([{ id: "a", name: "x\ny" }]),
  '[{"id":"a","vision":"yes"}]',
  '[{"id":"a","vision":1}]',
  '[{"id":"a","reasoning":false,"efforts":["low"]}]',
  '[{"id":"a","reasoning":true,"efforts":"low"}]',
  '[{"id":"a","reasoning":true,"efforts":[1]}]',
  '[{"id":"a","reasoning":true,"efforts":["low","low"]}]',
  '[{"id":"a","reasoning":true,"efforts":["off"]}]',
  '[{"id":"a","reasoning":true,"efforts":["off","low"]}]',
  '[{"id":"a","__proto__":{}}]',
];

describe("模型白名单配置 — 非法白名单使启动失败", () => {
  it.each([...SPEC_ILLEGAL])("规格场景的取值 %j 点名 MODEL_CATALOG 且不回显取值", (raw) => {
    const message = messageOf({ [KEY]: raw });
    expect(message).toContain(KEY);
    expect(message).not.toContain("MODEL_ID");
    expect(message).not.toContain("MODEL_REASONING");
    // 空串是任何字符串的子串，这一行的「不含取值」无从断言。
    if (raw !== "") {
      expect(message).not.toContain(raw);
    }
  });

  it("规格场景恰列出十六个取值", () => {
    expect(SPEC_ILLEGAL).toHaveLength(16);
  });

  it.each([...REQUIREMENT_ILLEGAL])("条文约束的取值 %j 点名 MODEL_CATALOG 且不回显取值", (raw) => {
    const message = messageOf({ [KEY]: raw });
    expect(message).toContain(KEY);
    expect(message).not.toContain(raw);
  });

  it("错误信息不带 JSON 解析器的原文（它会回显输入）", () => {
    const message = messageOf({ [KEY]: "secret-model-name" });
    expect(message).not.toContain("secret");
    expect(message).not.toContain("JSON at");
    expect(message).not.toContain("Unexpected");
  });

  it("元素内的取值（id、name、强度名）也不回显", () => {
    const leaked = "leaky-model-id";
    for (const raw of [
      `[{"id":"${leaked}"},{"id":"${leaked}"}]`,
      `[{"id":"${leaked}","reasoning":true}]`,
      `[{"id":"a","name":"${leaked}","extra":1}]`,
      `[{"id":"a","reasoning":true,"efforts":["${leaked}"]}]`,
      `[{"id":"a","${leaked}":1}]`,
    ]) {
      const message = messageOf({ [KEY]: raw });
      expect(message).toContain(KEY);
      expect(message).not.toContain(leaked);
    }
  });

  it.each(["other", "", "M1", " m1"])("白名单合法而 MODEL_ID=%j 不在其中：点名 MODEL_ID", (id) => {
    const message = messageOf({ [KEY]: THREE_MODELS, MODEL_ID: id });
    expect(message).toContain("MODEL_ID");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("MODEL_REASONING");
    expect(message).not.toContain("other");
  });

  it.each(["on", "off", "", "bogus"])(
    "白名单合法且同时设置 MODEL_REASONING=%j：点名 MODEL_REASONING",
    (raw) => {
      const message = messageOf({ [KEY]: THREE_MODELS, MODEL_REASONING: raw });
      expect(message).toContain("MODEL_REASONING");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("MODEL_ID");
      expect(message).not.toContain("bogus");
    },
  );
});

describe("推理强度集合 — 可选强度与缺省强度", () => {
  const base = { id: "m", name: "m", vision: false };
  const cases: readonly [string, CatalogModel, readonly Effort[], Effort | null][] = [
    ["不支持推理", { ...base, reasoning: false }, [], null],
    [
      "推理且不带 efforts（MODEL_CATALOG 未设置时的那一项）",
      { ...base, reasoning: true },
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "high",
    ],
    [
      "efforts 为 low、high",
      { ...base, reasoning: true, efforts: ["low", "high"] },
      ["off", "low", "high"],
      "high",
    ],
    [
      "efforts 为 minimal、low",
      { ...base, reasoning: true, efforts: ["minimal", "low"] },
      ["off", "minimal", "low"],
      "low",
    ],
    [
      "efforts 为 xhigh、max",
      { ...base, reasoning: true, efforts: ["xhigh", "max"] },
      ["off", "xhigh", "max"],
      "xhigh",
    ],
  ];

  it.each(cases)("%s", (_label, model, selectable, fallback) => {
    expect(selectableEfforts(model)).toStrictEqual(selectable);
    expect(defaultEffort(model)).toBe(fallback);
  });

  it("解析出的白名单项与旧式单模型项走同一份规则", () => {
    const [m1, m2, m3] = resolveModelCatalog({ [KEY]: THREE_MODELS }).models;
    const [legacy] = resolveModelCatalog({}).models;
    if (m1 === undefined || m2 === undefined || m3 === undefined || legacy === undefined) {
      throw new Error("expected three catalog models and one legacy model");
    }
    expect(selectableEfforts(m2)).toStrictEqual([]);
    expect(defaultEffort(m2)).toBeNull();
    expect(selectableEfforts(m3)).toStrictEqual(["off", "low", "high"]);
    expect(defaultEffort(m1)).toBe("high");
    expect(selectableEfforts(legacy)).toStrictEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(defaultEffort(legacy)).toBe("high");
  });

  it("多次求值互不影响（返回值不是共享的可变数组）", () => {
    const model = { ...base, reasoning: true };
    const first = selectableEfforts(model) as Effort[];
    first.push("off");
    expect(selectableEfforts(model)).toHaveLength(7);
  });
});

describe("resolveAgentSettings — 白名单进入配置", () => {
  const root = join(REPO_ROOT, "server");
  /** 白名单里 id 等于 defaultModelId 的那一项（缺省模型的推理位从这里读）。 */
  const defaultModelOf = (catalog: ModelCatalog): CatalogModel | undefined =>
    catalog.models.find((model) => model.id === catalog.defaultModelId);

  it("缺省：modelCatalog 为单模型，缺省模型即该项且支持推理", () => {
    const settings = resolveAgentSettings({}, root);
    expect(settings.modelCatalog).toStrictEqual({
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "deepseek-v4.1-flash",
          reasoning: true,
          vision: false,
        },
      ],
      defaultModelId: "deepseek-v4.1-flash",
    });
    expect(settings.modelCatalog.defaultModelId).toBe("deepseek-v4.1-flash");
    expect(defaultModelOf(settings.modelCatalog)?.reasoning).toBe(true);
  });

  it("旧式单模型：MODEL_ID 与 MODEL_REASONING 原样进入 modelCatalog", () => {
    const settings = resolveAgentSettings({ MODEL_ID: "qwen-x", MODEL_REASONING: "off" }, root);
    expect(settings.modelCatalog).toStrictEqual({
      models: [{ id: "qwen-x", name: "qwen-x", reasoning: false, vision: false }],
      defaultModelId: "qwen-x",
    });
    expect(settings.modelCatalog.defaultModelId).toBe("qwen-x");
    expect(defaultModelOf(settings.modelCatalog)?.reasoning).toBe(false);
  });

  it.each([
    [undefined, "m1", true],
    ["m2", "m2", false],
    ["m3", "m3", true],
  ])(
    "MODEL_CATALOG 三模型、MODEL_ID=%j：缺省模型 %s，推理 %s",
    (modelId, expectedId, reasoning) => {
      const settings = resolveAgentSettings({ [KEY]: THREE_MODELS, MODEL_ID: modelId }, root);
      expect(settings.modelCatalog).toStrictEqual({
        models: THREE_MODELS_PARSED,
        defaultModelId: expectedId,
      });
      expect(settings.modelCatalog.defaultModelId).toBe(expectedId);
      expect(defaultModelOf(settings.modelCatalog)?.reasoning).toBe(reasoning);
    },
  );

  it("非法白名单经 resolveAgentSettings 同样失败并点名键", () => {
    expect(() => resolveAgentSettings({ [KEY]: "[]" }, root)).toThrow(/MODEL_CATALOG/u);
    expect(() => resolveAgentSettings({ [KEY]: THREE_MODELS, MODEL_ID: "other" }, root)).toThrow(
      /MODEL_ID/u,
    );
    expect(() =>
      resolveAgentSettings({ [KEY]: THREE_MODELS, MODEL_REASONING: "on" }, root),
    ).toThrow(/MODEL_REASONING/u);
  });
});

/**
 * Issue #988（S1g 任务 2.3）：session-composer-settings「有效值解析」。
 * 期望值逐条取自该条文与「夹取与回落」场景，不经被测函数或源码常量算出。
 */
type Mode = ApprovalMode | null;
type Raw = Parameters<typeof effectiveComposer>[0];
type Config = Parameters<typeof effectiveComposer>[1];

function catalogOf(defaultModelId: string, models = THREE_MODELS_PARSED): ModelCatalog {
  return { models, defaultModelId };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe("有效值解析 — 夹取与回落", () => {
  it("档位次序常量：always-ask < write < yolo", () => {
    expect(APPROVAL_MODES).toStrictEqual(["always-ask", "write", "yolo"]);
  });

  // 场景原文的七组：(原始档位, 原始模型, 原始强度) / 最高档 → {档位, 模型, 强度}
  it.each<[Mode, string | null, Effort | null, ApprovalMode, ApprovalMode, string, Effort | null]>([
    [null, null, null, "yolo", "write", "m1", "high"],
    ["yolo", "m3", "xhigh", "write", "write", "m3", "xhigh"],
    ["write", "gone", "medium", "yolo", "write", "m1", "medium"],
    ["always-ask", "m2", "high", "yolo", "always-ask", "m2", null],
    ["write", "m3", "low", "always-ask", "always-ask", "m3", "low"],
    ["yolo", "m1", "max", "yolo", "yolo", "m1", "max"],
    [null, "m3", null, "yolo", "write", "m3", "high"],
  ])(
    "(%j,%j,%j) / %s → {%s,%s,%j}",
    (approvalMode, modelId, reasoningEffort, approvalMaxMode, mode, model, effort) => {
      expect(
        effectiveComposer(
          { approvalMode, modelId, reasoningEffort },
          { approvalMaxMode, modelCatalog: catalogOf("m1") },
        ),
      ).toStrictEqual({ approvalMode: mode, modelId: model, reasoningEffort: effort });
    },
  );

  it("入参深冻结：求值不抛，入参不变（函数不产生任何写入）", () => {
    const raw: Raw = { approvalMode: "yolo", modelId: "gone", reasoningEffort: null };
    // 白名单取副本再冻结，不把文件级的共享样例冻住。
    const config: Config = {
      approvalMaxMode: "write",
      modelCatalog: catalogOf("m3", structuredClone(THREE_MODELS_PARSED)),
    };
    const rawBefore = structuredClone(raw);
    const configBefore = structuredClone(config);
    deepFreeze(raw);
    deepFreeze(config);
    expect(Object.isFrozen(config.modelCatalog.models[2]?.efforts)).toBe(true);
    expect(effectiveComposer(raw, config)).toStrictEqual({
      approvalMode: "write",
      modelId: "m3",
      reasoningEffort: "high",
    });
    expect(raw).toStrictEqual(rawBefore);
    expect(config).toStrictEqual(configBefore);
  });

  it("调低最高档再调回：同一份 raw 的原始选择重新生效", () => {
    const raw: Raw = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "xhigh" };
    const open: Config = { approvalMaxMode: "yolo", modelCatalog: catalogOf("m1") };
    const lowered: Config = { ...open, approvalMaxMode: "always-ask" };
    const chosen = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "xhigh" };
    expect(effectiveComposer(raw, open)).toStrictEqual(chosen);
    expect(effectiveComposer(raw, lowered)).toStrictEqual({
      ...chosen,
      approvalMode: "always-ask",
    });
    expect(effectiveComposer(raw, open)).toStrictEqual(chosen);
  });

  it("从白名单移除模型再加回：原始模型与强度重新生效", () => {
    const raw: Raw = { approvalMode: "write", modelId: "m3", reasoningEffort: "low" };
    const full: Config = { approvalMaxMode: "yolo", modelCatalog: catalogOf("m2") };
    const removed: Config = {
      approvalMaxMode: "yolo",
      modelCatalog: catalogOf("m2", THREE_MODELS_PARSED.slice(0, 2)),
    };
    const chosen = { approvalMode: "write", modelId: "m3", reasoningEffort: "low" };
    expect(effectiveComposer(raw, full)).toStrictEqual(chosen);
    // 回落到的缺省模型 m2 不支持推理：存着的 low 不出现在有效值里。
    expect(effectiveComposer(raw, removed)).toStrictEqual({
      approvalMode: "write",
      modelId: "m2",
      reasoningEffort: null,
    });
    expect(effectiveComposer(raw, full)).toStrictEqual(chosen);
  });

  it("原始档位为 null 取 write，再受最高档 always-ask 夹取", () => {
    expect(
      effectiveComposer(
        { approvalMode: null, modelId: null, reasoningEffort: null },
        { approvalMaxMode: "always-ask", modelCatalog: catalogOf("m1") },
      ),
    ).toStrictEqual({ approvalMode: "always-ask", modelId: "m1", reasoningEffort: "high" });
  });

  it("原始档位低于最高档时不被抬高", () => {
    expect(
      effectiveComposer(
        { approvalMode: "always-ask", modelId: "m1", reasoningEffort: "off" },
        { approvalMaxMode: "write", modelCatalog: catalogOf("m1") },
      ),
    ).toStrictEqual({ approvalMode: "always-ask", modelId: "m1", reasoningEffort: "off" });
  });

  it("缺省模型取 defaultModelId，不是白名单第一项", () => {
    const config: Config = { approvalMaxMode: "yolo", modelCatalog: catalogOf("m3") };
    expect(
      effectiveComposer({ approvalMode: null, modelId: null, reasoningEffort: null }, config),
    ).toStrictEqual({ approvalMode: "write", modelId: "m3", reasoningEffort: "high" });
    expect(
      effectiveComposer({ approvalMode: null, modelId: "gone", reasoningEffort: "max" }, config),
    ).toStrictEqual({ approvalMode: "write", modelId: "m3", reasoningEffort: "max" });
  });

  it("手工构造的白名单里没有缺省模型（解析器不会产出）：报出 defaultModelId，强度为 null", () => {
    expect(
      effectiveComposer(
        { approvalMode: "yolo", modelId: "gone", reasoningEffort: "high" },
        { approvalMaxMode: "write", modelCatalog: catalogOf("absent") },
      ),
    ).toStrictEqual({ approvalMode: "write", modelId: "absent", reasoningEffort: null });
  });

  it("三项全 null 加旧式单模型配置：write、MODEL_ID、high（AgentSettings 直接当 config）", () => {
    const root = join(REPO_ROOT, "server");
    const raw: Raw = { approvalMode: null, modelId: null, reasoningEffort: null };
    expect(effectiveComposer(raw, resolveAgentSettings({}, root))).toStrictEqual({
      approvalMode: "write",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "high",
    });
    expect(
      effectiveComposer(
        raw,
        resolveAgentSettings({ MODEL_ID: "qwen-x", MODEL_REASONING: "off" }, root),
      ),
    ).toStrictEqual({ approvalMode: "write", modelId: "qwen-x", reasoningEffort: null });
  });
});
