/**
 * s2c-kb-visibility 组 5（#2031）：`BaseView` 的 `owned`、`owner`、`scope` 三键的严格解析。接缝：真实的 `createApiClient`
 * 加替身 `fetch`。
 *
 * 期望值抄自 knowledge-bases「知识库端点」与 design D4：`owned` 是布尔；`owner` 恰 `{id, account, department}`，`department`
 * 可为 `null`；`scope` 恰 `{scope, group}`，`scope` 是四档之一，`group` 为 `{id, name}` 或 `null`。「`scope` 为 group 当且仅当
 * `group` 非空」不在 web 侧校验（服务端 CHECK 是权威，tasks.md「组 5 约定」）。外层键集与 `owned` 的类型不符在 `api-kb.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BaseView, createApiClient } from "../src/lib/api.js";
import { base } from "./center-kb-support.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

type Case = [name: string, value: unknown];

const U1 = { id: "u1", account: "zhangsan", department: "平台研发部" };
const G1 = { scope: "group", group: { id: "g1", name: "内网落地专项" } } as const;

const ACCEPTED: Array<[string, BaseView]> = [
  ["自有、仅自己可见", base("k1")],
  [
    "非自有、所有者没有部门、项目组可见",
    base("k2", {
      owned: false,
      owner: { id: "u2", account: "zhaoliu", department: null },
      scope: G1,
    }),
  ],
  ["本部门可见", base("k3", { scope: { scope: "dept", group: null } })],
  ["全员可见", base("k4", { owned: false, scope: { scope: "all", group: null } })],
];

const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const OWNER_REJECTED: Case[] = [
  ["多一键", { ...U1, extra: 1 }],
  ["缺 id", without(U1, "id")],
  ["缺 account", without(U1, "account")],
  ["缺 department", without(U1, "department")],
  ["id 为 1", { ...U1, id: 1 }],
  ["id 为 null", { ...U1, id: null }],
  ["account 为 1", { ...U1, account: 1 }],
  ["account 为 null", { ...U1, account: null }],
  ["department 为 1", { ...U1, department: 1 }],
  ["department 为 true", { ...U1, department: true }],
  ["department 为 {}", { ...U1, department: {} }],
];

const SCOPE_REJECTED: Case[] = [
  ["多一键", { ...G1, extra: 1 }],
  ["缺 scope", without(G1, "scope")],
  ["缺 group", without(G1, "group")],
  ...["team", "", "ME", null, 1].map(
    (scope): Case => [`scope 为 ${JSON.stringify(scope)}`, { scope, group: null }],
  ),
  ...["g1", 1, []].map((group): Case => [`group 为 ${JSON.stringify(group)}`, { ...G1, group }]),
  ["group 多一键", { ...G1, group: { ...G1.group, extra: 1 } }],
  ["group 缺 id", { ...G1, group: without(G1.group, "id") }],
  ["group 缺 name", { ...G1, group: without(G1.group, "name") }],
  ["group.id 为 1", { ...G1, group: { ...G1.group, id: 1 } }],
  ["group.id 为 null", { ...G1, group: { ...G1.group, id: null } }],
  ["group.name 为 1", { ...G1, group: { ...G1.group, name: 1 } }],
  ["group.name 为 null", { ...G1, group: { ...G1.group, name: null } }],
];

function stub(body: unknown, status: number) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status)));
}

const listOne = (view: unknown) => {
  stub({ bases: [view] }, 200);
  return createApiClient().listKnowledgeBases();
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listKnowledgeBases 的 owned、owner、scope", () => {
  it.each(ACCEPTED)("合规即原样通过：%s", async (_name, view) => {
    await expect(listOne(view)).resolves.toStrictEqual([view]);
  });

  it("四档与自有、非自有混在一个列表里照常通过", async () => {
    const views = ACCEPTED.map(([, view]) => view);
    stub({ bases: views }, 200);

    await expect(createApiClient().listKnowledgeBases()).resolves.toStrictEqual(views);
  });

  it.each(OWNER_REJECTED)("owner 不合规为 request_failed：%s", async (_name, owner) => {
    expectRequestFailure(await captureApiError(listOne({ ...base("k1"), owner })), 200);
  });

  it.each(SCOPE_REJECTED)("scope 不合规为 request_failed：%s", async (_name, scope) => {
    expectRequestFailure(await captureApiError(listOne({ ...base("k1"), scope })), 200);
  });
});

describe("createKnowledgeBase 的 owned、owner、scope", () => {
  const create = () => createApiClient().createKnowledgeBase({ name: "k1", template: "naive" });

  it("201 自有库通过", async () => {
    const view = base("k1");
    stub(view, 201);

    await expect(create()).resolves.toStrictEqual(view);
  });

  it("201 的 owner 多一键为 request_failed", async () => {
    stub({ ...base("k1"), owner: { ...U1, extra: 1 } }, 201);

    expectRequestFailure(await captureApiError(create()), 201);
  });
});
