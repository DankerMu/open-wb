import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./chat-stream-support.js";

/*
 * verification-harness「RTL 等待返回时 React Scheduler 已排空」（#1541）的契约，屏障本身见
 * `scheduler-drain-setup.ts`。两次渲染都忙等、且长于 Scheduler 的 5ms 切片，所以每次 commit 之后 Scheduler
 * 必让出，被动 effect 续投到下一个 `setImmediate`：
 * - 去掉该 setup 时第一例每次都红：第二次渲染的忙等发生在 RTL 收尾的 `setTimeout(0)` 排入之后，那个 timer
 *   必然先于第二次的被动 effect 到期。若日后装出第二份 `scheduler`（屏障等的不是 react-dom 那个实例），同样变红。
 * - 屏障只等一次 Idle 时第一例也红：第一次 commit 后让出，第一个探针排在被动 effect 1 之前；effect 1 与探针
 *   同片执行，它的 setState 经微任务才排第二次渲染，此时探针已跑完。
 * - 第三例：两个等待并发时屏障不互相卡死。
 */

afterEach(cleanup);

/** 渲染时忙等 8ms：长于 Scheduler 的 `frameInterval`（5ms），commit 之后 Scheduler 必让出。 */
function Busy() {
  const end = performance.now() + 8;
  while (performance.now() < end) {
    // 忙等，不让出事件循环。
  }
  return null;
}

/**
 * `gate` 落定后在续延里（act 之外）显示「已就绪」；这次 commit 的被动 effect 再触发第二次渲染，
 * 第二次 commit 的被动 effect 调 `onSecondCommit`。两次渲染都含 `Busy`。
 */
function Cascade({ gate, onSecondCommit }: { gate: Promise<void>; onSecondCommit: () => void }) {
  const [ready, setReady] = useState(false);
  const [second, setSecond] = useState(false);
  useEffect(() => {
    void gate.then(() => setReady(true));
  }, [gate]);
  useEffect(() => {
    if (ready) setSecond(true);
  }, [ready]);
  useEffect(() => {
    if (second) onSecondCommit();
  }, [second, onSecondCommit]);
  if (!ready) return null;
  return (
    <p>
      已就绪
      <Busy />
    </p>
  );
}

/** `gate` 落定后在续延里（act 之外）一次 commit 同时显示两个标记。 */
function Pair({ gate }: { gate: Promise<void> }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void gate.then(() => setReady(true));
  }, [gate]);
  if (!ready) return null;
  return (
    <>
      <p>甲</p>
      <p>乙</p>
    </>
  );
}

describe("RTL 等待返回时，所等 commit 经 React Scheduler 级联出的工作已执行完", () => {
  it("findByText 之后同步断言：第二次 commit 的被动 effect 已恰执行一次", async () => {
    const gate = deferred<void>();
    const onSecondCommit = vi.fn();
    render(<Cascade gate={gate.promise} onSecondCommit={onSecondCommit} />);
    expect(screen.queryByText("已就绪")).toBeNull();

    gate.resolve();
    expect(await screen.findByText("已就绪")).toBeTruthy();
    expect(onSecondCommit).toHaveBeenCalledTimes(1);
  });

  it("waitFor 的回调始终抛错：超时后以回调抛出的那个错误拒绝", async () => {
    const failure = new Error("条件从未满足");
    await expect(
      waitFor(
        () => {
          throw failure;
        },
        { timeout: 100 },
      ),
    ).rejects.toBe(failure);
  });

  it("两个 findByText 并发：两个屏障都返回，不互相卡死", { timeout: 2000 }, async () => {
    const gate = deferred<void>();
    render(<Pair gate={gate.promise} />);
    expect(screen.queryByText("甲")).toBeNull();

    gate.resolve();
    const [a, b] = await Promise.all([screen.findByText("甲"), screen.findByText("乙")]);
    expect(a.textContent).toBe("甲");
    expect(b.textContent).toBe("乙");
  });
});
