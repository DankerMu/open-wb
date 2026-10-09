/**
 * Issue #1008 (s1g-composer-capabilities task 8.5): `GET /api/composer/options` —
 * session-composer-settings「输入框选项端点」(「缺省配置」「封顶、白名单与账号各自的缺省」). The compiled-entry half
 * (the four environment keys reaching the response) is in `server-startup-layout.test.ts`.
 *
 * The world of `session-composer-rest-helpers.ts`: production createApp → registerSessions, a real
 * in-memory SQLite, no omp child. Oracles: the spec's literals, written out here and in
 * `session-meta-fixtures.ts` — never the catalog functions the route calls. A last choice the cap
 * would refuse (`yolo` under `write`) or that left the catalog cannot be made over REST: its row is
 * planted by SQL.
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  expectBadRequest,
  getOptions,
  openWorld,
  plantPrefs,
  prefs,
} from "./session-composer-rest-helpers.js";
import { BAD_REQUEST_ENVELOPE, expectUnauthorizedEnvelope } from "./session-db-helpers.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";

/** What the three-model catalog of「有效值解析」 reads as under `APPROVAL_MAX_MODE=write`. */
const CAPPED = {
  approvalModes: ["always-ask", "write"],
  models: [
    {
      id: "m1",
      name: "M One",
      reasoning: true,
      vision: false,
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    },
    { id: "m2", name: "M Two", reasoning: false, vision: false, efforts: [], defaultEffort: null },
    {
      id: "m3",
      name: "M Three",
      reasoning: true,
      vision: true,
      efforts: ["off", "low", "high"],
      defaultEffort: "high",
    },
  ],
  upload: { maxBytes: 1048576, maxFiles: 3 },
};

function cappedWith(approvalMode: string, modelId: string, reasoningEffort: string | null) {
  return {
    approvalModes: CAPPED.approvalModes,
    models: CAPPED.models,
    defaults: { approvalMode, modelId, reasoningEffort },
    upload: CAPPED.upload,
  };
}

describe("输入框选项端点", () => {
  it("缺省配置：三档、单模型、缺省上传上限，从未选择的账号读成缺省有效值，带 no-store", async () => {
    const world = await openWorld(undefined, "default");

    const response = await getOptions(world, "zhangsan");

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(DEFAULT_COMPOSER_OPTIONS);
    // Byte for byte: the key order of the spec, and no key beyond it at any level.
    expect(response.payload).toBe(JSON.stringify(DEFAULT_COMPOSER_OPTIONS));
    expect(prefs(world)).toEqual([]);
  });

  it("封顶、白名单与账号各自的缺省：甲的最近选择被夹取，乙读成缺省，匿名 401", async () => {
    const world = await openWorld("write", "three", { maxBytes: 1048576, maxFiles: 3 });
    plantPrefs(world, "zhangsan", ["yolo", "m3", "low"]);
    const planted = prefs(world);

    const jia = await getOptions(world, "zhangsan");
    const yi = await getOptions(world, "zhaoliu");
    const anonymous = await getOptions(world);

    expect(jia.statusCode).toBe(200);
    expect(jia.json()).toEqual(cappedWith("write", "m3", "low"));
    expect(jia.payload).toBe(JSON.stringify(cappedWith("write", "m3", "low")));
    expect(yi.statusCode).toBe(200);
    expect(yi.json()).toEqual(cappedWith("write", "m1", "high"));
    expect(yi.headers["cache-control"]).toBe("no-store");
    expectUnauthorizedEnvelope(anonymous);
    expect(anonymous.headers["cache-control"]).toBe("no-store");
    // A read: the last choice keeps its raw `yolo`, and no row appears for the other account.
    expect(prefs(world)).toEqual(planted);
  });

  it.each([
    ["an always-ask cap lists one mode and clamps a null choice", "always-ask", [null, null, null]],
    ["a yolo cap lists all three and keeps a yolo choice", "yolo", ["yolo", null, null]],
  ] as const)("%s", async (_name, cap, choice) => {
    const world = await openWorld(cap);
    plantPrefs(world, "zhangsan", [...choice]);

    const body = (await getOptions(world, "zhangsan")).json() as {
      approvalModes: string[];
      defaults: unknown;
    };

    expect(body.approvalModes).toEqual(
      cap === "yolo" ? ["always-ask", "write", "yolo"] : ["always-ask"],
    );
    expect(body.defaults).toEqual({ approvalMode: cap, modelId: "m1", reasoningEffort: "high" });
  });

  it.each([
    // The stored effort is shown as it is, inside the model's `efforts` or not (omp clamps).
    ["an effort outside the model's efforts", ["write", "m3", "xhigh"], ["write", "m3", "xhigh"]],
    ["a model that left the catalog", ["write", "gone", "low"], ["write", "m1", "low"]],
    ["an effort on a model without reasoning", ["write", "m2", "low"], ["write", "m2", null]],
    ["only a model chosen", [null, "m3", null], ["write", "m3", "high"]],
  ] as const)(
    "the last choice is resolved to effective values: %s",
    async (_name, choice, [approvalMode, modelId, reasoningEffort]) => {
      const world = await openWorld("write", "three", { maxBytes: 1048576, maxFiles: 3 });
      plantPrefs(world, "zhaoliu", [...choice]);

      const response = await getOptions(world, "zhaoliu");

      expect(response.json()).toEqual(cappedWith(approvalMode, modelId, reasoningEffort));
    },
  );

  it.each(["?x=1", "?x", "?workspaceId=w1"])(
    "a query string is 400 for an account and still 401 without one: %s",
    async (query) => {
      const world = await openWorld();

      expectBadRequest(await getOptions(world, "zhangsan", query));
      expectUnauthorizedEnvelope(await getOptions(world, undefined, query));
    },
  );

  // `inject` drops a bare trailing `?` before the route sees the URL, so this one goes over HTTP.
  it("an empty query string is 400 too, over a real socket", async () => {
    const world = await openWorld();
    await world.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = world.app.server.address() as AddressInfo;

    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const outgoing = request(
          { host: "127.0.0.1", port, path: "/api/composer/options?", agent: false },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk: string) => {
              body += chunk;
            });
            incoming.on("end", () => {
              resolve({ status: incoming.statusCode, body });
            });
          },
        );
        outgoing.setHeader("cookie", world.cookies.zhangsan);
        outgoing.on("error", reject);
        outgoing.end();
      },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(BAD_REQUEST_ENVELOPE);
  });
});
