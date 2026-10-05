/**
 * Issue #863 pure task-list normalisation for the omp `todo` tool's `result.details.phases`
 * (omp v18.0.10: `{op, phases:[{name, tasks:[{content, status, blocker?}]}], storage, completedTasks?}`,
 * `phases` is the complete list). No IO, no logging: persistence, de-duplication and the warn for
 * a rejected candidate belong to the supervisor's ordered persistence path.
 */
import { truncateCodepoints } from "./events.js";
import { asPlain, own } from "./file-changes.js";

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** 归一化清单：恒有 1..200 个阶段、每个阶段至少一个任务、任务总数 1..200。 */
export interface SessionTodo {
  phases: Array<{ name: string; tasks: Array<{ content: string; status: TodoStatus }> }>;
}

type Phase = SessionTodo["phases"][number];
type Task = Phase["tasks"][number];

const STATUSES: ReadonlySet<string> = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
]);
/** `name` / `content` 各自保留的码点数。 */
const MAX_TEXT_POINTS = 200;
/** 跨阶段的任务总数上限：按阶段次序、阶段内任务次序计数。 */
const MAX_TASKS = 200;

/**
 * 候选（`details.phases` 原值）→ 归一化清单。结构不合规（任一处缺字段、类型不对、未知 `status`，含
 * 会被上限截掉的部分）返回 `undefined`，调用方整帧丢弃；合规但没有任何任务返回 `null`（清单为空）。
 * 所有键只读自有属性，`blocker` 与其它多余键忽略；返回值均为新建对象，键序固定。
 */
export function normalizeTodo(candidate: unknown): SessionTodo | null | undefined {
  const valid = validItems(candidate, validPhase);
  if (valid === undefined) {
    return undefined;
  }
  const phases: Phase[] = [];
  let left = MAX_TASKS;
  for (const { name, tasks } of valid) {
    const kept = tasks.slice(0, left);
    left -= kept.length;
    if (kept.length > 0) {
      phases.push({ name: truncateCodepoints(name, MAX_TEXT_POINTS), tasks: kept.map(capTask) });
    }
  }
  return phases.length === 0 ? null : { phases };
}

function capTask({ content, status }: Task): Task {
  return { content: truncateCodepoints(content, MAX_TEXT_POINTS), status };
}

/** 数组且每个下标都是自有元素（稀疏空洞不合规）并通过 `validItem`；否则 `undefined`。 */
function validItems<T>(
  value: unknown,
  validItem: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.hasOwn(value, index) ? validItem(value[index]) : undefined;
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function validPhase(value: unknown): Phase | undefined {
  const record = asPlain(value);
  if (record === undefined) {
    return undefined;
  }
  const name = own(record, "name");
  const tasks = validItems(own(record, "tasks"), validTask);
  return typeof name === "string" && tasks !== undefined ? { name, tasks } : undefined;
}

function validTask(value: unknown): Task | undefined {
  const record = asPlain(value);
  if (record === undefined) {
    return undefined;
  }
  const content = own(record, "content");
  const status = own(record, "status");
  return typeof content === "string" && isStatus(status) ? { content, status } : undefined;
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.has(value);
}
