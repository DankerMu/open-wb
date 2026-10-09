/**
 * Issue #1066：预览令牌登记表（preview-origin「预览令牌登记表」的三个场景），
 * 外加规格没有写、实施注记要求钉住的分支：键隔离、到期判定在 `issue` 一侧、随机数撞车。
 * 期望值取自规格字面量（900000 / 899999），不引用源码常量；除撞车用例外都用真实随机数。
 * 文件里不写令牌字面量：未知令牌一律由活令牌派生。
 */
import nodeCrypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewTokens, type PreviewTokens } from "../src/preview/tokens.js";

const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const T = 1_700_000_000_000;
const FIVE_MINUTES = 300_000;
const ORIGIN = "http://127.0.0.1:3000";
const OTHER_ORIGIN = "http://127.0.0.1:4000";

const U1_W1 = { ownerId: "u1", workspaceId: "w1", embedOrigin: ORIGIN };
const U1_W2 = { ownerId: "u1", workspaceId: "w2", embedOrigin: ORIGIN };
const U2_W1 = { ownerId: "u2", workspaceId: "w1", embedOrigin: ORIGIN };

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

/** 签发直到令牌里含字母：纯数字的令牌大写后不变，大小写用例就什么也没测。 */
function issueWithLetter(tokens: PreviewTokens): string {
  for (let workspace = 0; workspace < 64; workspace += 1) {
    const { token } = tokens.issue({ ...U1_W1, workspaceId: `letters-${workspace}` }, T);
    if (/[a-f]/u.test(token)) {
      return token;
    }
  }
  throw new Error("no issued token contained a letter");
}

describe("预览令牌登记表：签发、复用与续期", () => {
  it("同一账号同一空间未过期时复用同一个令牌并把到期推后；别的账号、别的空间各得不同的令牌", () => {
    const tokens = createPreviewTokens();

    const first = tokens.issue(U1_W1, T);
    expect(first.token).toMatch(LOWER_HEX_64);
    expect(first.expiresAt).toBe(T + 900_000);
    expect(Object.keys(first).sort()).toEqual(["expiresAt", "token"]);

    const second = tokens.issue(U1_W1, T + FIVE_MINUTES);
    expect(second.token).toBe(first.token);
    expect(second.expiresAt).toBe(T + FIVE_MINUTES + 900_000);

    const otherWorkspace = tokens.issue(U1_W2, T + FIVE_MINUTES);
    const otherOwner = tokens.issue(U2_W1, T + FIVE_MINUTES);
    expect(otherWorkspace.token).toMatch(LOWER_HEX_64);
    expect(otherOwner.token).toMatch(LOWER_HEX_64);
    expect(new Set([first.token, otherWorkspace.token, otherOwner.token]).size).toBe(3);

    expect(tokens.lookup(first.token, T + FIVE_MINUTES)).toStrictEqual(U1_W1);
    expect(tokens.lookup(otherWorkspace.token, T + FIVE_MINUTES)).toStrictEqual(U1_W2);
    expect(tokens.lookup(otherOwner.token, T + FIVE_MINUTES)).toStrictEqual(U2_W1);
  });

  it("续期推后的到期时间对查找生效：原到期时刻之后仍查得到，新到期时刻查不到", () => {
    const tokens = createPreviewTokens();
    const { token } = tokens.issue(U1_W1, T);
    tokens.issue(U1_W1, T + FIVE_MINUTES);

    expect(tokens.lookup(token, T + 900_000)).toStrictEqual(U1_W1);
    expect(tokens.lookup(token, T + FIVE_MINUTES + 899_999)).toStrictEqual(U1_W1);
    expect(tokens.lookup(token, T + FIVE_MINUTES + 900_000)).toBeNull();
  });

  it("再次签发把 embedOrigin 更新为本次的值，包括改成 null", () => {
    const tokens = createPreviewTokens();
    const { token } = tokens.issue(U1_W1, T);

    expect(tokens.issue({ ...U1_W1, embedOrigin: OTHER_ORIGIN }, T + 1).token).toBe(token);
    expect(tokens.lookup(token, T + 1)).toStrictEqual({ ...U1_W1, embedOrigin: OTHER_ORIGIN });

    expect(tokens.issue({ ...U1_W1, embedOrigin: null }, T + 2).token).toBe(token);
    expect(tokens.lookup(token, T + 2)).toStrictEqual({ ...U1_W1, embedOrigin: null });
  });

  it("账号与空间的 id 不经分隔符拼接：('a:b','c') 与 ('a','b:c') 是两个键", () => {
    const tokens = createPreviewTokens();
    const left = tokens.issue({ ownerId: "a:b", workspaceId: "c", embedOrigin: null }, T);
    const right = tokens.issue({ ownerId: "a", workspaceId: "b:c", embedOrigin: null }, T);

    expect(right.token).not.toBe(left.token);
    expect(tokens.lookup(left.token, T)).toStrictEqual({
      ownerId: "a:b",
      workspaceId: "c",
      embedOrigin: null,
    });
    expect(tokens.lookup(right.token, T)).toStrictEqual({
      ownerId: "a",
      workspaceId: "b:c",
      embedOrigin: null,
    });
  });

  it("两个登记表实例互不可见", () => {
    const one = createPreviewTokens();
    const other = createPreviewTokens();
    const issued = one.issue(U1_W1, T);

    expect(other.lookup(issued.token, T)).toBeNull();
    expect(other.issue(U1_W1, T).token).not.toBe(issued.token);
    expect(one.lookup(issued.token, T)).toStrictEqual(U1_W1);
  });

  it("随机数撞上已登记的令牌时失败关闭：抛出不含令牌的错误，既有记录不动", () => {
    const tokens = createPreviewTokens();
    const sizes: number[] = [];
    vi.spyOn(nodeCrypto, "randomBytes").mockImplementation((size: number) => {
      sizes.push(size);
      return Buffer.alloc(size, 0x5a);
    });
    syncBuiltinESMExports();

    const held = tokens.issue(U1_W1, T);
    let thrown: unknown;
    try {
      tokens.issue(U2_W1, T + 1);
    } catch (error) {
      thrown = error;
    }

    expect(sizes).toEqual([32, 32]);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(`${error.name}\n${error.message}\n${error.stack ?? ""}`).not.toContain(held.token);
    // 既有记录的三键与到期时间都没有被这次失败的签发改动。
    expect(tokens.lookup(held.token, T + 899_999)).toStrictEqual(U1_W1);
    expect(tokens.lookup(held.token, T + 900_000)).toBeNull();

    // 失败的那次没有留下半条记录：随机数恢复后该键照常得到自己的新令牌。
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const recovered = tokens.issue(U2_W1, T + 2);
    expect(recovered.token).not.toBe(held.token);
    expect(tokens.lookup(recovered.token, T + 2)).toStrictEqual(U2_W1);
  });
});

describe("预览令牌登记表：到期与查找不续期", () => {
  it("t + 899999 查得到、t + 900000 查不到；连续查找不推后到期；到期后再签发得到新令牌", () => {
    const tokens = createPreviewTokens();
    const issued = tokens.issue(U1_W1, T);

    // 反复查找之后，到期时刻仍是签发时定下的 t + 900000。
    expect(tokens.lookup(issued.token, T)).toStrictEqual(U1_W1);
    expect(tokens.lookup(issued.token, T + FIVE_MINUTES)).toStrictEqual(U1_W1);
    expect(tokens.lookup(issued.token, T + 899_999)).toStrictEqual(U1_W1);
    expect(tokens.lookup(issued.token, T + 900_000)).toBeNull();

    // 到期的记录已被清除：时钟回到有效期内也查不到。
    expect(tokens.lookup(issued.token, T + 1)).toBeNull();

    const reissued = tokens.issue(U1_W1, T + 900_001);
    expect(reissued.token).toMatch(LOWER_HEX_64);
    expect(reissued.token).not.toBe(issued.token);
    expect(reissued.expiresAt).toBe(T + 900_001 + 900_000);
    expect(tokens.lookup(issued.token, T + 900_001)).toBeNull();
    expect(tokens.lookup(reissued.token, T + 900_001)).toStrictEqual(U1_W1);
  });

  it("不经任何查找，恰在 t + 900000 再签发也按已过期生成新令牌，并删掉旧令牌的记录", () => {
    const tokens = createPreviewTokens();
    const issued = tokens.issue(U1_W1, T);

    const reissued = tokens.issue(U1_W1, T + 900_000);
    expect(reissued.token).toMatch(LOWER_HEX_64);
    expect(reissued.token).not.toBe(issued.token);
    expect(reissued.expiresAt).toBe(T + 900_000 + 900_000);

    // 旧令牌的记录是被删掉的，而不是留着等它自己过期：时钟回到它的有效期内也查不到。
    expect(tokens.lookup(issued.token, T + 1)).toBeNull();
    expect(tokens.lookup(reissued.token, T + 900_000)).toStrictEqual(U1_W1);
  });

  it("恰在 t + 899999 再签发仍是同一个令牌", () => {
    const tokens = createPreviewTokens();
    const issued = tokens.issue(U1_W1, T);

    const renewed = tokens.issue(U1_W1, T + 899_999);
    expect(renewed.token).toBe(issued.token);
    expect(renewed.expiresAt).toBe(T + 899_999 + 900_000);
  });

  it("时钟回拨时续期照样赋值为 now + 900000，不做单调保护", () => {
    const tokens = createPreviewTokens();
    const issued = tokens.issue(U1_W1, T);

    const earlier = tokens.issue(U1_W1, T - 1_000);
    expect(earlier.token).toBe(issued.token);
    expect(earlier.expiresAt).toBe(T - 1_000 + 900_000);
    expect(tokens.lookup(issued.token, T - 1_000 + 900_000)).toBeNull();
  });

  it("查找返回的是恰好三键的副本：不带 expiresAt 与 token，改动它不影响登记表", () => {
    const tokens = createPreviewTokens();
    const { token } = tokens.issue(U1_W1, T);

    const found = tokens.lookup(token, T);
    expect(Object.keys(found ?? {}).sort()).toEqual(["embedOrigin", "ownerId", "workspaceId"]);
    Object.assign(found ?? {}, { ownerId: "u2", workspaceId: "w2", embedOrigin: null });
    expect(tokens.lookup(token, T)).toStrictEqual(U1_W1);
  });
});

describe("预览令牌登记表：未知令牌", () => {
  it("空串、63 个字符的前缀、大写形式与任意其它字符串都查不到，活令牌不受影响", () => {
    const tokens = createPreviewTokens();
    const token = issueWithLetter(tokens);
    const found = tokens.lookup(token, T);
    expect(found).not.toBeNull();

    expect(tokens.lookup("", T)).toBeNull();
    expect(token.slice(0, 63)).toHaveLength(63);
    expect(tokens.lookup(token.slice(0, 63), T)).toBeNull();
    expect(token).toMatch(/[a-f]/u);
    expect(token.toUpperCase()).not.toBe(token);
    expect(tokens.lookup(token.toUpperCase(), T)).toBeNull();
    expect(tokens.lookup(`${token}0`, T)).toBeNull();
    expect(tokens.lookup(` ${token}`, T)).toBeNull();
    expect(tokens.lookup("not-a-token", T)).toBeNull();

    expect(tokens.lookup(token, T)).toStrictEqual(found);
  });

  it("对象原型上的名字不是令牌：constructor、__proto__、toString 都查不到", () => {
    const tokens = createPreviewTokens();
    tokens.issue(U1_W1, T);

    expect(tokens.lookup("constructor", T)).toBeNull();
    expect(tokens.lookup("__proto__", T)).toBeNull();
    expect(tokens.lookup("toString", T)).toBeNull();
  });

  it("空登记表里什么都查不到", () => {
    expect(createPreviewTokens().lookup("", T)).toBeNull();
    expect(createPreviewTokens().lookup("constructor", T)).toBeNull();
  });
});
