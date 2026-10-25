// 「连接器」tab 的纯函数（s1d-connectors 任务 6.3 的 `validate.ts`）：客户端校验的上限与边界（常量取自服务端
// `server/src/connectors/validate.ts`：描述 ≤200 码点、`command` ≤1024 UTF-8 字节且无 C0/DEL、`args` ≤32 项每项
// ≤1024 码点、`env` ≤32 键且键名 `^[A-Z_][A-Z0-9_]{0,63}$`、值 1–4096 码点、`headers` ≤32 项），整体替换 body 的
// 构造 `toUpdateInput(view, overrides)`（connectors「启用开关与空态」），参数的换行拆合与 `probesAfterSave`。

import { describe, expect, it } from "vitest";
import {
  argsOf,
  type ConnectorFormValues,
  initialValues,
  probesAfterSave,
  toUpdateInput,
  validateConnectorForm,
} from "../src/features/center/connectors/validate.js";
import { DOCS, DOCS_URL, GITLAB, GITLAB_COMMAND, WIKI_URL } from "./center-connectors-support.js";

function stdio(patch: Partial<ConnectorFormValues> = {}): ConnectorFormValues {
  return { ...initialValues(null), name: "gitlab", command: GITLAB_COMMAND, ...patch };
}

function http(patch: Partial<ConnectorFormValues> = {}): ConnectorFormValues {
  return { ...initialValues(null), name: "wiki", type: "http", url: WIKI_URL, ...patch };
}

const fresh = (key: string, value: string) => ({ key, value, existing: false });
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => fresh(`K${index}`, "v"));

describe("toUpdateInput", () => {
  it("规格例子：stdio gitlab 关闭启用 → 恰为 {description, command, args, env: {TOKEN: null}, enabled: false}", () => {
    expect(toUpdateInput(GITLAB, { enabled: false })).toStrictEqual({
      description: "代码库",
      command: GITLAB_COMMAND,
      args: ["--stdio"],
      env: { TOKEN: null },
      enabled: false,
    });
  });

  it("http：恰为 {description, url, headers: 每个已有键 null, enabled}；填了的键取新值、新键并入", () => {
    expect(toUpdateInput(DOCS, {})).toStrictEqual({
      description: "文档",
      url: DOCS_URL,
      headers: { authorization: null },
      enabled: false,
    });
    expect(
      toUpdateInput(DOCS, { url: WIKI_URL, entries: { authorization: "Bearer x", "x-a": "1" } }),
    ).toStrictEqual({
      description: "文档",
      url: WIKI_URL,
      headers: { authorization: "Bearer x", "x-a": "1" },
      enabled: false,
    });
  });
});

describe("argsOf", () => {
  it("空串为 []；否则按 \\n 精确拆分（不修剪、末尾换行得到一个空项）", () => {
    expect(argsOf("")).toStrictEqual([]);
    expect(argsOf("a\nb")).toStrictEqual(["a", "b"]);
    expect(argsOf(" a \n")).toStrictEqual([" a ", ""]);
  });
});

describe("validateConnectorForm 的边界", () => {
  it("合法的上限值不报：32 个字母的名称、200 码点描述、1024 字节命令、32 项参数、1024 码点参数、32 个变量、64 字符键名、4096 码点值、32 个请求头", () => {
    expect(
      validateConnectorForm(
        stdio({
          name: "a".repeat(32),
          description: "😀".repeat(200),
          command: `/${"字".repeat(341)}`,
          args: Array(32).fill("z".repeat(1024)).join("\n"),
          env: [...many(31), fresh(`_${"A".repeat(63)}`, "😀".repeat(4096))],
        }),
        null,
      ),
    ).toStrictEqual({});
    expect(validateConnectorForm(http({ headers: many(32) }), null)).toStrictEqual({});
  });

  it.each<[string, ConnectorFormValues, Record<string, string>]>([
    [
      "201 码点描述",
      stdio({ description: "😀".repeat(201) }),
      { description: "描述不能超过 200 个字符" },
    ],
    ["含控制字符的命令", stdio({ command: "/bin/a\u0007" }), { command: "命令不能含控制字符" }],
    ["含 DEL 的命令", stdio({ command: "/bin/a\u007f" }), { command: "命令不能含控制字符" }],
    ["33 个变量", stdio({ env: many(33) }), { env: "环境变量至多 32 个" }],
    [
      "65 字符键名",
      stdio({ env: [fresh(`A${"B".repeat(64)}`, "v")] }),
      { env: "变量名需为大写字母、数字或下划线（不以数字开头，至多 64 个字符）" },
    ],
    [
      "数字开头的键名",
      stdio({ env: [fresh("1A", "v")] }),
      { env: "变量名需为大写字母、数字或下划线（不以数字开头，至多 64 个字符）" },
    ],
    [
      "4097 码点的值",
      stdio({ env: [fresh("A", "x".repeat(4097))] }),
      { env: "变量值需为 1–4096 个字符" },
    ],
    ["重复的变量名", stdio({ env: [fresh("A", "1"), fresh("A", "2")] }), { env: "变量名重复" }],
    ["33 个请求头", http({ headers: many(33) }), { headers: "请求头至多 32 个" }],
    [
      "重复的请求头名",
      http({ headers: [fresh("x", "1"), fresh("x", "2")] }),
      { headers: "请求头名重复" },
    ],
    [
      "带 # 的地址",
      http({ url: "https://wiki.example/#a" }),
      { url: "地址需以 http:// 或 https:// 开头，且不含空白、# 或 @" },
    ],
  ])("%s", (_label, values, errors) => {
    expect(validateConnectorForm(values, null)).toStrictEqual(errors);
  });

  it("编辑：名称只读不校验；已有键留空（保留现有值）不报，新键留空报", () => {
    const opened = { ...GITLAB, name: "gitlab" };
    const values = { ...initialValues(opened), name: "NOT-CHECKED" };
    expect(values.env).toStrictEqual([{ key: "TOKEN", value: "", existing: true }]);
    expect(validateConnectorForm(values, opened)).toStrictEqual({});
    expect(
      validateConnectorForm({ ...values, env: [...values.env, fresh("B", "")] }, opened),
    ).toStrictEqual({ env: "变量值需为 1–4096 个字符" });
  });
});

describe("probesAfterSave", () => {
  const values = initialValues(DOCS);
  it.each<[string, boolean, Parameters<typeof probesAfterSave>]>([
    ["新增 http", true, [DOCS, null, http()]],
    ["新增 stdio", false, [GITLAB, null, stdio()]],
    [
      "编辑 stdio 填了凭证",
      false,
      [
        GITLAB,
        GITLAB,
        { ...initialValues(GITLAB), env: [{ key: "TOKEN", value: "x", existing: true }] },
      ],
    ],
    ["编辑 http 只改描述", false, [DOCS, DOCS, { ...values, description: "x" }]],
    ["编辑 http 改了地址", true, [{ ...DOCS, url: WIKI_URL }, DOCS, { ...values, url: WIKI_URL }]],
    [
      "编辑 http 填了请求头",
      true,
      [DOCS, DOCS, { ...values, headers: [{ key: "authorization", value: "y", existing: true }] }],
    ],
    [
      "编辑 http 加了请求头",
      true,
      [DOCS, DOCS, { ...values, headers: [...values.headers, fresh("x", "1")] }],
    ],
  ])("%s → %s", (_label, expected, args) => {
    expect(probesAfterSave(...args)).toBe(expected);
  });
});
