/**
 * s1d-experts-skills 任务 7.2：`web/src/lib/api-experts.ts` 的四个方法与 `web/src/lib/api-skills.ts` 的
 * `listSkills`（experts「中心「专家」tab」的 API 客户端句；skill-switches「技能清单与账号缺省」）。接缝：真实的
 * `createApiClient` 加替身 `fetch`。期望值来自规格与服务端：路径与 `?id=` 的百分号编码（字面量）、各端点的状态码
 *（「专家管理端点」：list 200、create 201、update 200、delete 204）、`ExpertView` 恰八键（`server/src/experts/rest.ts`
 * 的 `toView`）、`GET /api/skills` 的 `{skills: [{name, description, enabledByDefault}], disabledSkills}`
 *（`server/src/skills/rest.ts` 的 `view`）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type ExpertInput, type ExpertView } from "../src/lib/api.js";
import { captureApiError, createFetchMock, expectRequestFailure, jsonResponse } from "./support.js";

const BUILTIN: ExpertView = {
  id: "builtin:frontend-architect",
  name: "前端架构师",
  description: "擅长组件架构与性能优化",
  category: "开发",
  tags: ["前端", "架构", "性能"],
  prompt: "你是一位前端架构师。",
  skills: [],
  builtin: true,
};

const OWN: ExpertView = {
  id: "0123456789abcdef0123456789abcdef",
  name: "周报助手",
  description: "",
  category: "办公",
  tags: ["周报"],
  prompt: "按条目整理本周进展。",
  skills: ["pdf", "xlsx"],
  builtin: false,
};

const INPUT: ExpertInput = {
  name: "周报助手",
  description: "",
  category: "办公",
  tags: ["周报"],
  prompt: "按条目整理本周进展。",
  skills: ["xlsx", "pdf"],
};

const ODD_ID = "a/b?c";
const ENCODED = "/api/experts?id=a%2Fb%3Fc";
const GET = { method: "GET", credentials: "same-origin", cache: "no-store" };
const JSON_HEADERS = { "Content-Type": "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("四个专家方法的请求与成功应答", () => {
  it("listExperts GETs /api/experts without a body and returns the views in order", async () => {
    const fetchMock = stub({ "/api/experts": () => jsonResponse({ experts: [BUILTIN, OWN] }) });

    await expect(createApiClient().listExperts()).resolves.toEqual([BUILTIN, OWN]);
    expect(fetchMock.mock.calls).toEqual([["/api/experts", GET]]);
  });

  it("createExpert POSTs exactly the six-key input as JSON and expects 201", async () => {
    const fetchMock = stub({ "/api/experts": () => jsonResponse(OWN, 201) });

    await expect(createApiClient().createExpert(INPUT)).resolves.toEqual(OWN);
    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/experts",
        {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(INPUT),
        },
      ],
    ]);
  });

  it("updateExpert PUTs to ?id=<encodeURIComponent(id)> with the JSON body and expects 200", async () => {
    const fetchMock = stub({ [ENCODED]: () => jsonResponse(OWN) });

    await expect(createApiClient().updateExpert(ODD_ID, INPUT)).resolves.toEqual(OWN);
    expect(fetchMock.mock.calls).toEqual([
      [
        ENCODED,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(INPUT),
        },
      ],
    ]);
  });

  it("deleteExpert sends DELETE to ?id=<encodeURIComponent(id)> without a body and resolves on 204", async () => {
    const fetchMock = stub({ [ENCODED]: () => new Response(null, { status: 204 }) });

    await expect(createApiClient().deleteExpert(ODD_ID)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toEqual([
      [ENCODED, { method: "DELETE", credentials: "same-origin" }],
    ]);
  });
});

describe("期望状态码与错误信封", () => {
  it.each([
    ["listExperts 201", () => createApiClient().listExperts(), "/api/experts", 201],
    ["createExpert 200", () => createApiClient().createExpert(INPUT), "/api/experts", 200],
    ["updateExpert 201", () => createApiClient().updateExpert(ODD_ID, INPUT), ENCODED, 201],
  ] as const)("%s with a valid body is request_failed", async (label, call, path, status) => {
    const body = label.startsWith("listExperts") ? { experts: [OWN] } : OWN;
    stub({ [path]: () => jsonResponse(body, status) });

    expectRequestFailure(await captureApiError(call()), status);
  });

  it("deleteExpert answered 200 is request_failed", async () => {
    stub({ [ENCODED]: () => jsonResponse({}, 200) });

    expectRequestFailure(await captureApiError(createApiClient().deleteExpert(ODD_ID)), 200);
  });

  it("an envelope keeps status, code and message", async () => {
    const forbidden = { code: "forbidden", message: "没有权限执行该操作" };
    const bad = { code: "bad_request", message: "请求格式不正确" };
    stub({
      "/api/experts?id=builtin%3Adata-analyst": () => jsonResponse({ error: forbidden }, 403),
      "/api/experts": () => jsonResponse({ error: bad }, 400),
    });

    expect(
      await captureApiError(createApiClient().deleteExpert("builtin:data-analyst")),
    ).toMatchObject({ status: 403, ...forbidden });
    expect(await captureApiError(createApiClient().createExpert(INPUT))).toMatchObject({
      status: 400,
      ...bad,
    });
  });
});

describe("ExpertView 严格解析", () => {
  const { builtin: _dropped, ...sevenKeys } = OWN;
  it.each([
    ["a missing key", sevenKeys],
    ["an extra key", { ...OWN, createdAt: 1 }],
    ["an empty id", { ...OWN, id: "" }],
    ["a numeric id", { ...OWN, id: 1 }],
    ["an empty name", { ...OWN, name: "" }],
    ["a null description", { ...OWN, description: null }],
    ["a category outside the four", { ...OWN, category: "运维" }],
    ["a non-array tags", { ...OWN, tags: "周报" }],
    ["a numeric tag", { ...OWN, tags: ["周报", 1] }],
    ["a non-string prompt", { ...OWN, prompt: 1 }],
    ["a non-array skills", { ...OWN, skills: null }],
    ["a numeric skill", { ...OWN, skills: [1] }],
    ["a string builtin", { ...OWN, builtin: "false" }],
  ])("a view with %s is request_failed on every method that returns one", async (_label, view) => {
    stub({
      "/api/experts": [jsonResponse({ experts: [BUILTIN, view] }), jsonResponse(view, 201)],
      [ENCODED]: () => jsonResponse(view),
    });
    const client = createApiClient();

    expectRequestFailure(await captureApiError(client.listExperts()), 200);
    expectRequestFailure(await captureApiError(client.createExpert(INPUT)), 201);
    expectRequestFailure(await captureApiError(client.updateExpert(ODD_ID, INPUT)), 200);
  });

  it.each([
    ["an extra key", { experts: [OWN], total: 1 }],
    ["no experts key", { items: [OWN] }],
    ["a non-array experts", { experts: OWN }],
  ])("a list body with %s is request_failed", async (_label, body) => {
    stub({ "/api/experts": () => jsonResponse(body) });

    expectRequestFailure(await captureApiError(createApiClient().listExperts()), 200);
  });

  it("accepts every category, an empty description and empty tags and skills", async () => {
    const views: ExpertView[] = (["开发", "办公", "设计", "产品"] as const).map((category, i) => ({
      ...OWN,
      id: `${i}`.repeat(32),
      category,
      description: "",
      tags: [],
      skills: [],
    }));
    stub({ "/api/experts": () => jsonResponse({ experts: views }) });

    await expect(createApiClient().listExperts()).resolves.toEqual(views);
  });
});

describe("listSkills", () => {
  const LIST = {
    skills: [
      { name: "pdf", description: "读写 PDF", enabledByDefault: true },
      { name: "xlsx", description: "", enabledByDefault: false },
    ],
    disabledSkills: ["xlsx", "retired"],
  };

  it("GETs /api/skills without a body and returns the list as given", async () => {
    const fetchMock = stub({ "/api/skills": () => jsonResponse(LIST) });

    await expect(createApiClient().listSkills()).resolves.toEqual(LIST);
    expect(fetchMock.mock.calls).toEqual([["/api/skills", GET]]);
  });

  it("accepts an empty list", async () => {
    const empty = { skills: [], disabledSkills: [] };
    stub({ "/api/skills": () => jsonResponse(empty) });

    await expect(createApiClient().listSkills()).resolves.toEqual(empty);
  });

  const [pdf] = LIST.skills;
  it.each([
    ["an extra top-level key", { ...LIST, total: 2 }],
    ["no disabledSkills", { skills: LIST.skills }],
    ["a non-array skills", { ...LIST, skills: pdf }],
    ["a numeric disabled name", { ...LIST, disabledSkills: [1] }],
    ["a skill with an extra key", { ...LIST, skills: [{ ...pdf, source: "skill" }] }],
    ["a skill without enabledByDefault", { ...LIST, skills: [{ name: "pdf", description: "" }] }],
    ["an empty skill name", { ...LIST, skills: [{ ...pdf, name: "" }] }],
    ["a null description", { ...LIST, skills: [{ ...pdf, description: null }] }],
    ["a string enabledByDefault", { ...LIST, skills: [{ ...pdf, enabledByDefault: "true" }] }],
  ])("a body with %s is request_failed", async (_label, body) => {
    stub({ "/api/skills": () => jsonResponse(body) });

    expectRequestFailure(await captureApiError(createApiClient().listSkills()), 200);
  });

  it("answered 201 is request_failed", async () => {
    stub({ "/api/skills": () => jsonResponse(LIST, 201) });

    expectRequestFailure(await captureApiError(createApiClient().listSkills()), 201);
  });
});
