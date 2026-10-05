import { hasExactlyKeys } from "../../lib/api-json.js";
import { type ChatMessageSnapshot, parseTodo } from "../../lib/session-contract.js";

type ChatTodo = ChatMessageSnapshot["todo"];

export type ChatTodoEvent = {
  type: "todo.updated";
  data: { messageId: number; todo: ChatTodo };
};

/**
 * Strict key set `{messageId, todo}`: a safe-integer id and `todo` under the rule of the
 * snapshot's `todo` (a well-formed list or `null`), else `undefined`.
 */
export function decodeTodoUpdated(value: unknown): ChatTodoEvent | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "todo"]) ||
    typeof value.messageId !== "number" ||
    !Number.isSafeInteger(value.messageId)
  ) {
    return undefined;
  }
  const todo = parseTodo(value.todo);
  return todo === undefined
    ? undefined
    : { type: "todo.updated", data: { messageId: value.messageId, todo } };
}

/**
 * Replaces the session's task list wholesale and leaves every other field as it is; a list equal
 * value for value to the current one returns `state` itself. The input is not modified.
 */
export function setTodo<S extends { todo: ChatTodo }>(state: S, todo: ChatTodo): S {
  return sameTodo(state.todo, todo) ? state : { ...state, todo };
}

function sameTodo(a: ChatTodo, b: ChatTodo): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.phases.length === b.phases.length &&
    a.phases.every((phase, index) => {
      const other = b.phases[index];
      return (
        other !== undefined &&
        phase.name === other.name &&
        phase.tasks.length === other.tasks.length &&
        phase.tasks.every((task, at) => {
          const peer = other.tasks[at];
          return task.content === peer?.content && task.status === peer.status;
        })
      );
    })
  );
}
