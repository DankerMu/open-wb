import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./chat-stream-support.js";

/*
 * verification-harness「RTL 等待返回时 React Scheduler 已排空」（#1541）的契约，屏障本身见
 * `scheduler-drain-setup.ts`。第一例去掉该 setup 时每次都红：第二次渲染里的忙等发生在 RTL 收尾的
 * `setTimeout(0)` 排入之后、且长于 Scheduler 的 5ms 切片，所以那个 timer 必然先于让出后的被动 effect 到期。
 * 若日后装出第二份 `scheduler`（屏障等的不是 react-dom 那个实例），这一例同样变红。
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
 * `gate` 落定后在续延里（act 之外）显示「已就绪」；这次 commit 的被动 effect 再触发第二次渲染（含 `Busy`），
 * 第二次 commit 的被动 effect 调 `onSecondCommit`。
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
      {second ? <Busy /> : null}
    </p>
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
});
