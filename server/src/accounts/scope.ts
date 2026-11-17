import type { DatabaseSync } from "node:sqlite";

/**
 * 账号此刻的部门与项目组（account-groups「账号范围端点」）：端点与 kb 的所有者判定共用这一个
 * 读取函数。纯读，不写表；组按 `name` 的 SQLite BINARY 序（UTF-8 字节序即码点序）升序，
 * `memberCount` 计该组全部成员行。
 */
export function scopeOf(
  db: DatabaseSync,
  accountId: string,
): { department: string | null; groups: { id: string; name: string; memberCount: number }[] } {
  const account = db.prepare("SELECT department FROM accounts WHERE id = ?").get(accountId) as {
    department: string | null;
  };
  const rows = db
    .prepare(
      "SELECT g.id, g.name, (SELECT COUNT(*) FROM project_group_members AS c WHERE c.group_id = g.id) AS memberCount FROM project_group_members AS m JOIN project_groups AS g ON g.id = m.group_id WHERE m.account_id = ? ORDER BY g.name",
    )
    .all(accountId) as { id: string; name: string; memberCount: number }[];
  return {
    department: account.department,
    groups: rows.map((row) => ({ id: row.id, name: row.name, memberCount: row.memberCount })),
  };
}
