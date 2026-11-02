/**
 * s2a-kb-ragflow tasks 8.2（#1844）：知识库模型设置的判定次序（ragflow-backend「知识库模型设置」，design D7）。未登录 401 →
 * 非管理员 403 → body 解析 400 → 取值规则 400 → `kb_chat_model_locked` → `kb_rebuilding` → `kb_rebuild_required`。每例让相邻
 * 两步同时成立，断言前一步胜出，且没有任何出站。
 */
import { describe, expect, it } from "vitest";
import {
  addCompileBase,
  BAD_REQUEST,
  bodyOf,
  chatWorld,
  configuredWorld,
  FORBIDDEN,
  LOCKED,
  useSettingsWorlds,
} from "./kb-settings-helpers.js";

const open = useSettingsWorlds();

describe("判定次序", () => {
  it("非管理员带坏 JSON 的 PUT：403 先于 400", async () => {
    const world = await open();
    const response = await world.raw(
      "PUT",
      "/api/kb/settings",
      '{"a":',
      "application/json",
      "member",
    );
    expect(response.statusCode).toBe(403);
    expect(bodyOf(response)).toEqual(FORBIDDEN);
    expect(world.fake.requests()).toEqual([]);
  });

  it.each([
    ["探活", "/api/kb/settings/probe"],
    ["重试重建", "/api/kb/settings/rebuild"],
  ])(
    "非管理员带 {} 的%s：403 先于 bodyless 的 400，假 RAGFlow 与嵌入上游都是零请求",
    async (_label, url) => {
      const world = await configuredWorld(open);
      const response = await world.raw("POST", url, "{}", "application/json", "member");
      expect(response.statusCode).toBe(403);
      expect(bodyOf(response)).toEqual(FORBIDDEN);
      expect(world.sent()).toEqual([]);
      expect(world.upstream.embeddings.requests()).toEqual([]);
    },
  );

  it("锁定时 chatModelId 不存在：400 先于 kb_chat_model_locked", async () => {
    const world = await chatWorld(open);
    addCompileBase(world, 1);
    const response = await world.put({ chatModelId: "missing" });
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.sent()).toEqual([]);
  });

  it("库处于 rebuilding 时同时换对话模型与嵌入身份：kb_chat_model_locked 先于 kb_rebuilding", async () => {
    const world = await chatWorld(open);
    world.addChatModel("m3");
    addCompileBase(world, 1, { state: "rebuilding" });
    const body = { embedding: { ...world.embedding, name: "bge-large" }, chatModelId: "m3" };
    expect(bodyOf(await world.put(body))).toEqual(LOCKED);
    expect(world.sent()).toEqual([]);
  });
});
