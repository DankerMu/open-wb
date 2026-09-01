import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuthError } from "../errors.js";
import type { Principal } from "../index.js";

/**
 * dev-stub 凭证适配器：只拥有账号规范化、账号查询、scrypt 解析/验证与
 * "停用只在密码正确后暴露" 的判定。不 import http，不读写 cookie/session。
 * KDF 唯一注入边界 = passwordSource（默认真实 node:crypto scrypt）。
 */

const HASH_ENCODING = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/u;
/** 固定有效 dummy encoding（格式同存储 hash）。不携带任何已知明文。 */
const DUMMY_ENCODING =
  "scrypt$16384$8$1$00000000000000000000000000000000$a9a1af68f64c2376347a4b1c82a4a6afc5398f4fbfdb19346c345e2a41255002";

const FIND_ACCOUNT_SQL =
  "SELECT id, account, role, disabled, password_hash FROM accounts WHERE account = ?";

export type PasswordSource = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

interface AccountRow {
  id: string;
  account: string;
  role: string;
  disabled: number;
  password_hash: string;
}

export interface DevStubProvider {
  verify(
    accountInput: string,
    password: string,
  ): Promise<{ principal: Principal; disabled: boolean } | { authError: AuthError }>;
}

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });

/** 未知/空账号固定路径：解析固定 valid dummy encoding（与存储 hash 同解析器），
 * 用请求提交的 password 执行一次真实等参数 scrypt，equal-length constant-time
 * compare，忽略匹配结果，恒返回 invalid_credentials。等价 KDF 工作量且不持有
 * 任何固定明文 dummy password。 */
async function runDummyScrypt(
  submittedPassword: string,
  passwordSource: PasswordSource = scrypt,
): Promise<void> {
  const encoding = parseStoredHash(DUMMY_ENCODING);
  const derived = await passwordSource(submittedPassword, encoding.salt, 32, SCRYPT_OPTIONS);
  if (derived.length !== encoding.digest.length) {
    throw new Error("dummy scrypt path must derive a digest of the expected length");
  }
  timingSafeEqual(derived, encoding.digest);
}

export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

export function parseStoredHash(encoding: string): { salt: Buffer; digest: Buffer } {
  const match = HASH_ENCODING.exec(encoding);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("stored password hash does not match the scrypt encoding");
  }
  return {
    salt: Buffer.from(match[1], "hex"),
    digest: Buffer.from(match[2], "hex"),
  };
}

function credentialError(): AuthError {
  return new AuthError("invalid_credentials");
}

async function derivedKeyMatches(
  password: string,
  encoding: { salt: Buffer; digest: Buffer },
  passwordSource: PasswordSource,
): Promise<boolean> {
  const derived = await passwordSource(password, encoding.salt, 32, SCRYPT_OPTIONS);
  if (derived.length !== encoding.digest.length) {
    throw new Error("stored password KDF must derive a digest of the expected length");
  }
  return timingSafeEqual(derived, encoding.digest);
}

export function createDevStubProvider(
  db: DatabaseSync,
  passwordSource: PasswordSource = scrypt,
): DevStubProvider {
  return {
    async verify(accountInput, password) {
      const account = normalizeAccount(accountInput);
      const row = db.prepare(FIND_ACCOUNT_SQL).get(account) as AccountRow | undefined;

      if (row === undefined) {
        await runDummyScrypt(password, passwordSource);
        return { authError: credentialError() };
      }

      const encoding = parseStoredHash(row.password_hash);
      const matches = await derivedKeyMatches(password, encoding, passwordSource);
      if (!matches) {
        return { authError: credentialError() };
      }
      if (row.disabled !== 0) {
        return {
          principal: { id: row.id, account: row.account, role: row.role },
          disabled: true,
        };
      }

      return {
        principal: { id: row.id, account: row.account, role: row.role },
        disabled: false,
      };
    },
  };
}
