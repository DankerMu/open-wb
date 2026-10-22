/**
 * models/store — 模型注册表的表读写与校验（s1d-model-registry D1–D4、D8；model-registry「迁移 046 模型表」
 * 「环境种子」「注册表快照是白名单的唯一来源」的 store 部分）。纯 DB：`node:sqlite` 同步读写，不碰文件系统与网络。
 *
 * 凭证：密钥只经 `routeOf` 与 `secrets` 读出；`ModelRow` 不带密钥，校验失败一律抛固定 message 的 `HttpError`
 *（不回显取值）。事务：每个写方法自己开一个事务（SQLite 不能嵌套 BEGIN，调用方不得已在事务里），可选的
 * `within(row)` 在写入之后、COMMIT 之前于同一事务内调用（审计挂点）；它抛出即整体回滚。
 * 不变量：非空表恰有一行缺省——首行自动成为缺省，缺省行不能删除，换缺省在一个事务里清旧立新。
 */
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { validateUpstream, validateUpstreamKey } from "../agent-config.js";
import { withoutUserinfo } from "../core/base-url.js";
import { HttpError, type HttpErrorCode } from "../core/errors/index.js";
import { upstreamSecretList } from "../core/upstream-failure.js";
import {
  type CatalogModel,
  type Effort,
  type ModelCatalog,
  validateCatalogModel,
} from "../model-catalog.js";

/** 与 `MODEL_CATALOG` 同一上限；由插入前计数保证（表本身不约束行数）。 */
const MAX_MODELS = 32;

/** 一行注册表的读出形状：永不带密钥，只以 `hasApiKey` 表明上游配了密钥。 */
export interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  maxTokens: number;
  /** NULL = 不声明强度集合（非推理模型恒为 NULL；推理模型可为 NULL）。 */
  efforts: readonly Effort[] | null;
  upstream: { baseUrl: string; hasApiKey: true } | null;
  isDefault: boolean;
  probe: { status: "never" | "ok" | "failed"; at: number | null; message: string | null };
  createdAt: number;
  updatedAt: number;
}

interface Upstream {
  baseUrl: string;
  apiKey: string;
}

type Within = (row: ModelRow) => void;
type Raw = Record<string, SQLOutputValue>;

const SELECT_ONE = "SELECT * FROM models WHERE id = ?";
const SELECT_ALL = "SELECT * FROM models ORDER BY created_at, id";
const INSERT =
  "INSERT INTO models (id, name, reasoning, vision, max_tokens, efforts, upstream_base_url, upstream_api_key, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE =
  "UPDATE models SET name = ?, reasoning = ?, vision = ?, max_tokens = ?, efforts = ?, upstream_base_url = ?, upstream_api_key = ?, updated_at = ? WHERE id = ?";
/** PUT 整体替换 `id` 以外的字段：这些键必须给出（`efforts` 可省略 = NULL）。 */
const UPDATE_REQUIRED_KEYS = ["name", "reasoning", "vision", "maxTokens", "upstream"] as const;
export function createModelStore(db: DatabaseSync) {
  const select = (id: string): ModelRow | undefined => {
    const raw = db.prepare(SELECT_ONE).get(id);
    return raw === undefined ? undefined : toRow(raw);
  };
  const existing = (id: string): ModelRow => select(id) ?? fail("not_found");
  /** 写入之后、COMMIT 之前：读回该行交给调用方的同事务步骤。 */
  const finish = (id: string, within: Within | undefined): ModelRow => {
    const row = existing(id);
    within?.(row);
    return row;
  };
  const insert = (model: CatalogModel, upstream: Upstream | null, isDefault: boolean, at: number) =>
    db
      .prepare(INSERT)
      .run(
        model.id,
        model.name,
        flag(model.reasoning),
        flag(model.vision),
        model.maxTokens,
        effortsText(model.efforts),
        upstream?.baseUrl ?? null,
        upstream?.apiKey ?? null,
        flag(isDefault),
        at,
        at,
      );

  /** 密钥读取之一：未知 id → undefined，没有上游 → null。 */
  const routeOf = (id: string): Upstream | null | undefined => {
    const raw = db.prepare(SELECT_ONE).get(id);
    if (raw === undefined) {
      return undefined;
    }
    return raw.upstream_api_key === null ? null : upstreamOf(raw);
  };

  return {
    list: (): ModelRow[] => db.prepare(SELECT_ALL).all().map(toRow),
    get: select,
    routeOf,

    /** POST 语义：缺省同 `MODEL_CATALOG`、推理模型可不带 `efforts`；表空时这一行成为缺省。 */
    create(body: unknown, within?: Within): ModelRow {
      const { model, upstream } = parseCreate(body);
      return inTransaction(db, () => {
        if (select(model.id) !== undefined) {
          fail("conflict");
        }
        const { count, last } = db
          .prepare("SELECT COUNT(*) AS count, MAX(created_at) AS last FROM models")
          .get() as { count: number; last: number | null };
        if (count >= MAX_MODELS) {
          fail("bad_request");
        }
        // 列表次序即登记次序：同一毫秒（或时钟回拨）里的登记仍排在已有行之后。
        const now = Date.now();
        insert(model, upstream, count === 0, last === null ? now : Math.max(now, last + 1));
        return finish(model.id, within);
      });
    },

    /**
     * PUT 语义：整体替换；`upstream.apiKey` 省略即保留既有密钥（没有既有密钥则 400）；`null` 清空上游。
     * `baseUrl` 逐字等于已存地址的视图形式（去掉 userinfo）：沿用已存地址、不再套地址规则（地址规则拒 `@`）——
     * `apiKey` 省略则密钥也沿用，给了则只换密钥（仍经 header 值校验）。编辑 env 种子行只改名或只换密钥都不丢
     * 地址里 userinfo 的凭证。
     */
    update(id: string, body: unknown, within?: Within): ModelRow {
      const { model, upstream } = parseUpdate(id, body);
      return inTransaction(db, () => {
        const current = routeOf(id);
        if (current === undefined) {
          fail("not_found");
        }
        const next =
          upstream === null
            ? null
            : current !== null && upstream.baseUrl === withoutUserinfo(current.baseUrl)
              ? { baseUrl: current.baseUrl, apiKey: checkedKey(upstream.apiKey ?? current.apiKey) }
              : checkedUpstream(upstream.baseUrl, upstream.apiKey ?? current?.apiKey);
        db.prepare(UPDATE).run(
          model.name,
          flag(model.reasoning),
          flag(model.vision),
          model.maxTokens,
          effortsText(model.efforts),
          next?.baseUrl ?? null,
          next?.apiKey ?? null,
          Date.now(),
          id,
        );
        return finish(id, within);
      });
    },

    /** 缺省行不能删（409 `model_in_use`）；`within` 收到删除前的行。 */
    remove(id: string, within?: Within): void {
      inTransaction(db, () => {
        const row = existing(id);
        if (row.isDefault) {
          fail("model_in_use");
        }
        db.prepare("DELETE FROM models WHERE id = ?").run(id);
        within?.(row);
      });
    },

    /** 已是缺省：不写入、不调 `within`，`changed: false`。否则一个事务里清旧立新。 */
    setDefault(id: string, within?: Within): { row: ModelRow; changed: boolean } {
      const target = existing(id);
      if (target.isDefault) {
        return { row: target, changed: false };
      }
      return inTransaction(db, () => {
        const now = Date.now();
        // 部分唯一索引 models_default 要求先清旧再立新。
        db.prepare("UPDATE models SET is_default = 0, updated_at = ? WHERE is_default = 1").run(
          now,
        );
        db.prepare("UPDATE models SET is_default = 1, updated_at = ? WHERE id = ?").run(now, id);
        return { row: finish(id, within), changed: true };
      });
    },

    /**
     * 启动种子（D2）：判空与全部插入在一个事务里，任一插入失败表保持为空。两个上游值都给出才写两列，
     * 否则两列都 NULL；env 的 base URL 原样写入，不套 `validateUpstream`。`created_at` 为同一基准 + 下标。
     */
    seedIfEmpty(
      catalog: ModelCatalog,
      upstream: { baseUrl?: string | undefined; apiKey?: string | undefined },
    ): "seeded" | "skipped" {
      const { baseUrl, apiKey } = upstream;
      const pair = baseUrl !== undefined && apiKey !== undefined ? { baseUrl, apiKey } : null;
      return inTransaction(db, () => {
        if (db.prepare("SELECT 1 FROM models LIMIT 1").get() !== undefined) {
          return "skipped";
        }
        const base = Date.now();
        catalog.models.forEach((model, index) => {
          insert(model, pair, model.id === catalog.defaultModelId, base + index);
        });
        return "seeded";
      });
    },

    /** 探活结果写三列，不动 `updated_at`。 */
    recordProbe(
      id: string,
      result: { status: "ok" | "failed"; message: string | null; at: number },
      within?: Within,
    ): ModelRow {
      return inTransaction(db, () => {
        const { changes } = db
          .prepare(
            "UPDATE models SET probe_status = ?, probe_message = ?, probe_at = ? WHERE id = ?",
          )
          .run(result.status, result.message, result.at, id);
        if (changes === 0 || changes === 0n) {
          fail("not_found");
        }
        return finish(id, within);
      });
    },

    toCatalog,

    /** 密钥读取之二：每个有上游的行按 upstream-failure 密钥集规则导出（不含路径），按列表次序去重并集。 */
    secrets(): readonly string[] {
      const rows = db
        .prepare(
          "SELECT upstream_base_url, upstream_api_key FROM models WHERE upstream_api_key IS NOT NULL ORDER BY created_at, id",
        )
        .all();
      const lists = rows.map((raw) => upstreamSecretList({ ...upstreamOf(raw), paths: [] }));
      return [...new Set(lists.flat())];
    },
  };
}

/** 行 → 白名单（纯函数）：`efforts` 为 NULL 的行不带这个键；恰一行缺省，否则是表的不变量被破坏。 */
function toCatalog(rows: readonly ModelRow[]): ModelCatalog {
  const defaults = rows.filter((row) => row.isDefault);
  if (defaults.length !== 1 || defaults[0] === undefined) {
    throw new Error("model registry must hold exactly one default model");
  }
  const models = rows.map(({ id, name, reasoning, vision, maxTokens, efforts }): CatalogModel => {
    const model = { id, name, reasoning, vision, maxTokens };
    return efforts === null ? model : { ...model, efforts };
  });
  return { models, defaultModelId: defaults[0].id };
}

function toRow(raw: Raw): ModelRow {
  return {
    id: String(raw.id),
    name: String(raw.name),
    reasoning: raw.reasoning === 1,
    vision: raw.vision === 1,
    maxTokens: Number(raw.max_tokens),
    efforts: raw.efforts === null ? null : (JSON.parse(String(raw.efforts)) as Effort[]),
    upstream:
      raw.upstream_base_url === null
        ? null
        : { baseUrl: String(raw.upstream_base_url), hasApiKey: true },
    isDefault: raw.is_default === 1,
    probe: {
      status: raw.probe_status as ModelRow["probe"]["status"],
      at: raw.probe_at === null ? null : Number(raw.probe_at),
      message: raw.probe_message === null ? null : String(raw.probe_message),
    },
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

function upstreamOf(raw: Raw): Upstream {
  return { baseUrl: String(raw.upstream_base_url), apiKey: String(raw.upstream_api_key) };
}

function parseCreate(body: unknown): { model: CatalogModel; upstream: Upstream | null } {
  if (!isRecord(body)) {
    fail("bad_request");
  }
  const { upstream, ...entry } = body;
  if (upstream === undefined) {
    return { model: catalogModel(entry), upstream: null };
  }
  const { baseUrl, apiKey } = upstreamFields(upstream);
  return { model: catalogModel(entry), upstream: checkedUpstream(baseUrl, apiKey) };
}

function parseUpdate(
  id: string,
  body: unknown,
): { model: CatalogModel; upstream: { baseUrl: string; apiKey: string | undefined } | null } {
  if (!isRecord(body) || "id" in body || UPDATE_REQUIRED_KEYS.some((key) => !(key in body))) {
    fail("bad_request");
  }
  const { upstream, ...entry } = body;
  return {
    model: catalogModel({ ...entry, id }),
    upstream: upstream === null ? null : upstreamFields(upstream),
  };
}

/** `{baseUrl, apiKey?}` 的形状（键集严格）；规则由 `checkedUpstream` 判定。 */
function upstreamFields(value: unknown): { baseUrl: string; apiKey: string | undefined } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "baseUrl" && key !== "apiKey")) {
    fail("bad_request");
  }
  const { baseUrl, apiKey } = value;
  if (typeof baseUrl !== "string" || (apiKey !== undefined && typeof apiKey !== "string")) {
    fail("bad_request");
  }
  return { baseUrl, apiKey };
}

/** 沿用已存地址时只校验密钥：非空的合法 header 值。 */
function checkedKey(apiKey: string): string {
  if (!validateUpstreamKey(apiKey)) {
    fail("bad_request");
  }
  return apiKey;
}

function checkedUpstream(baseUrl: string, apiKey: string | undefined): Upstream {
  if (apiKey === undefined || !validateUpstream({ baseUrl, apiKey })) {
    fail("bad_request");
  }
  return { baseUrl, apiKey };
}

/** 字段规则与 `MODEL_CATALOG` 共用一份（`requireEfforts: false`）；规则的原文 message 不外传。 */
function catalogModel(entry: Record<string, unknown>): CatalogModel {
  try {
    return validateCatalogModel(entry, { requireEfforts: false });
  } catch {
    fail("bad_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function effortsText(efforts: readonly Effort[] | undefined): string | null {
  return efforts === undefined ? null : JSON.stringify(efforts);
}

function fail(code: HttpErrorCode): never {
  throw new HttpError(code);
}

/** 本模块自有的事务（沿 `auth/session.ts` 的先例；`models` 不导入 `sessions`）：回滚失败时聚合两个错误。 */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "model registry rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
