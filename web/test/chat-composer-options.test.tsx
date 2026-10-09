// `useComposerOptions`（每个 client 取一次、失败后在下一次换选择时重取）与欢迎态三项内存选择的 hook 层用例。
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useComposerOptions } from "../src/features/chat/composer-options.js";
import { useWelcomeOptions } from "../src/features/chat/welcome-options.js";
import { ApiError } from "../src/lib/api.js";
import type { ComposerOptions } from "../src/lib/composer-contract.js";
import { deferred } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const CAPPED: ComposerOptions = { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: ["always-ask"] };

function fakeClient() {
  const reads: ReturnType<typeof deferred<ComposerOptions>>[] = [];
  const getComposerOptions = vi.fn(() => {
    const read = deferred<ComposerOptions>();
    reads.push(read);
    return read.promise;
  });
  return { getComposerOptions, reads };
}

type Fake = ReturnType<typeof fakeClient>;

function mount(strict = false) {
  const client = fakeClient();
  const { rerender, result } = renderHook(
    (props: { client: Fake; sessionId: string | null }) =>
      useComposerOptions(props.client, props.sessionId),
    {
      initialProps: { client, sessionId: null as string | null },
      ...(strict ? { wrapper: StrictMode } : {}),
    },
  );
  let current = client;
  const settle = (fake: Fake, index: number, outcome: ComposerOptions | Error) =>
    act(async () => {
      if (outcome instanceof Error) fake.reads[index]?.reject(outcome);
      else fake.reads[index]?.resolve(outcome);
      await Promise.resolve();
    });
  return {
    client,
    result,
    settle,
    select: (sessionId: string | null) => rerender({ client: current, sessionId }),
    swap(next: Fake, sessionId: string | null = null) {
      current = next;
      rerender({ client: next, sessionId });
    },
  };
}

const failure = () => new ApiError(500, "internal", "读取失败");

describe("useComposerOptions", () => {
  it("同一个 client：同值重渲染与 A→B→欢迎态→A 恰取一次，结果可用", async () => {
    const { client, result, select, settle } = mount();
    expect(result.current).toBeNull();
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    for (const sessionId of [A, B, null, A]) {
      select(sessionId);
      expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    }
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 的双挂载恰取一次，结果可用", async () => {
    const { client, result, settle } = mount(true);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("失败后：同值重渲染不重取，切到另一个会话恰重取一次，成功后不再取", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    await settle(client, 0, failure());
    expect(result.current).toBeNull();
    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);

    select(B);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
    await settle(client, 1, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);

    select(A);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
  });

  it("失败后回到欢迎态恰重取一次；401 与其它失败同样处理", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    await settle(client, 0, new ApiError(401, "unauthorized", "未登录"));
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    await settle(client, 1, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
  });

  it("连续失败：每次换选择各重取一次，失败、失败、成功共三次", async () => {
    const { client, result, select, settle } = mount();
    await settle(client, 0, failure());
    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    await settle(client, 1, failure());
    expect(result.current).toBeNull();
    select(B);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);
    await settle(client, 2, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);
  });

  it("在途时换选择不发第二次，也不排队重取", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    select(B);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("换 client：立即回到 null 并重新取，旧 client 迟到的结果不落地", async () => {
    const { client, result, settle, swap } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);

    const next = fakeClient();
    swap(next);
    expect(result.current).toBeNull();
    expect(next.getComposerOptions).toHaveBeenCalledTimes(1);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);

    // 旧 client 在途时被换下：它迟到的成功不落地，也不盖掉新 client 已落定的结果。
    const third = fakeClient();
    swap(third);
    expect(result.current).toBeNull();
    await settle(third, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    await settle(next, 0, CAPPED);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    swap(third, A);
    expect(third.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("旧 client 迟到的失败不把新 client 的在途记录改成可重取", async () => {
    const { client, result, settle, swap } = mount();
    const next = fakeClient();
    swap(next);
    await settle(client, 0, failure());
    swap(next, A);
    expect(next.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(next, 0, CAPPED);
    expect(result.current).toBe(CAPPED);
  });
});

describe("useWelcomeOptions 的三项内存选择", () => {
  const mountWelcome = () => renderHook(() => useWelcomeOptions(null, null)).result;

  it("未选时 picked 为空，createBody() 恰为 {scene}", () => {
    const result = mountWelcome();
    expect(result.current.picked).toStrictEqual({});
    expect(result.current.createBody()).toStrictEqual({ scene: "office" });
  });

  it("pick 合并所选键，createBody() 恰含这些键", () => {
    const result = mountWelcome();
    act(() => result.current.pick({ approvalMode: "yolo" }));
    expect(result.current.createBody()).toStrictEqual({ scene: "office", approvalMode: "yolo" });
    act(() => result.current.pick({ modelId: "m2", reasoningEffort: "low" }));
    expect(result.current.picked).toStrictEqual({
      approvalMode: "yolo",
      modelId: "m2",
      reasoningEffort: "low",
    });
    expect(result.current.createBody()).toStrictEqual({
      scene: "office",
      approvalMode: "yolo",
      modelId: "m2",
      reasoningEffort: "low",
    });
  });

  it("pick 的值为 undefined 时删除该键，其余键保留", () => {
    const result = mountWelcome();
    act(() => result.current.pick({ modelId: "m2", reasoningEffort: "low" }));
    act(() => result.current.pick({ modelId: "m3", reasoningEffort: undefined }));
    expect(Object.keys(result.current.picked)).toEqual(["modelId"]);
    expect(Object.keys(result.current.createBody()).sort()).toEqual(["modelId", "scene"]);
    expect(result.current.createBody()).toStrictEqual({ scene: "office", modelId: "m3" });
  });
});
