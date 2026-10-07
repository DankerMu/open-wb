import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCollapsedGroups,
  readSessionGrouping,
  writeCollapsedGroups,
  writeSessionGrouping,
} from "../src/features/chat/session-list-prefs.js";

const GROUPING_KEY = "workbuddy-session-grouping";
const COLLAPSED_KEY = "workbuddy-session-collapsed";
const W1 = "1".repeat(32);

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function blockReads() {
  return vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
}

function blockWrites() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
}

describe("分组方式", () => {
  it("缺失时按 workspace", () => {
    expect(readSessionGrouping()).toBe("workspace");
  });

  it("合法值原样读出", () => {
    window.localStorage.setItem(GROUPING_KEY, "time");
    expect(readSessionGrouping()).toBe("time");
    window.localStorage.setItem(GROUPING_KEY, "workspace");
    expect(readSessionGrouping()).toBe("workspace");
  });

  it.each(["", "Time", " time", "space", "null", '"time"', "toString", "__proto__"])(
    "非法值 %j 按 workspace",
    (stored) => {
      window.localStorage.setItem(GROUPING_KEY, stored);
      expect(readSessionGrouping()).toBe("workspace");
    },
  );

  it("写入存的是裸字符串，往返一致", () => {
    writeSessionGrouping("time");
    expect(window.localStorage.getItem(GROUPING_KEY)).toBe("time");
    expect(readSessionGrouping()).toBe("time");
    writeSessionGrouping("workspace");
    expect(window.localStorage.getItem(GROUPING_KEY)).toBe("workspace");
    expect(readSessionGrouping()).toBe("workspace");
  });

  it("读取抛错按 workspace，不外泄异常", () => {
    window.localStorage.setItem(GROUPING_KEY, "time");
    const getItem = blockReads();
    expect(readSessionGrouping()).toBe("workspace");
    expect(getItem).toHaveBeenCalledWith(GROUPING_KEY);
  });

  it("写入抛错静默", () => {
    const setItem = blockWrites();
    expect(() => writeSessionGrouping("time")).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(GROUPING_KEY, "time");
  });
});

describe("折叠的分组键", () => {
  it("缺失时为空数组", () => {
    expect(readCollapsedGroups()).toEqual([]);
  });

  it("合法值原样读出：固定键与工作空间 id，保持顺序", () => {
    const keys = ["pinned", W1, "temporary", "unknown", "today", "week", "earlier"];
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys));
    expect(readCollapsedGroups()).toEqual(keys);
    window.localStorage.setItem(COLLAPSED_KEY, "[]");
    expect(readCollapsedGroups()).toEqual([]);
  });

  it.each(["", "{", "[", "pinned", "['pinned']", '["pinned",]', "undefined"])(
    "解析失败 %j 按空数组，不外泄异常",
    (stored) => {
      window.localStorage.setItem(COLLAPSED_KEY, stored);
      expect(readCollapsedGroups()).toEqual([]);
    },
  );

  it.each(["null", "true", "7", '"pinned"', '{"0":"pinned","length":1}', "{}"])(
    "不是数组 %j 按空数组",
    (stored) => {
      window.localStorage.setItem(COLLAPSED_KEY, stored);
      expect(readCollapsedGroups()).toEqual([]);
    },
  );

  it.each(['["pinned",1]', "[null]", '[["pinned"]]', '["today",{"k":"week"}]', "[true]"])(
    "含非字符串元素 %j 按空数组",
    (stored) => {
      window.localStorage.setItem(COLLAPSED_KEY, stored);
      expect(readCollapsedGroups()).toEqual([]);
    },
  );

  it("写入存的是 JSON 字符串数组，往返一致", () => {
    writeCollapsedGroups(["pinned", W1]);
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe(`["pinned","${W1}"]`);
    expect(readCollapsedGroups()).toEqual(["pinned", W1]);
    writeCollapsedGroups([]);
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("[]");
    expect(readCollapsedGroups()).toEqual([]);
  });

  it("读取抛错按空数组，不外泄异常", () => {
    window.localStorage.setItem(COLLAPSED_KEY, '["pinned"]');
    const getItem = blockReads();
    expect(readCollapsedGroups()).toEqual([]);
    expect(getItem).toHaveBeenCalledWith(COLLAPSED_KEY);
  });

  it("写入抛错静默", () => {
    const setItem = blockWrites();
    expect(() => writeCollapsedGroups(["pinned"])).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(COLLAPSED_KEY, '["pinned"]');
  });
});

describe("两个键互不影响", () => {
  it("各写各的键", () => {
    writeSessionGrouping("time");
    writeCollapsedGroups(["today"]);
    expect(window.localStorage.length).toBe(2);
    expect(readSessionGrouping()).toBe("time");
    expect(readCollapsedGroups()).toEqual(["today"]);
  });
});
