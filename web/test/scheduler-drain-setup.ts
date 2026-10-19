import { configure, getConfig } from "@testing-library/react";
import {
  type SchedulerTask,
  unstable_cancelCallback,
  unstable_IdlePriority,
  unstable_scheduleCallback,
} from "scheduler";

/*
 * web 测试基建（#1541）：每个 RTL 等待（`findBy*` / `waitFor`）返回时，它所等到的状态已排进 React Scheduler
 * 的工作都已执行完——被动 effect 及其 cleanup、transition、effect 里 setState 引起的后续渲染。
 *
 * 机理：commit 发生在 promise 续延里时走 DefaultLane，被动 effect 等作为 Normal 任务排进 Scheduler；
 * 一片超过 5ms 时 Scheduler 让出，经 `setImmediate` 续投。RTL 原 `asyncWrapper` 在回调通过后只再 drain
 * 一个 `setTimeout(0)`，CPU 争用下那个 timer 先到，紧随其后的同步断言或交互便发生在 React 收敛之前。
 *
 * 做法：包住 RTL 原 `asyncWrapper`，回调 resolve 之后反复等 IdlePriority 的 Scheduler 回调，直到排空。
 * - 在 `previous` 之内等：此时 RTL 已把 `IS_REACT_ACT_ENVIRONMENT` 置为 false，与那批工作排进真实 Scheduler
 *   时的环境一致，不触发 act 警告；且屏障在 RTL 自己的 `setTimeout(0)` drain 之前，flush 出来的 effect
 *   再排的 timer 仍被那次 drain 接住。
 * - Idle：过期时间是 `maxSigned31BitInt`，Scheduler 按过期时间取最小者，所以 Idle 回调执行时，排在它之前的
 *   Normal / UserBlocking / Low 任务都已执行完。
 * - 一次 Idle 不够：effect 里 setState 引起的渲染不是同步排进 Scheduler 的，React 先 `queueMicrotask`，
 *   在微任务里才 `scheduleCallback`（react-dom `scheduleImmediateRootScheduleTask`）。那个 effect 与 Idle
 *   落在同一片时，Idle 先执行，渲染随后才入队。所以等完一个 Idle（其后的微任务已跑过）再排下一个探针：
 *   两次探针之间的 id 全是屏障自己的探针（期间没有别的任务入队）即已排空，撤掉探针返回；否则等它，再探。
 * - 并发的等待（`Promise.all([findBy…, findBy…])`）：屏障排过的探针 id 记在模块级 `ownProbes`，判断时不把
 *   别的屏障的探针算作外来工作，否则两个循环互见对方的探针、永不终止。Scheduler 一片里连跑所有同过期时间的
 *   Idle 任务，其间不跑微任务，所以已执行或已撤掉的探针也要留在集合里；集合只增不删，每个测试文件随模块重载清空。
 * - 覆盖面：已进 Scheduler 的工作，加上离 Idle 回调只隔一跳微任务就进 Scheduler 的工作（React 对 effect 内
 *   setState 的 `queueMicrotask` → `scheduleCallback`）。用户代码多绕一跳 promise 才 setState、`React.lazy`
 *   的 ping、经 react-dom `scheduleTimeout`（`setTimeout`）节流或挂起的 commit 不在其内，这些用例仍须等所断言的 DOM。
 * - `scheduler` 与 react-dom `require` 的是同一个模块实例（同一版本、只装一份）；回调抛错时 `await cb()`
 *   直接抛出，屏障被跳过，原错误原样传出。组件若永不空闲，用例在 `testTimeout` 处显式失败。
 * 屏障是兜底，不取代逐条断言「等它检查的结果本身」；不经 `asyncWrapper` 的等待（`settle()` 等）不在其内。
 * 契约由 `scheduler-drain.test.tsx` 守卫。
 */

/** 屏障排过的全部探针 id（含已执行、已撤掉的）。 */
const ownProbes = new Set<number>();

function idleProbe() {
  let task: SchedulerTask | undefined;
  const ran = new Promise<void>((resolve) => {
    task = unstable_scheduleCallback(unstable_IdlePriority, () => resolve());
  });
  if (!Number.isInteger(task?.id)) {
    throw new Error(
      "scheduler 的任务记录没有整数 id：版本已变，scheduler-drain-setup.ts 的排空判断失效",
    );
  }
  ownProbes.add((task as SchedulerTask).id);
  return { task: task as SchedulerTask, ran };
}

/** `last` 与 `next` 之间入队的只有屏障自己的探针。 */
function onlyProbesBetween(last: SchedulerTask, next: SchedulerTask) {
  for (let id = last.id + 1; id < next.id; id++) {
    if (!ownProbes.has(id)) return false;
  }
  return true;
}

async function schedulerDrained() {
  let last = idleProbe();
  await last.ran;
  for (;;) {
    const next = idleProbe();
    if (onlyProbesBetween(last.task, next.task)) {
      unstable_cancelCallback(next.task);
      return;
    }
    await next.ran;
    last = next;
  }
}

const previous = getConfig().asyncWrapper;

configure({
  asyncWrapper: (cb) =>
    previous(async () => {
      const result = await cb();
      await schedulerDrained();
      return result;
    }),
});
