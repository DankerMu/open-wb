/**
 * core/roles — 管理员判定的唯一出处（s1d-model-registry design D9）。
 *
 * 结构化入参，不导入 auth；`role` 与迁移 010 的种子逐字比较，不做修剪或大小写归一。
 */
export const ADMIN_ROLE = "管理员";

export function isAdmin(principal: { readonly role: string }): boolean {
  return principal.role === ADMIN_ROLE;
}
