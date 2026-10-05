/**
 * Issue #864 task-list persistence (session-todo「任务清单持久化」): the only reader and writer of
 * `chat_sessions.todo`. A candidate (`details.phases` of a `todo` tool result, raw from the pure
 * reducer) is validated and normalised here, compared with the stored text and written as compact
 * JSON, or SQL NULL for an empty list. The write changes that one column only: `updated_at`,
 * `status` and `title` stay, so a task-list update never reorders the session list.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeTodo, type SessionTodo } from "./session-todo.js";
import { requireChanges } from "./store-branch.js";

/** One dropped candidate, a warn-level record. Carries no task text. */
export interface TodoRejection {
  level: "warn";
  event: "session_todo_rejected";
  assistantMessageId: number;
}

/** Synchronous observation port; a throwing sink never turns the drop into a fault. */
export type TodoWarn = (record: TodoRejection) => void;

export interface SessionTodoOptions {
  /** Warn sink for a structurally invalid candidate; omitted → discarded. */
  warn?: TodoWarn | undefined;
}

export interface SessionTodoStore {
  /**
   * The value to publish, wrapped (`null` is a cleared list); `undefined` when nothing was written:
   * the candidate was invalid (one warn) or equals the stored value. Throws off exactly one row.
   */
  storeTodo(
    assistantMessageId: number,
    candidate: unknown,
  ): { todo: SessionTodo | null } | undefined;
  /** The stored list of this owner's session; `null` for a stored NULL or no such row. */
  readTodo(sessionId: string, ownerId: string): SessionTodo | null;
}

interface TodoRow {
  id: string;
  todo: string | null;
}

const SELECT_BY_MESSAGE =
  "SELECT s.id, s.todo FROM chat_sessions AS s JOIN chat_messages AS m ON m.session_id = s.id WHERE m.id = ?";
const SELECT_OWNED = "SELECT id, todo FROM chat_sessions WHERE id = ? AND owner_id = ?";
const SET_TODO = "UPDATE chat_sessions SET todo = ? WHERE id = ?";

export function createSessionTodoStore(
  db: DatabaseSync,
  options: SessionTodoOptions,
): SessionTodoStore {
  return {
    storeTodo(assistantMessageId, candidate) {
      const todo = normalizeTodo(candidate);
      if (todo === undefined) {
        reject(options.warn, assistantMessageId);
        return undefined;
      }
      const row = db.prepare(SELECT_BY_MESSAGE).get(assistantMessageId) as unknown as
        | TodoRow
        | undefined;
      if (row === undefined) {
        throw new Error("session todo write: no session for the assistant message");
      }
      const text = todo === null ? null : JSON.stringify(todo);
      if (text === row.todo) {
        return undefined;
      }
      requireChanges(db.prepare(SET_TODO).run(text, row.id).changes, 1, "session todo");
      return { todo };
    },

    readTodo(sessionId, ownerId) {
      const row = db.prepare(SELECT_OWNED).get(sessionId, ownerId) as unknown as
        | TodoRow
        | undefined;
      return row === undefined || row.todo === null ? null : (JSON.parse(row.todo) as SessionTodo);
    },
  };
}

function reject(warn: TodoWarn | undefined, assistantMessageId: number): void {
  try {
    warn?.({ level: "warn", event: "session_todo_rejected", assistantMessageId });
  } catch {
    // Observation only: the candidate is dropped either way and the turn goes on.
  }
}
