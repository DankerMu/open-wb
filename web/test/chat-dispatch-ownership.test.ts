// message-attachments「欢迎态暂存与首次发送」的「上传落定后的归属判定」与场景「上传落定时已离开该会话」（#1277）。
//
// seam：抽出的归属判定 `ownsDispatch`（纯函数）加一条源码断言，不是整页。整页层造不出场景要的时序（实测）：
// 切走会话时 `requestedSessionRef` 在渲染阶段改写、中止在 passive effect 里，但会话页在这次提交的 layout
// effect 里另排了同步更新，React 在同一次 `commitRoot` 里就把 passive effect 冲刷掉（调用栈为
// `flushSpawnedWork` → `performSyncWorkOnRoot` → `flushPendingEffects`），提交与中止之间没有微任务检查点，
// 在提交阶段同步应答的上传要到中止之后才落定；剩下的窗口只在并发渲染让出时间片时出现，测试里排不出确定的
// 次序。`turn-actions.ts` 按 chat-web「会话页源码模块划分」只许 `use-chat-session.ts` 导入，所以也不能
// 单独挂它的 hook。于是：判定本身按值测，三处落定都经它则由源码断言守住。
import { describe, expect, it } from "vitest";
import { ownsDispatch } from "../src/features/chat/ownership.js";
import { createApiClient } from "../src/lib/api.js";
import { readRepoFile, stripTsComments } from "./ui-support.js";

const S = "d".repeat(32);
const OTHER = "a".repeat(32);
const client = createApiClient();

type Owner = Parameters<typeof ownsDispatch>[0];
type Page = Parameters<typeof ownsDispatch>[1];

/** 一次已建出会话 `S`、尚未受理的首次发送，以及仍停在它上面的页面。 */
function fixture(): { owner: Owner; page: Page } {
  return {
    owner: {
      client,
      controller: new AbortController(),
      createSendGeneration: 7,
      mutationGeneration: 3,
      sessionId: S,
    },
    page: {
      client,
      mounted: true,
      mutationGeneration: 3,
      pending: {
        accepted: false,
        client,
        generation: 7,
        originSessionId: null,
        prompt: "看看",
        sessionId: S,
      },
      requestedSessionId: S,
    },
  };
}

describe("上传落定时已离开该会话：派发的归属判定", () => {
  it("六项都成立时归本页所有", () => {
    const { owner, page } = fixture();
    expect(ownsDispatch(owner, page)).toBe(true);
  });

  it("当前请求的会话已是另一个已有会话、这次发送尚未中止：不归本页所有", () => {
    const { owner, page } = fixture();
    expect(owner.controller.signal.aborted).toBe(false);
    expect(ownsDispatch(owner, { ...page, requestedSessionId: OTHER })).toBe(false);
    expect(ownsDispatch(owner, { ...page, requestedSessionId: null })).toBe(false);
  });

  it.each<[string, (page: Page) => Page]>([
    ["页面已卸载", (page) => ({ ...page, mounted: false })],
    ["已被另一次派发取代", (page) => ({ ...page, mutationGeneration: 4 })],
    ["首次发送的登记已清掉", (page) => ({ ...page, pending: null })],
    [
      "首次发送的登记已是另一次",
      (page) => ({ ...page, pending: page.pending && { ...page.pending, generation: 8 } }),
    ],
    ["API 客户端（账号）已换", (page) => ({ ...page, client: createApiClient() })],
  ])("%s、这次发送尚未中止：不归本页所有", (_, move) => {
    const { owner, page } = fixture();
    expect(ownsDispatch(owner, move(page))).toBe(false);
    expect(owner.controller.signal.aborted).toBe(false);
  });

  it("这次发送已被中止：不归本页所有", () => {
    const { owner, page } = fixture();
    owner.controller.abort();
    expect(ownsDispatch(owner, page)).toBe(false);
  });

  it("源码断言：`dispatchPrompt` 里 prompt 落定、快照落定、上传落定三处都只经这一个判定，没有只查 `aborted` 的落定", () => {
    const code = stripTsComments(readRepoFile("web/src/features/chat/turn-actions.ts"));
    const start = code.indexOf("const dispatchPrompt = useCallback(");
    const end = code.indexOf("const ownsSessionWrite = useCallback(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dispatch = code.slice(start, end);
    expect(dispatch.match(/ownsDispatch\(/g)).toHaveLength(1);
    expect(dispatch.match(/!owned\(\)/g)).toHaveLength(3);
    expect(dispatch).not.toContain("signal.aborted");
    const settled = dispatch.slice(dispatch.indexOf("staged.done.then("));
    expect(settled.indexOf("!owned()")).toBeGreaterThan(-1);
    expect(settled.indexOf("!owned()")).toBeLessThan(settled.indexOf("send()"));
    expect(settled.indexOf("!owned()")).toBeLessThan(settled.indexOf("unaccepted("));
  });
});
