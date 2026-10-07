// `useWorkspaceList` 的静默读取（列表事件触发的那一次）：失败时不改变已有的呈现。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkspaceList } from "../src/features/chat/workspace-list.js";
import type { ApiClient } from "../src/lib/api.js";
import { ApiError } from "../src/lib/api.js";
import { deferred } from "./chat-stream-support.js";

type Listing = Awaited<ReturnType<ApiClient["listWorkspaces"]>>;

const FAILED = "读取失败";
const SPACE = { id: "1".repeat(32), name: "W1", dir: "W1", root: "/srv/w1", createdAt: 1 };
const OTHER = { ...SPACE, id: "2".repeat(32), name: "W2" };

function mount() {
  const reads: ReturnType<typeof deferred<Listing>>[] = [];
  const client = {
    listWorkspaces() {
      const read = deferred<Listing>();
      reads.push(read);
      return read.promise;
    },
  } as unknown as ApiClient;
  const { result } = renderHook(() => useWorkspaceList(client));
  const refresh = (silent?: boolean) => act(() => result.current.refresh(client, silent));
  const settle = (index: number, outcome: Listing | Error) =>
    act(async () => {
      if (outcome instanceof Error) reads[index]?.reject(outcome);
      else reads[index]?.resolve(outcome);
      await Promise.resolve();
    });
  const shown = () => ({ error: result.current.error, workspaces: result.current.workspaces });
  return { reads, refresh, settle, shown };
}

const failure = () => new ApiError(500, "internal", FAILED);

describe("useWorkspaceList 静默读取", () => {
  it("已有结果时：静默读取开始不清空，失败保留结果且无文案，成功则写入", async () => {
    const { refresh, settle, shown } = mount();
    refresh();
    await settle(0, { workspaces: [SPACE] });
    expect(shown()).toEqual({ error: null, workspaces: [SPACE] });

    refresh(true);
    expect(shown()).toEqual({ error: null, workspaces: [SPACE] });
    await settle(1, failure());
    expect(shown()).toEqual({ error: null, workspaces: [SPACE] });

    refresh(true);
    await settle(2, { workspaces: [OTHER] });
    expect(shown()).toEqual({ error: null, workspaces: [OTHER] });
  });

  it("已是失败文案时：静默读取开始不回到读取在途，失败后文案仍在", async () => {
    const { refresh, settle, shown } = mount();
    refresh();
    await settle(0, failure());
    expect(shown()).toEqual({ error: FAILED, workspaces: null });

    refresh(true);
    expect(shown()).toEqual({ error: FAILED, workspaces: null });
    await settle(1, new ApiError(500, "internal", "另一条"));
    expect(shown()).toEqual({ error: FAILED, workspaces: null });
  });

  it("顶替一次尚无结果的读取时：静默读取的失败记为失败，不停在读取在途", async () => {
    const { reads, refresh, settle, shown } = mount();
    refresh();
    refresh(true);
    expect(reads).toHaveLength(2);
    expect(shown()).toEqual({ error: null, workspaces: null });

    await settle(0, { workspaces: [SPACE] });
    expect(shown()).toEqual({ error: null, workspaces: null });
    await settle(1, failure());
    expect(shown()).toEqual({ error: FAILED, workspaces: null });
  });
});
