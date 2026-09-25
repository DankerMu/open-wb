import { scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import * as devStub from "../src/auth/providers/dev-stub.js";
import { openDb } from "../src/core/db/index.js";
import { SERVICE_INFO } from "../src/service-info.js";
import { withStandaloneAuthApp } from "./http-guard-helpers.js";

/**
 * `/api/info` 的 `auth.provider` 来源：registerAuth 在传入实例（根）上创建 provider 并
 * decorate 其 `name`，经 options 交给封装的 auth 子插件复用；route 只读 decorator。
 */

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth provider name is visible on the root instance", () => {
  it("createApp 装配后根实例带 authProviderName，值为 dev-stub", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db });
    try {
      await app.ready();
      expect(app.hasDecorator("authProviderName")).toBe(true);
      expect(app.authProviderName).toBe("dev-stub");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("裸 Fastify 上 registerAuth：decorate 落在传入实例而非封装子插件", async () => {
    await withStandaloneAuthApp(async ({ app }) => {
      await app.ready();
      expect(app.hasDecorator("authProviderName")).toBe(true);
      expect(app.authProviderName).toBe("dev-stub");
    });
  });
});

describe("auth provider name comes from the assembled provider", () => {
  it("provider 名换成 probe 值：info 跟随、只创建一次、登录不受影响", async () => {
    const db = openDb(":memory:");
    const source: devStub.PasswordSource = async (password, salt, keyLength, options) =>
      scryptSync(password, salt, keyLength, options);
    const real = devStub.createDevStubProvider;
    const spy = vi.spyOn(devStub, "createDevStubProvider").mockImplementation(
      (providerDb, passwordSource) =>
        ({
          ...real(providerDb, passwordSource),
          name: "probe-provider",
        }) as unknown as devStub.DevStubProvider,
    );
    const app = createApp({ db, passwordSource: source });
    try {
      const expected = { ...SERVICE_INFO, auth: { provider: "probe-provider" } };
      const info = await app.inject({ method: "GET", url: "/api/info" });
      expect(info.statusCode).toBe(200);
      expect(info.json()).toEqual(expected);
      expect(info.payload).toBe(JSON.stringify(expected));

      const head = await app.inject({ method: "HEAD", url: "/api/info" });
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-length"]).toBe(
        String(Buffer.byteLength(JSON.stringify(expected))),
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(db, source);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { account: "zhangsan", password: "demo" },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("static contracts for the provider name", () => {
  it("public.hurl 锚定三键 info body", () => {
    const expectedLine = JSON.stringify({ ...SERVICE_INFO, auth: { provider: "dev-stub" } });
    expect(readRepoFile("smoke/public.hurl").split("\n")).toContain(expectedLine);
  });

  it("app.ts 不硬编码 provider 名", () => {
    expect(readRepoFile("server/src/app.ts")).not.toContain('"dev-stub"');
  });

  it("authPlugin 不自行创建 provider", () => {
    const source = readRepoFile("server/src/auth/index.ts");
    const start = source.indexOf("async function authPlugin(");
    const end = source.indexOf("function parseLoginBody(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("createDevStubProvider(");
  });
});
