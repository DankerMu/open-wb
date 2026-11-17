/**
 * 知识库的可见范围（s2c-kb-visibility D3、D12；knowledge-bases「知识库范围端点」）：写 `scope`、`scope_group_id` 的语句全仓只有
 * 这一条，建库与改范围共用。形状（`parseScope`）不读库；所有者条件（`assertQualified`）读所有者此刻的部门与成员关系，与账号
 * 范围端点用同一个读取函数 `scopeOf`（account-groups）：`dept` 要部门非空，`group` 要是该组成员（含组不存在）。
 *
 * 改范围（`change`）在归属判定之后：形状 → 所有者条件 → 与已存值相同即不写、不审计（条件先于「相同」）→ 一条事务里更新两列
 * 并写 `kb.scope`。这几步是同一连接上的同步调用，更新影响 0 行（库已被并发删除）即 404 并回滚。不取写锁、不看 `state`、
 * 不访问 RAGFlow，不动 `updated_at`。
 */
import type { DatabaseSync } from "node:sqlite";
import { scopeOf } from "../accounts/scope.js";
import { HttpError } from "../core/errors/index.js";
import { isNonEmptyString, isRecord } from "./ragflow-route.js";
import { inTransaction } from "./store.js";
import type { BaseAccess } from "./visibility.js";

type Scope = BaseAccess["scope"]["scope"];
type ScopeRef = { scope: Scope; groupId: string | null };

const SCOPES: ReadonlySet<unknown> = new Set(["me", "dept", "group", "all"]);
const BODY_KEYS = new Set(["scope", "groupId"]);

interface ScopeAuditEvent {
  kind: "kb.scope";
  actorId: string;
  title: string;
  detail: object;
}

function badRequest(): never {
  throw new HttpError("bad_request");
}

const isScope = (value: unknown): value is Scope => SCOPES.has(value);

/** `scope` 缺省 `me`；`group` 时 `groupId` 是非空字符串，其余档位带 `groupId` 键（含 `null`）即 400。其余键由调用方判定。 */
export function parseScope(body: Record<string, unknown>): ScopeRef {
  const scope = Object.hasOwn(body, "scope") ? body.scope : "me";
  if (!isScope(scope)) {
    badRequest();
  }
  if (scope === "group") {
    if (!isNonEmptyString(body.groupId)) {
      badRequest();
    }
    return { scope, groupId: body.groupId };
  }
  if (Object.hasOwn(body, "groupId")) {
    badRequest();
  }
  return { scope, groupId: null };
}

/** `audit` 是 `core/audit` 的 `emit`，已绑定 DB。 */
export function createKbScope(dependencies: {
  db: DatabaseSync;
  audit: (event: ScopeAuditEvent) => void;
}) {
  const { db, audit } = dependencies;

  /** 所有者条件：只有 `dept`、`group` 读账号。 */
  function assertQualified(ownerId: string, ref: ScopeRef): void {
    if (ref.scope !== "dept" && ref.scope !== "group") {
      return;
    }
    const { department, groups } = scopeOf(db, ownerId);
    const qualified =
      ref.scope === "dept" ? department !== null : groups.some(({ id }) => id === ref.groupId);
    if (!qualified) {
      badRequest();
    }
  }

  /** 更新两列，返回影响的行数；不开事务，建库在 `createBase` 的事务里调用。 */
  function write(id: string, ref: ScopeRef): number {
    const sql = "UPDATE knowledge_bases SET scope = ?, scope_group_id = ? WHERE id = ?";
    return Number(db.prepare(sql).run(ref.scope, ref.groupId, id).changes);
  }

  return {
    assertQualified,
    write,

    /** `PUT /api/kb/bases/:id/scope` 的判定与写入，`access` 已通过归属判定（调用者是所有者）。 */
    change(access: BaseAccess, body: unknown, actorId: string): void {
      const keys = isRecord(body) ? Object.keys(body) : [];
      if (!isRecord(body) || !keys.includes("scope") || keys.some((key) => !BODY_KEYS.has(key))) {
        badRequest();
      }
      const after = parseScope(body);
      assertQualified(access.owner.id, after);
      const before = { scope: access.scope.scope, groupId: access.scope.group?.id ?? null };
      if (before.scope === after.scope && before.groupId === after.groupId) {
        return;
      }
      const { id } = access.base;
      inTransaction(db, () => {
        if (write(id, after) === 0) {
          throw new HttpError("not_found");
        }
        const detail = { id, before, after };
        audit({ kind: "kb.scope", actorId, title: "修改知识库可见范围", detail });
      });
    },
  };
}
