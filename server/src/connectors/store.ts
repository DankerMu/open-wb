/**
 * connectors/store — the connector table and the account's default disabled connectors (s1d-connectors
 * design D1, D3, D5 store part, D7 storage; connectors「迁移 048 连接器 schema」「连接器管理端点」PUT and
 * probe reset). Pure DB, `node:sqlite` sync.
 *
 * Credentials: `env` / `headers` values go in through `parseCreate` / `parseUpdate` (`validate.ts`, the
 * only rules) and come out only through `enabledForMcp`, for the managed `mcp.json` writer
 * (`mcp-json.ts`, design D4), and `probeTarget`, for the probe (`probe.ts`, design D6) —
 * `ConnectorView` carries only the key names. Stored `env` /
 * `headers` are JSON objects with sorted keys, so a PUT giving the same values in another key order
 * stores the same text.
 *
 * Results: a refusal throws the fixed-message `bad_request`; a taken name `conflict` (checked before the
 * 32-row cap). `update` and `remove` return `undefined` for an unknown name, before the body is looked
 * at (the route answers 404 ahead of body errors); `recordProbe` throws `not_found` for a row deleted
 * meanwhile, before `within`. Each write opens its own transaction (the caller must not be in one); the
 * optional `within(view)` runs after the write, before COMMIT (the audit hook) — a throw rolls all of it
 * back.
 */
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import {
  type ConnectorFields,
  MAX_CONNECTORS,
  normalizeConnectorNames,
  parseCreate,
  parseUpdate,
} from "./validate.js";

/** The admin view of one connector (D5): the other type's fields are null; no credential values. */
export interface ConnectorView {
  name: string;
  type: "stdio" | "http";
  description: string;
  enabled: boolean;
  command: string | null;
  args: readonly string[] | null;
  envKeys: readonly string[] | null;
  url: string | null;
  headerKeys: readonly string[] | null;
  probe: { status: "never" | "ok" | "failed"; at: number | null; message: string | null };
  updatedAt: number;
}

type Within = (view: ConnectorView) => void;
type Raw = Record<string, SQLOutputValue>;
/** `command, args, env, url, headers` as stored: the connection parameters a probe result speaks for. */
type Connection = readonly [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

const SELECT_ONE = "SELECT * FROM connectors WHERE name = ?";
const SELECT_ALL = "SELECT * FROM connectors ORDER BY name";
const SELECT_ENABLED = "SELECT * FROM connectors WHERE enabled = 1 ORDER BY name";
const COUNT = "SELECT COUNT(*) AS count FROM connectors";
const INSERT =
  "INSERT INTO connectors(name, type, description, enabled, command, args, env, url, headers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE =
  "UPDATE connectors SET description = ?, enabled = ?, command = ?, args = ?, env = ?, url = ?, headers = ?, updated_at = ? WHERE name = ?";
const RESET_PROBE =
  "UPDATE connectors SET probe_status = 'never', probe_at = NULL, probe_message = NULL WHERE name = ?";
const DELETE = "DELETE FROM connectors WHERE name = ?";
const RECORD_PROBE =
  "UPDATE connectors SET probe_status = ?, probe_message = ?, probe_at = ? WHERE name = ?";
const SELECT_PREFS = "SELECT disabled_connectors FROM account_connector_prefs WHERE account_id = ?";
const UPSERT_PREFS =
  "INSERT INTO account_connector_prefs(account_id, disabled_connectors, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET disabled_connectors = excluded.disabled_connectors, updated_at = excluded.updated_at";

export function createConnectorStore(db: DatabaseSync) {
  const raw = (name: string): Raw | undefined => db.prepare(SELECT_ONE).get(name);
  const finish = (name: string, within: Within | undefined): ConnectorView => {
    const view = toView(raw(name) as Raw);
    within?.(view);
    return view;
  };

  return {
    /** Every connector by name (the admin list). */
    list: (): ConnectorView[] => db.prepare(SELECT_ALL).all().map(toView),

    /** The enabled rows with their credentials, by name: only the `mcp.json` writer reads this. */
    enabledForMcp: (): Array<{ name: string; fields: ConnectorFields }> =>
      db
        .prepare(SELECT_ENABLED)
        .all()
        .map((row) => ({ name: String(row.name), fields: fieldsOf(row) })),

    /** One row with its credentials, enabled or not: only the probe reads this. */
    probeTarget(name: string): ConnectorFields | undefined {
      const row = raw(name);
      return row === undefined ? undefined : fieldsOf(row);
    },

    /**
     * Writes a probe result (the three probe columns only). A row deleted while the probe was in
     * flight is `not_found`, thrown before `within`: nothing is written, no audit.
     */
    recordProbe(
      name: string,
      result: { status: "ok" | "failed"; message: string | null; at: number },
      within?: Within,
    ): ConnectorView {
      return inTransaction(db, () => {
        const { changes } = db
          .prepare(RECORD_PROBE)
          .run(result.status, result.message, result.at, name);
        if (changes === 0 || changes === 0n) {
          throw new HttpError("not_found");
        }
        return finish(name, within);
      });
    },

    get(name: string): ConnectorView | undefined {
      const row = raw(name);
      return row === undefined ? undefined : toView(row);
    },

    /** POST semantics: omitted optional keys take their defaults; the 33rd connector is `bad_request`. */
    create(body: unknown, within?: Within): ConnectorView {
      const { name, fields } = parseCreate(body);
      return inTransaction(db, () => {
        if (raw(name) !== undefined) {
          throw new HttpError("conflict");
        }
        const { count } = db.prepare(COUNT).get() as { count: number };
        if (count >= MAX_CONNECTORS) {
          throw new HttpError("bad_request");
        }
        const now = Date.now();
        db.prepare(INSERT).run(
          name,
          fields.type,
          ...settings(fields),
          ...connection(fields),
          now,
          now,
        );
        return finish(name, within);
      });
    },

    /**
     * PUT semantics: whole replacement (`parseUpdate`). When `command`, `args`, `env`, `url` or
     * `headers` differs from the stored value once `null`s are resolved, the probe result is reset in
     * the same transaction; a change of `description` or `enabled` alone keeps it.
     */
    update(name: string, body: unknown, within?: Within): ConnectorView | undefined {
      return inTransaction(db, () => {
        const row = raw(name);
        if (row === undefined) {
          return undefined;
        }
        const fields = parseUpdate(body, fieldsOf(row));
        const next = connection(fields);
        db.prepare(UPDATE).run(...settings(fields), ...next, Date.now(), name);
        if (!sameConnection(storedConnection(row), next)) {
          db.prepare(RESET_PROBE).run(name);
        }
        return finish(name, within);
      });
    },

    /** Deletes the connector; disabled lists naming it are left as they are (harmless). */
    remove(name: string, within?: Within): ConnectorView | undefined {
      return inTransaction(db, () => {
        const row = raw(name);
        if (row === undefined) {
          return undefined;
        }
        const view = toView(row);
        db.prepare(DELETE).run(name);
        within?.(view);
        return view;
      });
    },
  };
}

/** The account's default disabled connectors; `[]` when it never saved any. */
export function readAccountDisabledConnectors(db: DatabaseSync, accountId: string): string[] {
  const row = db.prepare(SELECT_PREFS).get(accountId) as
    | { disabled_connectors: string }
    | undefined;
  return row === undefined ? [] : (JSON.parse(row.disabled_connectors) as string[]);
}

/** Replaces the account's default disabled connectors whole (`normalizeConnectorNames`); returns them. */
export function saveAccountDisabledConnectors(
  db: DatabaseSync,
  accountId: string,
  names: unknown,
): string[] {
  const stored = normalizeConnectorNames(names);
  db.prepare(UPSERT_PREFS).run(accountId, JSON.stringify(stored), Date.now());
  return stored;
}

function settings(fields: ConnectorFields): [string, number] {
  return [fields.description, fields.enabled ? 1 : 0];
}

function connection(fields: ConnectorFields): Connection {
  return fields.type === "stdio"
    ? [fields.command, JSON.stringify(fields.args), JSON.stringify(fields.env), null, null]
    : [null, null, null, fields.url, JSON.stringify(fields.headers)];
}

function storedConnection(row: Raw): Connection {
  const text = (value: SQLOutputValue | undefined) => (value == null ? null : String(value));
  return [text(row.command), text(row.args), text(row.env), text(row.url), text(row.headers)];
}

function sameConnection(a: Connection, b: Connection): boolean {
  return a.every((value, i) => value === b[i]);
}

/** The stored row's values, credentials included: the `existing` a PUT resolves its `null`s against. */
function fieldsOf(row: Raw): ConnectorFields {
  const description = String(row.description);
  const enabled = row.enabled === 1;
  return row.type === "stdio"
    ? {
        type: "stdio",
        description,
        enabled,
        command: String(row.command),
        args: jsonOr(row.args, []),
        env: jsonOr(row.env, {}),
      }
    : {
        type: "http",
        description,
        enabled,
        url: String(row.url),
        headers: jsonOr(row.headers, {}),
      };
}

function toView(row: Raw): ConnectorView {
  const fields = fieldsOf(row);
  const stdio = fields.type === "stdio" ? fields : null;
  const http = fields.type === "http" ? fields : null;
  return {
    name: String(row.name),
    type: fields.type,
    description: fields.description,
    enabled: fields.enabled,
    command: stdio?.command ?? null,
    args: stdio === null ? null : [...stdio.args],
    envKeys: stdio === null ? null : Object.keys(stdio.env).sort(),
    url: http?.url ?? null,
    headerKeys: http === null ? null : Object.keys(http.headers).sort(),
    probe: {
      status: row.probe_status as ConnectorView["probe"]["status"],
      at: row.probe_at === null ? null : Number(row.probe_at),
      message: row.probe_message === null ? null : String(row.probe_message),
    },
    updatedAt: Number(row.updated_at),
  };
}

/** A JSON column, or `fallback` when it is NULL (the CHECK allows NULL `args` / `env` / `headers`). */
function jsonOr<T>(value: SQLOutputValue | undefined, fallback: T): T {
  return value == null ? fallback : (JSON.parse(String(value)) as T);
}

/** This module's own transaction, the same as `experts/store.ts` and `models/store.ts`. */
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
        throw new AggregateError([error, rollbackError], "connector store rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
