import { scrypt as realScrypt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AuthError } from "../src/auth/errors.js";
import {
  createDevStubProvider,
  normalizeAccount,
  type PasswordSource,
  parseStoredHash,
} from "../src/auth/providers/dev-stub.js";
import { openDb } from "../src/core/db/index.js";

const DUMMY_SALT_HEX = "00000000000000000000000000000000";
const DUMMY_DIGEST_HEX = "a9a1af68f64c2376347a4b1c82a4a6afc5398f4fbfdb19346c345e2a41255002";
const DUMMY_ENCODING = `scrypt$16384$8$1$${DUMMY_SALT_HEX}$${DUMMY_DIGEST_HEX}`;

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

interface DerivationInvocation {
  password: string;
  salt: Buffer;
  keyLength: number;
  options: { N: number; r: number; p: number };
}

function makeRecordingSource(invocations: DerivationInvocation[]): PasswordSource {
  return async (password, salt, keyLength, options) => {
    invocations.push({ password, salt, keyLength, options });
    return realDerive(password, salt);
  };
}

/** 派生结果长度与存储 digest 不一致：KDF/programmer failure 语义。 */
function makeWrongLengthSource(): PasswordSource {
  return async (_password, salt, _keyLength, _options) => Buffer.alloc(salt.length);
}

function expectDummyDerivation(invocation: DerivationInvocation | undefined): void {
  expect(invocation?.salt.toString("hex")).toBe(DUMMY_SALT_HEX);
  expect(invocation?.keyLength).toBe(32);
  expect(invocation?.options).toEqual(SCRYPT_OPTIONS);
}

function scrypt(
  password: string,
  salt: Buffer,
  keylength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    realScrypt(password, salt, keylength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

async function realDerive(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password, salt, 32, SCRYPT_OPTIONS);
}

async function withDb<T>(action: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const db = openDb(":memory:");
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

describe("dev-stub provider verification seam", () => {
  it("正确密码：以真实 scrypt 从 seed hash 验证并返回 exact Principal", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db);
      const outcome = await provider.verify("zhangsan", "demo");

      expect("principal" in outcome).toBe(true);
      if ("principal" in outcome) {
        expect(outcome.principal).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
      }
      const row = db.prepare("SELECT id, password_hash FROM accounts WHERE id = ?").get("u1") as {
        id: string;
        password_hash: string;
      };
      const parsed = parseStoredHash(row.password_hash);
      const derived = await realDerive("demo", parsed.salt);
      expect(derived.toString("hex")).toBe(parsed.digest.toString("hex"));
    });
  });

  it("错误密码：真实 scrypt 校验为 false -> invalid_credentials", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db);
      const outcome = await provider.verify("zhangsan", "wrong");

      expect("authError" in outcome).toBe(true);
      if ("authError" in outcome) {
        expect(outcome.authError.code).toBe("invalid_credentials");
      }
    });
  });

  it("未知账号：真实 dummy scrypt 路径后返回 invalid_credentials", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db);
      const outcome = await provider.verify("nobody", "demo");

      expect("authError" in outcome).toBe(true);
      if ("authError" in outcome) {
        expect(outcome.authError.code).toBe("invalid_credentials");
      }
    });
  });

  it("空白规范化后为空：等同未知账号（dummy scrypt 路径）", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db);
      const outcome = await provider.verify("   ", "demo");

      expect("authError" in outcome).toBe(true);
      if ("authError" in outcome) {
        expect(outcome.authError.code).toBe("invalid_credentials");
      }
      // 真实 dummy 编码路径与真实库查询均执行一次
      expect(db.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get()).toEqual({ c: 0 });
    });
  });

  it("停用账号 wangwu：正确密码 -> principal+disabled；错误密码 -> invalid_credentials", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db);
      const correct = await provider.verify("wangwu", "demo");
      expect("principal" in correct && "disabled" in correct).toBe(true);
      if ("principal" in correct) {
        expect(correct.principal).toEqual({ id: "u4", account: "wangwu", role: "成员" });
      }

      const wrong = await provider.verify("wangwu", "wrong");
      expect("authError" in wrong).toBe(true);
      if ("authError" in wrong) {
        expect(wrong.authError.code).toBe("invalid_credentials");
      }
      expect(db.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get()).toEqual({ c: 0 });
    });
  });

  async function expectWangwuDerivation(db: DatabaseSync, password: string) {
    const row = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get("u4") as {
      password_hash: string;
    };
    const stored = parseStoredHash(row.password_hash);

    const invocations: DerivationInvocation[] = [];
    const provider = createDevStubProvider(db, makeRecordingSource(invocations));
    const outcome = await provider.verify("wangwu", password);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.password).toBe(password);
    expect(invocations[0]?.salt.toString("hex")).toBe(stored.salt.toString("hex"));
    expect(invocations[0]?.keyLength).toBe(32);
    expect(invocations[0]?.options).toEqual(SCRYPT_OPTIONS);
    return outcome;
  }

  it("wangwu 正确密码：disabled 判定前恰好一次 stored-hash KDF（submitted password + stored salt + 32 + 精确参数）", async () => {
    await withDb(async (db) => {
      const outcome = await expectWangwuDerivation(db, "demo");
      expect(outcome).toEqual({
        principal: { id: "u4", account: "wangwu", role: "成员" },
        disabled: true,
      });
    });
  });

  it("wangwu 错误密码：disabled 判定前恰好一次 stored-hash KDF（submitted password + stored salt + 32 + 精确参数）", async () => {
    await withDb(async (db) => {
      const outcome = await expectWangwuDerivation(db, "wrong");
      expect(outcome).toEqual({ authError: new AuthError("invalid_credentials") });
    });
  });

  it("injected derive 源：正确/错误/未知/空账号各恰好一次调用，无账号存在性泄漏", async () => {
    await withDb(async (db) => {
      const invocations: DerivationInvocation[] = [];
      const provider = createDevStubProvider(db, makeRecordingSource(invocations));

      await provider.verify("zhangsan", "demo");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.password).toBe("demo");
      expect(invocations[0]?.salt.toString("hex")).toMatch(/^[0-9a-f]{32}$/u);
      expect(invocations[0]?.keyLength).toBe(32);
      expect(invocations[0]?.options).toEqual(SCRYPT_OPTIONS);

      invocations.length = 0;
      await provider.verify("zhangsan", "wrong");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.password).toBe("wrong");

      invocations.length = 0;
      await provider.verify("no-such-account", "demo");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.password).toBe("demo");
      expectDummyDerivation(invocations[0]);

      invocations.length = 0;
      await provider.verify("   ", "demo");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.password).toBe("demo");
    });
  });

  it("未知/空账号使用请求提交的 password 原样观察（含多字节/空白），不引入固定明文", async () => {
    await withDb(async (db) => {
      const invocations: DerivationInvocation[] = [];
      const provider = createDevStubProvider(db, makeRecordingSource(invocations));

      for (const password of ["demo", "", "   ", "  空格\t", "p@ss 密码"]) {
        invocations.length = 0;
        await provider.verify("no-such-account", password);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.password).toBe(password);
        expectDummyDerivation(invocations[0]);
      }
    });
  });

  it("KDF 失败（injected 源 reject）是 generic 5xx 语义：抛错而非返回 401", async () => {
    await withDb(async (db) => {
      const failingSource: PasswordSource = async () => {
        throw new Error("scrypt engine failure");
      };
      const provider = createDevStubProvider(db, failingSource);

      await expect(provider.verify("zhangsan", "demo")).rejects.toThrow("scrypt engine failure");
    });
  });

  it("未知账号 dummy 路径：injected derive 返回错误长度是 KDF/programmer error，不静默跳过 compare", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db, makeWrongLengthSource());

      await expect(provider.verify("no-such-account", "demo")).rejects.toThrow(
        "dummy scrypt path must derive a digest of the expected length",
      );
    });
  });

  it("已知账号：injected derive 返回错误长度是 KDF/programmer error，不返回 false/401", async () => {
    await withDb(async (db) => {
      const provider = createDevStubProvider(db, makeWrongLengthSource());

      await expect(provider.verify("zhangsan", "demo")).rejects.toThrow(
        "stored password KDF must derive a digest of the expected length",
      );
    });
  });

  it("畸形存储 encoding：parseStoredHash 抛错，不伪装 401", async () => {
    await withDb(async (db) => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      try {
        db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(
          "not-a-scrypt-hash",
          "u1",
        );
      } finally {
        db.exec("PRAGMA ignore_check_constraints = OFF");
      }
      const provider = createDevStubProvider(db);
      await expect(provider.verify("zhangsan", "demo")).rejects.toThrow(
        "stored password hash does not match the scrypt encoding",
      );
    });
  });
});

describe("normalizeAccount 与 parseStoredHash 边界", () => {
  it("trim().toLowerCase() 语义", () => {
    expect(normalizeAccount("  ZhangSan ")).toBe("zhangsan");
    expect(normalizeAccount("ZHANGSAN")).toBe("zhangsan");
    expect(normalizeAccount("  lisi\t")).toBe("lisi");
    expect(normalizeAccount("   ")).toBe("");
    expect(normalizeAccount("\tZhaoLiu\n")).toBe("zhaoliu");
  });

  it("parseStoredHash 只接受 exact 自描述 encoding 并解码 salt/digest（含生产 dummy encoding）", () => {
    const { salt, digest } = parseStoredHash(
      `scrypt$16384$8$1$${DUMMY_SALT_HEX}$${DUMMY_DIGEST_HEX}`,
    );
    expect(salt.toString("hex")).toBe(DUMMY_SALT_HEX);
    expect(digest.toString("hex")).toBe(DUMMY_DIGEST_HEX);

    const dummy = parseStoredHash(DUMMY_ENCODING);
    expect(dummy.salt.toString("hex")).toBe(DUMMY_SALT_HEX);
    expect(dummy.digest.toString("hex")).toBe(DUMMY_DIGEST_HEX);
  });

  it.each([
    ["参数前缀变异", `scrypt$16385$8$1$${DUMMY_SALT_HEX}$${DUMMY_DIGEST_HEX}`],
    ["缺失分隔符", `scrypt$16384$8$1$${DUMMY_SALT_HEX}${DUMMY_DIGEST_HEX}`],
    ["salt 大写", `scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$${DUMMY_DIGEST_HEX}`],
    ["digest 大写", `scrypt$16384$8$1$${DUMMY_SALT_HEX}$${DUMMY_DIGEST_HEX.toUpperCase()}`],
    ["salt 长度变异", `scrypt$16384$8$1$aa$${DUMMY_DIGEST_HEX}`],
    ["digest 长度变异", `scrypt$16384$8$1$${DUMMY_SALT_HEX}$aa`],
    ["非 hex 字符", `scrypt$16384$8$1$gggggggggggggggggggggggggggggggg$${DUMMY_DIGEST_HEX}`],
    ["完全畸形", "not-a-scrypt-hash"],
    ["空串", ""],
  ] as const)("parseStoredHash 拒绝 %s", (_name, encoding) => {
    expect(() => parseStoredHash(encoding)).toThrow(
      "stored password hash does not match the scrypt encoding",
    );
  });
});
