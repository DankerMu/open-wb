/**
 * skills/rest — 技能清单与账号缺省停用列表（s1d-experts-skills D6；skill-switches「技能清单与账号缺省」）。
 * 两个端点：`GET /api/skills` 与 `PUT /api/skills/defaults`，都受 cookie guard（root preParsing，未认证 401
 * 先于 body 解析），全部应答 `Cache-Control: no-store`。
 *
 * 清单：托管 `<agentDir>/skills` 的平台技能，与 `GET /api/commands` 同一读取函数与次序（`listSkills`），
 * 再滤掉不合技能名规则的名称（`isSkillName`，规则只有 `skills/store.ts` 一处实现）——它们无法被停用，照常由
 * omp 加载。`disabledSkills` 是账号缺省停用列表原样，含不在清单里的名称（客户端据它整表 `PUT`）。
 *
 * `PUT` 在 content-parser 归属集，body limit 64 KiB（128 个至多 128 字节的名称按 JSON 转义最坏约 33 KB）；
 * 键集严格为 `{disabledSkills}`；128 项上限按去重前的原始项数；整体替换。不审计。账号缺省只决定之后新建
 * 会话的初值，这里不碰任何会话。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { listSkills } from "../sessions/slash-commands.js";
import {
  isSkillName,
  MAX_DISABLED_SKILLS,
  readAccountDisabledSkills,
  saveAccountDisabledSkills,
} from "./store.js";

export interface SkillRestDependencies {
  db: DatabaseSync;
  /** omp 的 agent 目录（`ompAgentDir(stateDir)`）；平台技能在其下的 `skills/`。 */
  agentDir: string;
}

const SKILLS_BODY_LIMIT = 64 * 1024;
const BODY_KEY = "disabledSkills";

const noStore: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/** root guard 已认证；这里的 null 分支只为类型收窄。 */
function principalOf(request: FastifyRequest): { readonly id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/** 键集恰为 `{disabledSkills}` 的普通 JSON 对象，列表至多 128 项（原始项数）；名称规则归 store。 */
function disabledSkillsOf(body: unknown): unknown[] {
  if (
    typeof body !== "object" ||
    body === null ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new HttpError("bad_request");
  }
  const keys = Object.keys(body);
  const list = (body as Record<string, unknown>)[BODY_KEY];
  if (
    keys.length !== 1 ||
    keys[0] !== BODY_KEY ||
    !Array.isArray(list) ||
    list.length > MAX_DISABLED_SKILLS
  ) {
    throw new HttpError("bad_request");
  }
  return list;
}

export function registerSkills(app: FastifyInstance, dependencies: SkillRestDependencies): void {
  const { db, agentDir } = dependencies;

  const view = (accountId: string) => {
    const disabledSkills = readAccountDisabledSkills(db, accountId);
    const disabled = new Set(disabledSkills);
    const skills = listSkills(agentDir)
      .filter((skill) => isSkillName(skill.name))
      .map(({ name, description }) => ({
        name,
        description,
        enabledByDefault: !disabled.has(name),
      }));
    return { skills, disabledSkills };
  };

  app.get("/api/skills", { onRequest: noStore }, async (request) => view(principalOf(request).id));

  app.put(
    "/api/skills/defaults",
    { onRequest: noStore, bodyLimit: SKILLS_BODY_LIMIT },
    async (request) => {
      const accountId = principalOf(request).id;
      // Not yet strings: `saveAccountDisabledSkills` runs every element through the name rule first.
      saveAccountDisabledSkills(db, accountId, disabledSkillsOf(request.body) as string[]);
      return view(accountId);
    },
  );
}
