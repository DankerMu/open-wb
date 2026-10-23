/**
 * s1d-experts-skills 任务 8.2：`web/src/lib/api-skills.ts` 的 `putSkillDefaults`（skill-switches「技能清单与账号
 * 缺省」「中心「技能」tab」）。接缝：真实的 `createApiClient` 加替身 `fetch`。期望值来自规格与服务端：
 * `PUT /api/skills/defaults`、body 键集恰为 `{disabledSkills}`（`server/src/skills/rest.ts` 的 `disabledSkillsOf`）、
 * 200 应答与 `GET /api/skills` 同形 `{skills: [{name, description, enabledByDefault}], disabledSkills}`（`view`）。
 * `listSkills` 的用例在 `api-experts.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { captureApiError, createFetchMock, expectRequestFailure, jsonResponse } from "./support.js";

const PATH = "/api/skills/defaults";
const LIST = {
  skills: [
    { name: "deploy", description: "部署到生产环境", enabledByDefault: false },
    { name: "weekly-report", description: "", enabledByDefault: true },
  ],
  disabledSkills: ["deploy", "ghost"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("putSkillDefaults", () => {
  it("PUTs exactly {disabledSkills} as JSON to /api/skills/defaults and returns the list as given", async () => {
    const fetchMock = stub({ [PATH]: () => jsonResponse(LIST) });

    await expect(createApiClient().putSkillDefaults(["deploy", "ghost"])).resolves.toEqual(LIST);
    expect(fetchMock.mock.calls).toEqual([
      [
        PATH,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabledSkills: ["deploy", "ghost"] }),
        },
      ],
    ]);
  });

  it("sends an empty list and accepts an empty answer", async () => {
    const empty = { skills: [], disabledSkills: [] };
    const fetchMock = stub({ [PATH]: () => jsonResponse(empty) });

    await expect(createApiClient().putSkillDefaults([])).resolves.toEqual(empty);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: '{"disabledSkills":[]}' });
  });

  const [deploy] = LIST.skills;
  it.each([
    ["an extra top-level key", { ...LIST, total: 2 }],
    ["no disabledSkills", { skills: LIST.skills }],
    ["no skills", { disabledSkills: LIST.disabledSkills }],
    ["a non-array skills", { ...LIST, skills: deploy }],
    ["a numeric disabled name", { ...LIST, disabledSkills: [1] }],
    ["a skill with an extra key", { ...LIST, skills: [{ ...deploy, source: "skill" }] }],
    [
      "a skill without enabledByDefault",
      { ...LIST, skills: [{ name: "deploy", description: "" }] },
    ],
    ["an empty skill name", { ...LIST, skills: [{ ...deploy, name: "" }] }],
    ["a null description", { ...LIST, skills: [{ ...deploy, description: null }] }],
    ["a string enabledByDefault", { ...LIST, skills: [{ ...deploy, enabledByDefault: "false" }] }],
  ])("an answer with %s is request_failed", async (_label, body) => {
    stub({ [PATH]: () => jsonResponse(body) });

    expectRequestFailure(
      await captureApiError(createApiClient().putSkillDefaults(["deploy"])),
      200,
    );
  });

  it("answered 204 is request_failed", async () => {
    stub({ [PATH]: () => new Response(null, { status: 204 }) });

    expectRequestFailure(await captureApiError(createApiClient().putSkillDefaults([])), 204);
  });

  it("an error envelope keeps status, code and message", async () => {
    const bad = { code: "bad_request", message: "请求格式不正确" };
    stub({ [PATH]: () => jsonResponse({ error: bad }, 400) });

    expect(await captureApiError(createApiClient().putSkillDefaults(["a,b"]))).toMatchObject({
      status: 400,
      ...bad,
    });
  });
});
