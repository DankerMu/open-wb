/**
 * Issue #991（S1g 任务 20.1）：模型代理白名单的顶层 `model` 判定（纯函数）。
 * 期望值取自 model-proxy「透传端点与 bearer 鉴权」的 Model whitelist 条文与两个场景，以及 design D18；
 * 交叉核对一节以 `JSON.parse` / `Object.keys` 为独立来源。
 * 含反斜杠的 body 一律用 `String.raw` 书写：TS 字符串字面量会先把 `\u0065`、`\\` 解码掉，那样测不到转义。
 */
import { describe, expect, it } from "vitest";
import { isAllowedModel, topLevelModel } from "../src/model-proxy/model-guard.js";

const ALLOWED: ReadonlySet<string> = new Set(["m1", "m3"]);

function verdict(raw: string): boolean {
  return isAllowedModel(JSON.parse(raw), raw, ALLOWED);
}

/** 规格里每个 body 各发两次：带 `"stream":true` 与不带。带的那份只对顶层对象有意义。 */
function withStream(raw: string): string {
  return raw === "{}" ? '{"stream":true}' : raw.replace(/\}$/, ',"stream":true}');
}

describe("Scenario: Model outside the whitelist is refused（十二个 body）", () => {
  const REFUSED: readonly (readonly [string, string, string])[] = [
    ["不在白名单", '{"model":"m2","messages":[]}', "unique"],
    ["大小写不同", '{"model":"M1","messages":[]}', "unique"],
    ["前导空格", '{"model":" m1","messages":[]}', "unique"],
    ["缺 model", '{"messages":[]}', "no-model"],
    ["model 是数字", '{"model":1}', "unique"],
    ["model 是 null", '{"model":null}', "unique"],
    ["model 是数组", '{"model":["m1"]}', "unique"],
    ["顶层数组", '["m1"]', "not-object"],
    ["顶层字符串", '"m1"', "not-object"],
    ["重复键，白名单内的在前", '{"model":"m1","model":"other"}', "duplicate"],
    ["重复键，白名单内的在后", '{"model":"other","model":"m1"}', "duplicate"],
    ["重复键，其一用转义拼写", String.raw`{"model":"other","mod\u0065l":"m1"}`, "duplicate"],
  ];

  it("the table holds the twelve bodies and the escaped one really carries the escape", () => {
    expect(REFUSED).toHaveLength(12);
    expect(REFUSED[11]?.[1]).toContain("\\u0065");
  });

  it.each(REFUSED)("%s：%s → 拒绝（%s）", (_name, raw, kind) => {
    expect(topLevelModel(raw).kind).toBe(kind);
    expect(verdict(raw)).toBe(false);
  });

  it.each(REFUSED.filter(([, raw]) => raw.endsWith("}")))(
    '%s，带 "stream":true → 同样拒绝',
    (_name, raw, kind) => {
      const streamed = withStream(raw);
      expect(topLevelModel(streamed).kind).toBe(kind);
      expect(verdict(streamed)).toBe(false);
    },
  );
});

describe("Scenario: Whitelisted model is forwarded untouched（判定部分）", () => {
  const BODY = String.raw`{ "stream" : true, "metadata":{"model":"other"}, "mod\u0065l" : "m3", "messages":[{"role":"user","content":"你好"}] }`;
  const BODY_NO_STREAM = String.raw`{ "metadata":{"model":"other"}, "mod\u0065l" : "m3", "messages":[{"role":"user","content":"你好"}] }`;

  it.each([
    ["带 stream", BODY],
    ["不带 stream", BODY_NO_STREAM],
  ])("%s：转义键名、嵌套 model、不寻常的空白 → 放行", (_name, raw) => {
    expect(raw).toContain("\\u0065");
    expect(topLevelModel(raw)).toEqual({ kind: "unique", valueText: '"m3"' });
    expect(verdict(raw)).toBe(true);
  });

  it.each([
    ["m1", '{"model":"m1","messages":[]}'],
    ["m3", '{"messages":[],"model":"m3"}'],
    ["值用转义拼写，解码后在白名单内", String.raw`{"model":"\u006d1"}`],
  ])("白名单内的 %s → 放行", (_name, raw) => {
    expect(verdict(raw)).toBe(true);
  });
});

describe("topLevelModel 的四种结果", () => {
  const CASES: readonly (readonly [string, string, ReturnType<typeof topLevelModel>])[] = [
    // 不是对象
    ["顶层数组", '[{"model":"m1"}]', { kind: "not-object" }],
    ["顶层字符串，内容像对象", String.raw`"{\"model\":\"m1\"}"`, { kind: "not-object" }],
    ["顶层数字", "12.5e3", { kind: "not-object" }],
    ["顶层 null", "null", { kind: "not-object" }],
    ["顶层 true", " true ", { kind: "not-object" }],
    ["空白之后的顶层数组", "\r\n\t [ ] ", { kind: "not-object" }],
    // 没有 model
    ["空对象", "{}", { kind: "no-model" }],
    ["带空白的空对象", " \t\r\n{ \t\r\n} \t\r\n", { kind: "no-model" }],
    ["键名大小写不同", '{"Model":"m1"}', { kind: "no-model" }],
    ["键名带前导空格", '{" model":"m1"}', { kind: "no-model" }],
    ["键名带尾随空格", '{"model ":"m1"}', { kind: "no-model" }],
    ["成员的值等于字符串 model", '{"a":"model"}', { kind: "no-model" }],
    ['值里含 "model": 字样', String.raw`{"a":"\"model\":\"m1\""}`, { kind: "no-model" }],
    [
      "键名含转义引号",
      String.raw`{"\"model\"":"m1","model\"":"m1","\"model":"m1"}`,
      { kind: "no-model" },
    ],
    ["只有嵌套对象里的 model", '{"a":{"model":"m1"},"b":[{"model":"m1"}]}', { kind: "no-model" }],
    ["键名是转义后的反斜杠加 model", String.raw`{"\\model":"m1"}`, { kind: "no-model" }],
    // 唯一
    ["最简", '{"model":"m1"}', { kind: "unique", valueText: '"m1"' }],
    [
      "成员的值等于字符串 model，另有 model 键",
      '{"a":"model","model":"m1"}',
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "键名以转义反斜杠结尾",
      String.raw`{"a\\":"x","model":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "值以转义反斜杠结尾",
      String.raw`{"a":"x\\","model":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "转义反斜杠后跟转义引号",
      String.raw`{"a":"x\\\",\"model\":\"m2\"","model":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    ["字符串里的花括号", '{"a":"}{","model":"m1"}', { kind: "unique", valueText: '"m1"' }],
    [
      "字符串里的方括号、冒号与逗号",
      '{"a":"],[:,","b":["}",{"c":"]"}],"model":"m1"}',
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      '值里含 "model": 字样，另有 model 键',
      String.raw`{"a":"\"model\":\"m2\",","model":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "键名含转义引号，另有 model 键",
      String.raw`{"\"model\"":"m2","model":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "嵌套的 model 不算",
      '{"x":{"model":"m2","y":{"model":"m2"}},"model":"m1","z":[{"model":"m2"}]}',
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "键名整个用 \\u 转义",
      String.raw`{"\u006d\u006f\u0064\u0065\u006c":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    [
      "键名用大写十六进制转义",
      String.raw`{"\u006Dodel":"m1"}`,
      { kind: "unique", valueText: '"m1"' },
    ],
    ["值是数字", '{"model":-1.5e+3,"a":1}', { kind: "unique", valueText: "-1.5e+3" }],
    ["值是数字，紧跟右花括号", '{"model":0}', { kind: "unique", valueText: "0" }],
    ["值是 null", '{"model":null}', { kind: "unique", valueText: "null" }],
    ["值是 true，后跟空白", '{"model":true\r\n}', { kind: "unique", valueText: "true" }],
    [
      "值是对象",
      '{"model":{"model":"m1","a":"}"},"b":1}',
      { kind: "unique", valueText: '{"model":"m1","a":"}"}' },
    ],
    ["值是数组", '{"model":["m1",["]"]],"b":1}', { kind: "unique", valueText: '["m1",["]"]]' }],
    [
      "值文本保留原始转义",
      String.raw`{"model":"\u006d1\\"}`,
      { kind: "unique", valueText: String.raw`"\u006d1\\"` },
    ],
    [
      "值文本不含两侧空白",
      '\n{\t"model"\r\n:\t "m1" \r\n,"a" : [ 1 , 2 ]\n}\n',
      { kind: "unique", valueText: '"m1"' },
    ],
    // 多于一个
    ["相邻的两个", '{"model":"m1","model":"m1"}', { kind: "duplicate" }],
    ["隔着别的成员", '{"model":"m1","a":{"b":[1,"}"]},"model":"m1"}', { kind: "duplicate" }],
    ["三个", '{"model":"m1","model":"m1","model":"m1"}', { kind: "duplicate" }],
    ["两个都用转义拼写", String.raw`{"\u006dodel":"m1","mode\u006c":"m1"}`, { kind: "duplicate" }],
    ["第二个的值不是字符串", '{"model":"m1","model":null}', { kind: "duplicate" }],
    ["带空白的重复", '{ "model" : "m1" ,\r\n\t"model" : "m1" }', { kind: "duplicate" }],
    [
      "转义反斜杠结尾的字符串之后的重复",
      String.raw`{"model":"m1","a":"\\","model":"m1"}`,
      { kind: "duplicate" },
    ],
  ];

  it.each(CASES)("%s：%s", (_name, raw, expected) => {
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect(topLevelModel(raw)).toEqual(expected);
  });
});

describe("isAllowedModel 的判定", () => {
  it.each([
    ["重复键，两个都在白名单内", '{"model":"m1","model":"m3"}'],
    ["重复键，同一个值", '{"model":"m1","model":"m1"}'],
    ["重复键，白名单内的在前、另一个用转义拼写", String.raw`{"mod\u0065l":"m1","model":"other"}`],
    ["重复键，白名单内的在后、另一个用转义拼写", String.raw`{"mod\u0065l":"other","model":"m1"}`],
    ["重复键，后一个不是字符串", '{"model":"m1","model":1}'],
    [
      "重复键，藏在以转义反斜杠结尾的字符串之后",
      String.raw`{"model":"other","a":"\\","model":"m1"}`,
    ],
    ["重复键，藏在含花括号的字符串之后", '{"model":"other","a":"}{","model":"m1"}'],
    ["model 是数字", '{"model":1}'],
    ["model 是 null", '{"model":null}'],
    ["model 是 true", '{"model":true}'],
    ["model 是对象", '{"model":{"model":"m1"}}'],
    ["model 是数组", '{"model":["m1"]}'],
    ["键名大小写不同", '{"Model":"m1"}'],
    ["键名带前导空格", '{" model":"m1"}'],
    ["只在嵌套对象里", '{"metadata":{"model":"m1"}}'],
    ["只在字符串值里", String.raw`{"a":"\"model\":\"m1\""}`],
    ["空对象", "{}"],
    ["值大小写不同", '{"model":"M3"}'],
    ["值带尾随空格", '{"model":"m1 "}'],
    ["值带尾随换行转义", String.raw`{"model":"m1\n"}`],
    ["空字符串", '{"model":""}'],
    ["全角字符（不做 Unicode 归一）", '{"model":"ｍ1"}'],
    ["顶层数组", '[{"model":"m1"}]'],
    ["顶层字符串", '"m1"'],
    ["顶层数字", "1"],
    ["顶层 null", "null"],
    ["顶层 false", "false"],
  ])("%s → 拒绝", (_name, raw) => {
    expect(verdict(raw)).toBe(false);
  });

  it.each([
    ["值等于字符串 model 的成员在前", '{"a":"model","model":"m1"}'],
    ["键名以转义反斜杠结尾", String.raw`{"a\\":"x","model":"m1"}`],
    ["值以转义反斜杠结尾", String.raw`{"a":"x\\","model":"m1"}`],
    ["字符串里的花括号", '{"a":"}{","model":"m1"}'],
    ['值里含 "model": 字样', String.raw`{"a":"\"model\":\"other\",","model":"m1"}`],
    ["键名含转义引号", String.raw`{"\"model\"":"other","model":"m1"}`],
    ["嵌套的 model 在白名单外", '{"a":{"model":"other"},"b":[{"model":"other"}],"model":"m1"}'],
    [
      "四种空白包在每个记号两侧",
      ' \t\r\n{ \t\r\n"model" \t\r\n: \t\r\n"m3" \t\r\n, \t\r\n"a" \t\r\n: \t\r\n[ \t\r\n] \t\r\n} \t\r\n',
    ],
  ])("%s → 放行", (_name, raw) => {
    expect(verdict(raw)).toBe(true);
  });

  it("deep nesting: only the top-level member counts, however deep the others are", () => {
    const depth = 2000;
    const deep = `${'{"model":'.repeat(depth)}"other"${"}".repeat(depth)}`;
    const arrays = `${"[".repeat(depth)}{"model":"other"}${"]".repeat(depth)}`;
    const allowed = `{"a":${deep},"b":${arrays},"model":"m1"}`;
    expect(topLevelModel(allowed)).toEqual({ kind: "unique", valueText: '"m1"' });
    expect(verdict(allowed)).toBe(true);
    // 顶层的 model 是那个深层对象：值不是字符串
    expect(verdict(deep)).toBe(false);
    expect(topLevelModel(`{"a":${deep},"b":${arrays}}`)).toEqual({ kind: "no-model" });
    expect(topLevelModel(`{"model":"m1","a":${deep},"model":"m1"}`)).toEqual({ kind: "duplicate" });
  });

  it("parsed must itself be a plain object, whatever the raw text says", () => {
    const raw = '{"model":"m1"}';
    expect(isAllowedModel({ model: "m1" }, raw, ALLOWED)).toBe(true);
    expect(isAllowedModel(["m1"], raw, ALLOWED)).toBe(false);
    expect(isAllowedModel(null, raw, ALLOWED)).toBe(false);
    expect(isAllowedModel("m1", raw, ALLOWED)).toBe(false);
    expect(isAllowedModel(1, raw, ALLOWED)).toBe(false);
  });

  it("the raw text decides, not the parsed value", () => {
    expect(isAllowedModel({ model: "m1" }, '{"model":"other"}', ALLOWED)).toBe(false);
    expect(isAllowedModel({ model: "m1" }, '{"model":"other","model":"m1"}', ALLOWED)).toBe(false);
    expect(isAllowedModel({ model: "m1" }, '["m1"]', ALLOWED)).toBe(false);
  });

  it("a non-string model is refused even when its text or its value matches a whitelist entry", () => {
    const texts = new Set(["1", "null", "true", "m1", '["m1"]', "[object Object]"]);
    for (const raw of [
      '{"model":1}',
      '{"model":null}',
      '{"model":true}',
      '{"model":["m1"]}',
      '{"model":{}}',
    ]) {
      expect(isAllowedModel(JSON.parse(raw), raw, texts), raw).toBe(false);
    }
    // 类型上集合只装字符串；这里故意塞进非字符串，钉住「值必须是 JSON 字符串」这一条本身。
    const loose = new Set<unknown>([1, null, true]) as ReadonlySet<string>;
    for (const raw of ['{"model":1}', '{"model":null}', '{"model":true}']) {
      expect(isAllowedModel(JSON.parse(raw), raw, loose), raw).toBe(false);
    }
  });

  it("an empty whitelist allows nothing; membership is exact", () => {
    expect(isAllowedModel({ model: "m1" }, '{"model":"m1"}', new Set())).toBe(false);
    expect(isAllowedModel({ model: " m1" }, '{"model":" m1"}', new Set([" m1"]))).toBe(true);
    expect(isAllowedModel({ model: "m1" }, '{"model":"m1"}', new Set([" m1"]))).toBe(false);
  });
});

describe("交叉核对：扫描结果与 JSON.parse / Object.keys 一致", () => {
  const KEYS = [
    "model",
    "model",
    "model",
    "Model",
    " model",
    "model ",
    "MODEL",
    'mo"del',
    '"model"',
    "a\\",
    "\\",
    "model\\",
    "}{",
    "][",
    ":",
    ",",
    "",
    "模型",
    "😀",
    "a\nb",
    "\u2028",
    "messages",
    "stream",
  ];
  const STRINGS = [
    "m1",
    "model",
    '"model":',
    '"model":"m1",',
    "x\\",
    '\\"',
    "}{",
    "],[",
    "你好",
    "😀\ud83d",
    "\t\r\n ",
    "",
    "\u0000\u001f",
  ];
  const NUMBERS = [0, -0, 1, -1, 1e21, 1.5e-7, -2.5e300, 5e-324, 123456789.125, 4294967296];

  /** 确定性的线性同余发生器：同一个种子给出同一批文档。 */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function pick<T>(next: () => number, pool: readonly T[]): T {
    return pool[Math.floor(next() * pool.length)] as T;
  }

  function makeObject(next: () => number, depth: number): Record<string, unknown> {
    // 无原型对象：键 `__proto__` 之类也只是普通键。
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const size = Math.floor(next() * 5);
    for (let index = 0; index < size; index += 1) {
      result[pick(next, KEYS)] = makeValue(next, depth + 1);
    }
    return result;
  }

  function makeValue(next: () => number, depth: number): unknown {
    const roll = Math.floor(next() * (depth >= 4 ? 5 : 7));
    switch (roll) {
      case 0:
        return pick(next, STRINGS);
      case 1:
        return pick(next, NUMBERS);
      case 2:
        return null;
      case 3:
        return next() < 0.5;
      case 4:
        return pick(next, KEYS);
      case 5:
        return Array.from({ length: Math.floor(next() * 4) }, () => makeValue(next, depth + 1));
      default:
        return makeObject(next, depth);
    }
  }

  const next = generator(991);
  const DOCS = Array.from({ length: 300 }, () => makeObject(next, 0));
  const FORMATS: readonly (readonly [string, (doc: unknown) => string])[] = [
    ["紧凑", (doc) => JSON.stringify(doc)],
    ["制表符缩进", (doc) => JSON.stringify(doc, null, "\t")],
    ["CRLF 与空格", (doc) => ` \r\n${JSON.stringify(doc, null, 3).replaceAll("\n", "\r\n")}\r\n `],
  ];

  it("the generated set covers both outcomes and nested model members", () => {
    const withModel = DOCS.filter((doc) => Object.keys(doc).includes("model"));
    const nested = DOCS.filter((doc) => JSON.stringify(Object.values(doc)).includes('"model":'));
    expect(withModel.length).toBeGreaterThanOrEqual(30);
    expect(DOCS.length - withModel.length).toBeGreaterThanOrEqual(30);
    expect(nested.length).toBeGreaterThanOrEqual(30);
  });

  it.each(FORMATS)("%s：300 个生成文档逐个一致", (_name, format) => {
    for (const doc of DOCS) {
      const raw = format(doc);
      const result = topLevelModel(raw);
      if (Object.keys(doc).includes("model")) {
        expect(result.kind, raw).toBe("unique");
        const valueText = result.kind === "unique" ? result.valueText : "";
        expect(valueText, raw).toBe(valueText.trim());
        expect(JSON.parse(valueText), raw).toEqual(JSON.parse(JSON.stringify(doc.model)));
        expect(isAllowedModel(JSON.parse(raw), raw, new Set(["m1"])), raw).toBe(doc.model === "m1");
      } else {
        expect(result, raw).toEqual({ kind: "no-model" });
        expect(isAllowedModel(JSON.parse(raw), raw, new Set(["m1"])), raw).toBe(false);
      }
    }
  });

  it.each(FORMATS)("%s：生成文档包进数组或字符串后都不是对象", (_name, format) => {
    for (const doc of DOCS.slice(0, 40)) {
      expect(topLevelModel(format([doc]))).toEqual({ kind: "not-object" });
      expect(topLevelModel(JSON.stringify(format(doc)))).toEqual({ kind: "not-object" });
    }
  });
});
