/**
 * Issue #1107 侧边栏随助手的改动刷新（tasks 24.3，分摊的 24.4）：workspace-sidebar「随助手改动刷新」的
 * 四个场景。接缝：真实外壳里的整页（桩掉的 `fetch` 与事件连接），事件经假的事件连接推入；请求取自
 * `fetch` 桩的调用记录。期望值是规格里的字面量（哪几层各请求一次、300 毫秒）。
 *
 * 定时器：打开侧边栏、展开目录、选文件与 `goLive()` 都在真定时器下做完（它们的等待走 `setTimeout`），
 * 之后才换成假的 `setTimeout` / `clearTimeout`；其后只用同步的 `send(...)` 与 `advance(n)`，断言同步。
 * R2、R5 不看时间边界，用真定时器加 `waitFor`。
 */
import "./radix-platform.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goLive, PROJ, toolStep, turn, write } from "./chat-page-file-changes-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import {
  CLOSE,
  dir,
  file,
  fileOf,
  listing,
  openChanges,
  rowNames,
  settled,
  sidebarButton,
  sidebarRegion,
  treeOf,
  treeRequests,
} from "./chat-workspace-sidebar-support.js";
import { type FetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";

const MARK = "本会话已改动";
const TREE = "工作空间目录树";
const PREVIEW = "文件预览";
const FAILED = "目录读取失败";
const ROOT = treeOf(PROJ.id);
const OUT = treeOf(PROJ.id, "out");
const DOCS = treeOf(PROJ.id, "docs");
const DATA = treeOf(PROJ.id, "data");
const A_MD = fileOf(PROJ.id, "out/a.md");
const README = fileOf(PROJ.id, "readme.md");
/** 合并窗口，规格的字面量。 */
const WINDOW = 300;

afterEach(async () => {
  vi.useRealTimers();
  await cleanupSessionMeta();
});

type Send = Awaited<ReturnType<typeof goLive>>;

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole<HTMLButtonElement>("button", { name });

/** 预览区的全部文本（源码着色后一行拆成多个元素，所以比容器的 `textContent`）。 */
const previewText = (scope: HTMLElement) =>
  within(scope).getByRole("region", { name: PREVIEW }).textContent;

/** 行按钮经 `aria-describedby` 得到的描述；没有该属性时为 `null`。 */
function description(row: HTMLElement) {
  const id = row.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? "");
}

/** 对 PROJ 发出的 `file` 请求，按调用顺序。 */
function fileRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.startsWith(`/api/workspaces/${PROJ.id}/file?`));
}

/**
 * 从调用这一刻起新发出的 `tree` 与 `file` 请求（各自排好序，同一地址请求两次就出现两次）：一轮刷新
 * 里各层的先后不是规格的内容。
 */
function requestsSince(fetchMock: FetchMock) {
  const trees = treeRequests(fetchMock).length;
  const files = fileRequests(fetchMock).length;
  return () => ({
    files: fileRequests(fetchMock).slice(files).sort(),
    trees: treeRequests(fetchMock).slice(trees).sort(),
  });
}

const NONE = { files: [], trees: [] };

/** 换成假的 `setTimeout` / `clearTimeout`；此后页面里的等待只能靠 `advance` 推进。 */
function freezeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** 假定时器下把时间推进 `ms` 毫秒，到点的回调与随后的渲染都在 act 里跑完。 */
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/** 假定时器下让已发出的请求、它们的应答体与随后的渲染落地：时间不前进。 */
async function land() {
  for (let turns = 0; turns < 5; turns += 1) await advance(0);
}

/** 一个从开始到结束的步骤：`files` 非空时在 `step.end` 之前推 `files.changed`（服务端的次序）。 */
function endedStep(send: Send, stepId: number, name: string, ...files: ReturnType<typeof write>[]) {
  send("step.start", { stepId, name, detail: `${name} args` });
  if (files.length > 0) send("files.changed", { stepId, files });
  send("step.end", { stepId, status: "done", output: "ok" });
}

/** 假定时器下点顶栏按钮打开侧边栏，等到根目录的 `readme.md` 落地；返回地标。 */
async function reopen() {
  fireEvent.click(sidebarButton());
  await land();
  const region = sidebarRegion();
  if (!region) throw new Error("侧边栏没有打开");
  expect(button(region, "readme.md")).toBeTruthy();
  return region;
}

describe("随助手改动刷新", () => {
  it("R1 步骤结束触发局部刷新：running 步骤的 changes 不触发；两个步骤先后结束，第 299 毫秒前没有请求，第 300 毫秒恰一轮——根与 out 各一次、src 与 docs 没有、out/a.md 的预览重取一次且仍是源码，b.md 出现并带标记", async () => {
    const current = { body: "# 第一份", out: [file("a.md")] };
    const { fetchMock, region } = await openChanges(turn("running"), {
      [ROOT]: listing("", [dir("docs"), dir("out"), dir("src"), file("readme.md")]),
      [DOCS]: listing("docs", [file("guide.md")]),
      [OUT]: () => jsonResponse({ path: "out", entries: current.out }),
      [A_MD]: () => textPreviewResponse(current.body),
    });
    const send = await goLive();
    fireEvent.click(button(region, "展开 out"));
    fireEvent.click(button(region, "展开 docs"));
    await within(region).findByRole("button", { name: "guide.md" });
    fireEvent.click(await within(region).findByRole("button", { name: "a.md" }));
    fireEvent.click(await within(region).findByRole("button", { name: "查看源码" }));
    await waitFor(() => expect(previewText(region)).toContain("# 第一份"));
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT, DOCS]);
    expect(fileRequests(fetchMock)).toStrictEqual([A_MD]);
    const since = requestsSince(fetchMock);
    freezeTimers();

    // 步骤还在跑：它的 `changes` 不算，过了一个窗口也没有请求。
    send("step.start", { stepId: 1, name: "write", detail: "write args" });
    send("files.changed", { stepId: 1, files: [write("out/a.md"), write("src/x.ts")] });
    await advance(WINDOW);
    expect(since()).toStrictEqual(NONE);

    current.body = "# 第二份";
    current.out = [file("a.md"), file("b.md")];
    send("step.end", { stepId: 1, status: "done", output: "ok" });
    await advance(100);
    endedStep(send, 2, "write", write("out/b.md"));
    send("text.delta", { delta: "写好了" });
    await advance(199);
    expect(since()).toStrictEqual(NONE);

    await advance(1);
    const ROUND = { files: [A_MD], trees: [ROOT, OUT].sort() };
    expect(since()).toStrictEqual(ROUND);

    await land();
    expect(rowNames(region)).toStrictEqual([
      "项目",
      "docs",
      "guide.md",
      "out",
      "a.md",
      "b.md",
      "src",
      "readme.md",
    ]);
    expect(description(button(region, "b.md"))).toBe(MARK);
    expect(previewText(region)).toContain("# 第二份");
    expect(previewText(region)).not.toContain("# 第一份");
    expect(button(region, "渲染视图")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "查看源码" })).toBeNull();
    expect(button(region, "a.md").getAttribute("aria-current")).toBe("true");
    expect(button(region, "折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(button(region, "折叠 docs").getAttribute("aria-expanded")).toBe("true");
    expect(button(region, "展开 src").getAttribute("aria-expanded")).toBe("false");

    // 恰一轮：再过一个窗口也没有第二轮。
    await advance(WINDOW);
    expect(since()).toStrictEqual(ROUND);
  });

  it("R1b 当前预览的文件不在这批改动里：根与 out 各重列一次，file 请求数不变", async () => {
    const { fetchMock, region } = await openChanges(turn("running"));
    const send = await goLive();
    fireEvent.click(button(region, "展开 out"));
    await within(region).findByRole("button", { name: "index.html" });
    fireEvent.click(button(region, "readme.md"));
    await waitFor(() => expect(previewText(region)).toContain("自述正文"));
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([README]);
    const since = requestsSince(fetchMock);
    freezeTimers();

    endedStep(send, 1, "write", write("out/b.md"));
    await advance(WINDOW);

    expect(since()).toStrictEqual({ files: [], trees: [ROOT, OUT].sort() });
    await land();
    expect(previewText(region)).toContain("自述正文");
    expect(button(region, "readme.md").getAttribute("aria-current")).toBe("true");
  });

  it("R1c 历史里已经改过的 readme.md 被后一个步骤再改：仍触发一轮并重取它的预览", async () => {
    const { fetchMock, region } = await openChanges(
      turn("running", { steps: [toolStep(1, 0, "write", [write("readme.md")])] }),
    );
    const send = await goLive();
    fireEvent.click(button(region, "readme.md"));
    await waitFor(() => expect(previewText(region)).toContain("自述正文"));
    await settled();
    const since = requestsSince(fetchMock);
    freezeTimers();

    endedStep(send, 2, "edit", write("readme.md"));
    await advance(WINDOW - 1);
    expect(since()).toStrictEqual(NONE);

    await advance(1);
    expect(since()).toStrictEqual({ files: [README], trees: [ROOT] });
  });

  it("R2 回合结束兜底：回合里只有一个没有 changes 的 bash 步骤，回合结束后根与 data 各重列一次，raw.csv 出现且没有标记", async () => {
    const current = { data: [file("old.csv")] };
    const { fetchMock, region } = await openChanges(turn("running"), {
      [ROOT]: listing("", [dir("data"), file("readme.md")]),
      [DATA]: () => jsonResponse({ path: "data", entries: current.data }),
    });
    const send = await goLive();
    fireEvent.click(button(region, "展开 data"));
    await within(region).findByRole("button", { name: "old.csv" });
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, DATA]);
    const since = requestsSince(fetchMock);

    current.data = [file("old.csv"), file("raw.csv")];
    endedStep(send, 1, "bash");
    await settled();
    expect(since()).toStrictEqual(NONE);
    expect(within(region).queryByRole("button", { name: "raw.csv" })).toBeNull();

    send("turn.end", { status: "done" });

    const row = await within(region).findByRole("button", { name: "raw.csv" });
    expect(description(row)).toBeNull();
    expect(region.querySelector('[data-slot="tree-mark"]')).toBeNull();
    expect(button(region, "折叠 data").getAttribute("aria-expanded")).toBe("true");
    await settled();
    expect(since()).toStrictEqual({ files: [], trees: [DATA, ROOT].sort() });
  });

  it("R2b 步骤结束后 300 毫秒内回合结束：每个已加载的目录恰重列一次，再过 300 毫秒没有新的请求", async () => {
    const { fetchMock, region } = await openChanges(turn("running"));
    const send = await goLive();
    fireEvent.click(button(region, "展开 out"));
    await within(region).findByRole("button", { name: "index.html" });
    await settled();
    const since = requestsSince(fetchMock);
    freezeTimers();

    endedStep(send, 1, "write", write("out/b.md"));
    await advance(100);
    expect(since()).toStrictEqual(NONE);

    send("turn.end", { status: "done" });
    const ONCE = { files: [], trees: [ROOT, OUT].sort() };
    expect(since()).toStrictEqual(ONCE);

    await advance(WINDOW);
    expect(since()).toStrictEqual(ONCE);
  });

  it("R3 关闭期间不请求：关闭后三个带 changes 的步骤结束，没有 tree 或 file 请求；重新打开恰请求一次根、没有 file，再过 300 毫秒也没有", async () => {
    const { fetchMock, region } = await openChanges(turn("running"));
    const send = await goLive();
    fireEvent.click(button(region, "readme.md"));
    await waitFor(() => expect(previewText(region)).toContain("自述正文"));
    await settled();
    fireEvent.click(button(region, CLOSE));
    expect(sidebarRegion()).toBeNull();
    await settled();
    const closed = requestsSince(fetchMock);
    freezeTimers();

    endedStep(send, 1, "write", write("readme.md"));
    endedStep(send, 2, "write", write("out/b.md"));
    endedStep(send, 3, "edit", write("src/app.ts"));
    await advance(WINDOW);
    expect(closed()).toStrictEqual(NONE);

    const reopened = await reopen();

    const AGAIN = { files: [], trees: [ROOT] };
    expect(closed()).toStrictEqual(AGAIN);
    // 回到只展开根、未选文件的初始状态。
    expect(rowNames(reopened)).toStrictEqual([
      "项目",
      "deep",
      "out",
      "src",
      "draft.md",
      "readme.md",
    ]);
    expect(reopened.querySelector('[aria-current="true"]')).toBeNull();
    await advance(WINDOW);
    expect(closed()).toStrictEqual(AGAIN);
  });

  it("R3b 步骤结束后 300 毫秒内关闭侧边栏：到点也没有请求", async () => {
    const { fetchMock, region } = await openChanges(turn("running"));
    const send = await goLive();
    fireEvent.click(button(region, "readme.md"));
    await waitFor(() => expect(previewText(region)).toContain("自述正文"));
    await settled();
    const since = requestsSince(fetchMock);
    freezeTimers();

    endedStep(send, 1, "write", write("readme.md"));
    await advance(100);
    fireEvent.click(button(region, CLOSE));
    expect(sidebarRegion()).toBeNull();
    await advance(WINDOW);

    expect(since()).toStrictEqual(NONE);
  });

  it("R4 首屏历史里已有带 changes 的步骤：打开侧边栏只有挂载时那一次根请求，过 300 毫秒也没有刷新", async () => {
    const { fetchMock, region } = await openChanges(
      turn("done", { steps: [toolStep(1, 0, "write", [write("readme.md"), write("out/b.md")])] }),
    );
    await settled();
    fireEvent.click(button(region, CLOSE));
    await settled();
    const since = requestsSince(fetchMock);
    freezeTimers();

    const reopened = await reopen();

    const MOUNT = { files: [], trees: [ROOT] };
    expect(since()).toStrictEqual(MOUNT);
    expect(description(button(reopened, "readme.md"))).toBe(MARK);
    await advance(WINDOW);
    expect(since()).toStrictEqual(MOUNT);
  });

  it("R5 刷新失败保留旧树：根的 tree 返回 500 时原来的行都在、树区出现失败文案；下一次刷新成功后文案消失、新文件出现", async () => {
    const current = { root: listing("", [dir("out"), file("readme.md")]) };
    const { fetchMock, region } = await openChanges(turn("running"), {
      [ROOT]: () => current.root(),
    });
    const send = await goLive();
    await settled();
    const tree = within(region).getByRole("navigation", { name: TREE });
    const BEFORE = ["项目", "out", "readme.md"];
    expect(rowNames(region)).toStrictEqual(BEFORE);
    expect(within(tree).queryByRole("alert")).toBeNull();
    const since = requestsSince(fetchMock);

    current.root = () => envelope(500, "internal", FAILED);
    endedStep(send, 1, "write", write("new.md"));

    expect((await within(tree).findByRole("alert")).textContent).toBe(FAILED);
    expect(rowNames(region)).toStrictEqual(BEFORE);
    expect(since()).toStrictEqual({ files: [], trees: [ROOT] });

    current.root = listing("", [dir("out"), file("new.md"), file("readme.md")]);
    send("turn.end", { status: "done" });

    expect(await within(region).findByRole("button", { name: "new.md" })).toBeTruthy();
    expect(within(tree).queryByRole("alert")).toBeNull();
    expect(rowNames(region)).toStrictEqual(["项目", "out", "new.md", "readme.md"]);
    await settled();
    expect(since()).toStrictEqual({ files: [], trees: [ROOT, ROOT] });
  });
});
