import type { Principal } from "./api.js";

const ADMIN_ROLE = "管理员";

/** 前端可见性用的管理员判定：角色严格等于 `管理员`（服务端的 403 另有判定，不依赖它）。 */
export function isAdmin(principal: Pick<Principal, "role">): boolean {
  return principal.role === ADMIN_ROLE;
}
