// 知识库引用的纯函数（message-attachments「输入框知识库引用」的「选择」「标签」；s2c-kb-session 任务 8.2）：再选即取消、
// 按加入次序、总数上限 5（达到上限时新的不加入）、移除只去掉那一项。期望取自规格条文。
import { describe, expect, it } from "vitest";
import { KB_REF_LIMIT, removeKbRef, toggleKbRef } from "../src/features/chat/kb-refs-state.js";

const ref = (id: string) => ({ id, name: `库${id}` });

describe("toggleKbRef", () => {
  it("未引用的加到末尾，按加入次序", () => {
    expect(toggleKbRef([], ref("a"))).toEqual([ref("a")]);
    expect(toggleKbRef([ref("b")], ref("a"))).toEqual([ref("b"), ref("a")]);
  });

  it("已引用的再选一次即取消（按 id 认，其余次序不变）", () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    expect(toggleKbRef(refs, ref("b"))).toEqual([ref("a"), ref("c")]);
    expect(toggleKbRef(refs, { id: "a", name: "改过名" })).toEqual([ref("b"), ref("c")]);
  });

  it("上限为 5：已满时新的不加入，已选的仍可取消", () => {
    expect(KB_REF_LIMIT).toBe(5);
    const full = ["1", "2", "3", "4", "5"].map(ref);
    expect(toggleKbRef(full, ref("6"))).toBe(full);
    expect(toggleKbRef(full, ref("3"))).toEqual(["1", "2", "4", "5"].map(ref));
  });

  it("不改动入参", () => {
    const refs = Object.freeze([ref("a")]);
    expect(toggleKbRef(refs, ref("b"))).toEqual([ref("a"), ref("b")]);
    expect(refs).toEqual([ref("a")]);
  });
});

describe("removeKbRef", () => {
  it("去掉那一项，其余次序不变；不在其中时原样返回", () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    expect(removeKbRef(refs, "b")).toEqual([ref("a"), ref("c")]);
    expect(removeKbRef(refs, "x")).toEqual(refs);
  });
});
