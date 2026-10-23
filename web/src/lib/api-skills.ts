import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { isStringArray } from "./api-experts.js";
import { hasExactlyKeys, parseJsonArray } from "./api-json.js";

/** `GET /api/skills` 的一项：平台技能的名称、描述与本账号是否缺省启用（skill-switches「技能清单与账号缺省」）。 */
type SkillView = {
  name: string;
  description: string;
  enabledByDefault: boolean;
};

/** `GET /api/skills` 的应答：`disabledSkills` 是账号缺省停用列表原样（含不在清单里的名称）。 */
export type SkillList = {
  skills: SkillView[];
  disabledSkills: string[];
};

type SkillTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
};

function parseSkillView(value: unknown): SkillView | null {
  if (!hasExactlyKeys(value, ["name", "description", "enabledByDefault"])) {
    return null;
  }
  const { name, description, enabledByDefault } = value;
  if (
    typeof name !== "string" ||
    name === "" ||
    typeof description !== "string" ||
    typeof enabledByDefault !== "boolean"
  ) {
    return null;
  }
  return { name, description, enabledByDefault };
}

function parseSkillList(value: unknown): SkillList | null {
  if (!hasExactlyKeys(value, ["skills", "disabledSkills"])) {
    return null;
  }
  const skills = parseJsonArray(value.skills, parseSkillView);
  const { disabledSkills } = value;
  return skills && isStringArray(disabledSkills) ? { skills, disabledSkills } : null;
}

export function createSkillMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, requestOptions, getRequestOptions, requestFailed }: SkillTransport,
): Pick<ApiClient, "listSkills" | "putSkillDefaults"> {
  /** 一次 200 请求加 `{skills, disabledSkills}` 严格解析（两个端点的应答同形）。 */
  async function list(path: string, init: RequestInit): Promise<SkillList> {
    const parsed = parseSkillList(await request(path, init, onUnauthorized, 200));
    if (!parsed) {
      throw requestFailed(200);
    }
    return parsed;
  }

  return {
    listSkills(options) {
      return list("/api/skills", getRequestOptions(options?.signal));
    },

    /** 整表替换账号缺省停用列表；应答与随后的 `GET /api/skills` 相同。 */
    putSkillDefaults(disabledSkills, options) {
      return list("/api/skills/defaults", {
        ...requestOptions(options?.signal),
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledSkills }),
      });
    },
  };
}
