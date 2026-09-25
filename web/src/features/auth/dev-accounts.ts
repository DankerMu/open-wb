/** 镜像 dev-stub seed（server/src/core/db/migrations/010_auth_schema_seed.sql）的可登录账号；只有 account 与 seed role。 */
export const DEV_ACCOUNTS = [
  { account: "zhangsan", role: "成员" },
  { account: "zhaoliu", role: "成员" },
  { account: "lisi", role: "管理员" },
] as const;

export const DEV_PASSWORD = "demo";

export const DEV_STUB_PROVIDER = "dev-stub";
