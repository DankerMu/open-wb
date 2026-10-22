import { describe, expect, it } from "vitest";
import { ADMIN_ROLE, isAdmin } from "../src/core/roles.js";

describe("core/roles isAdmin 严格相等（design D9）", () => {
  it("ADMIN_ROLE 是迁移 010 种子里的 管理员", () => {
    expect(ADMIN_ROLE).toBe("管理员");
  });

  it("role 恰为 管理员 -> true", () => {
    expect(isAdmin({ role: "管理员" })).toBe(true);
  });

  it.each(["管理员 ", " 管理员", "admin", "", "成员"])("role %j -> false", (role) => {
    expect(isAdmin({ role })).toBe(false);
  });
});
