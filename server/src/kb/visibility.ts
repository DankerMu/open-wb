/**
 * 知识库的可见判定（s2c-kb-visibility D2；knowledge-bases「可见范围判定」）：全仓唯一一处。
 *
 * 查看者能看见一个库，当且仅当：库是自己的；或范围为 `all`；或范围为 `dept`，查看者与所有者此刻的部门都非空且相同；或范围为
 * `group`，查看者此刻是该组的成员。部门与成员关系每次现查，不缓存；管理员没有分支，停用的所有者不进谓词。
 *
 * 一个 SELECT 加一个谓词，两条语句共用：查看者经 `JOIN accounts AS v ON v.id = ?` 只绑定一次。`accounts` 与
 * `project_group_members` 由 `accounts` 模块拥有，这里只读（依赖规则 2：`kb → accounts`）。列表的次序在 SQL 里：自有的在前，
 * 各自按 `created_at` 升序，同一时间戳按 `id`。
 */
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type KnowledgeBase, toBase } from "./store.js";

type Scope = "me" | "dept" | "group" | "all";

/** 查看者对一个库的访问：`BaseView` 的 `owned`、`owner`、`scope` 取自这里，`scope` 也供共享检索审计用。 */
export interface BaseAccess {
  base: KnowledgeBase;
  owned: boolean;
  owner: { id: string; account: string; department: string | null };
  scope: { scope: Scope; group: { id: string; name: string } | null };
}

const SELECT_ACCESS = `SELECT kb.*, kb.owner_id = v.id AS owned, o.account AS owner_account,
  o.department AS owner_department, g.name AS group_name
  FROM knowledge_bases AS kb
  JOIN accounts AS o ON o.id = kb.owner_id
  JOIN accounts AS v ON v.id = ?
  LEFT JOIN project_groups AS g ON g.id = kb.scope_group_id`;

/** 可见谓词：两条语句共用这一份。 */
const VISIBLE = `(kb.owner_id = v.id OR kb.scope = 'all'
  OR (kb.scope = 'dept' AND v.department IS NOT NULL AND v.department = o.department)
  OR (kb.scope = 'group' AND EXISTS (SELECT 1 FROM project_group_members AS m
    WHERE m.group_id = kb.scope_group_id AND m.account_id = v.id)))`;

const SELECT_VISIBLE = `${SELECT_ACCESS} WHERE ${VISIBLE} ORDER BY owned DESC, kb.created_at, kb.id`;
const SELECT_ONE = `${SELECT_ACCESS} WHERE kb.id = ? AND ${VISIBLE}`;

const text = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function toAccess(row: Record<string, SQLOutputValue>): BaseAccess {
  const groupId = text(row.scope_group_id);
  return {
    base: toBase(row),
    owned: row.owned === 1,
    owner: {
      id: String(row.owner_id),
      account: String(row.owner_account),
      department: text(row.owner_department),
    },
    scope: {
      scope: row.scope as Scope,
      group: groupId === null ? null : { id: groupId, name: String(row.group_name) },
    },
  };
}

export function createKbVisibility(db: DatabaseSync) {
  return {
    /** 查看者可见的全部库，次序见文件头。 */
    visibleBases: (viewerId: string): BaseAccess[] =>
      db.prepare(SELECT_VISIBLE).all(viewerId).map(toAccess),

    /** 一个库对查看者的访问；不可见与不存在都是 `null`。 */
    accessOf(id: string, viewerId: string): BaseAccess | null {
      const row = db.prepare(SELECT_ONE).get(viewerId, id);
      return row === undefined ? null : toAccess(row);
    },
  };
}
