// knowledge-bases「中心「知识库」tab」的检索测试（s2b-kb-retrieval 任务 8.3，design D8）：命中与空态、参数与禁用、
// 清空数字字段、Enter 检索（含输入法组合与在途时的二次提交）、只在 ready 时出现、检索失败、失败后列表与服务端一致
//（静默重取，不经 `重试` 的整表读取）、换库中途放行的应答。假 `ApiClient` 经 `KnowledgeBasesPanel({client})` 注入。
// 注：jsdom 会把 number 输入框里的 `abc` 净化成 `""`，所以 `abc` 一例断言的是与清空同一条原因。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type BaseView,
  type KbRetrievalResult,
  REQUEST_FAILED_MESSAGE,
  type RetrievalHit,
} from "../src/lib/api.js";
import {
  base,
  doc,
  type FakeKb,
  fakeKb,
  openCreate,
  pageAlerts,
  READY,
  renderPanel,
} from "./center-kb-support.js";
import { deferred } from "./chat-stream-support.js";

const IDLE = "输入问题后检索，命中切片会带出所属文档";
const EMPTY = "没有命中，换个说法或先把相关文档入库";
const REASON = "填 0 到 1 之间的数字";
const UNAVAILABLE = "知识库服务暂不可用";
const PLACEHOLDER = "例如 销售额口径 / 弹窗 / 工单超时";
const STORED = { threshold: 0.2, vectorWeight: 0.7 };
const LOWERED = { threshold: 0.1, vectorWeight: 0.7 };
const RAISED = { threshold: 0.3, vectorWeight: 0.7 };

const HITS: RetrievalHit[] = [
  {
    documentId: "d1",
    name: "spec.md",
    similarity: 0.6789,
    content: "销售额按开票口径统计\n退款冲减当月",
  },
  { documentId: "d2", name: "guide.pdf", similarity: 0.5, content: "工单超时 48 小时升级" },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 「规范库」`k1`（一份文档）与「手册库」`k2` 的列表行，检索参数分别为 `k1`、`k2`。 */
function rows(k1: BaseView["retrieval"] = STORED, k2: BaseView["retrieval"] = STORED): BaseView[] {
  return [
    base("k1", { name: "规范库", documents: 1, retrieval: k1 }),
    base("k2", { name: "手册库", retrieval: k2 }),
  ];
}

/** 两库都是 `ready`、检索参数为缺省；`k1` 有一份工作空间来源的已切片文档。 */
function twoBases() {
  return fakeKb([READY], rows(), {
    k1: [doc("d1", { name: "spec.md", path: "docs/spec.md" })],
  });
}

const unavailable = () => new ApiError(503, "kb_unavailable", UNAVAILABLE);

/** 下一次 `listKnowledgeBases` 挂起，直到用例以给定的行放行。 */
function holdList(fake: FakeKb) {
  const held = deferred<BaseView[]>();
  fake.listKnowledgeBases.mockImplementationOnce(() => held.promise);
  return held;
}

/** 填问句与阈值后点 `检索`；`fails` 为真时这次检索以 503 失败（不写回）。 */
function submitWith(panel: HTMLElement, threshold: string, fails: boolean, fake: FakeKb) {
  if (fails) fake.retrieveFromKnowledgeBase.mockRejectedValueOnce(unavailable());
  type(questionOf(panel), "销售额");
  type(thresholdOf(panel), threshold);
  fireEvent.click(buttonOf(panel));
}

const listReads = (fake: FakeKb, count: number) =>
  waitFor(() => expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(count));

async function openDetail(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("cell", { name }));
  return screen.findByRole("region", { name: `${name} · 文档` });
}

const panelOf = (detail: HTMLElement) => within(detail).getByRole("region", { name: "检索测试" });

/** 点该名称的行，返回详情里的「检索测试」区域。 */
async function openRetrieval(name: string): Promise<HTMLElement> {
  return panelOf(await openDetail(name));
}

const questionOf = (panel: HTMLElement) =>
  within(panel).getByRole("textbox", { name: "检索问句" }) as HTMLInputElement;
const thresholdOf = (panel: HTMLElement) =>
  within(panel).getByRole("spinbutton", { name: "相似度阈值" }) as HTMLInputElement;
const weightOf = (panel: HTMLElement) =>
  within(panel).getByRole("spinbutton", { name: "向量权重" }) as HTMLInputElement;
const buttonOf = (panel: HTMLElement) => within(panel).getByRole("button") as HTMLButtonElement;

const type = (field: HTMLInputElement, value: string) => {
  fireEvent.change(field, { target: { value } });
};
const pressEnter = (field: HTMLInputElement, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(field, { key: "Enter", ...init });
};

/** 三个输入框的原始值：问句、阈值、权重。 */
const valuesOf = (panel: HTMLElement) => [
  questionOf(panel).value,
  thresholdOf(panel).value,
  weightOf(panel).value,
];

function expectReason(field: HTMLInputElement) {
  expect(field.getAttribute("aria-invalid")).toBe("true");
  const reason = document.getElementById(field.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toBe(REASON);
}

function expectNoReason(panel: HTMLElement) {
  for (const field of [thresholdOf(panel), weightOf(panel)]) {
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBeNull();
  }
  expect(within(panel).queryByText(REASON)).toBeNull();
}

/** 下一次检索挂起，直到用例放行。 */
function holdNext(fake: FakeKb) {
  const held = deferred<KbRetrievalResult>();
  fake.retrieveFromKnowledgeBase.mockImplementationOnce(() => held.promise);
  return held;
}

/** 在「规范库」把阈值改为 0.1 发出一次挂起的检索，再切到「手册库」；返回挂起的应答与「手册库」的检索测试。 */
async function switchWhileHeld(fake: FakeKb) {
  const panel = await openRetrieval("规范库");
  const held = holdNext(fake);
  type(questionOf(panel), "销售额");
  type(thresholdOf(panel), "0.1");
  fireEvent.click(buttonOf(panel));
  const other = await openRetrieval("手册库");
  expect(panel.isConnected).toBe(false);
  return { held, other };
}

/** 在列表里切到「手册库」再切回「规范库」，返回重新挂载的检索测试。 */
async function switchAwayAndBack(): Promise<HTMLElement> {
  await openRetrieval("手册库");
  return openRetrieval("规范库");
}

describe("检索测试的命中与空态", () => {
  it("未检索提示；两条命中带序号、文档名、两位小数的相似度与保留换行的原文；在途保留上次结果；再检索无命中", async () => {
    const fake = twoBases();
    fake.retrieveFromKnowledgeBase.mockResolvedValueOnce({ hits: HITS, retrieval: STORED });
    renderPanel(fake);
    const detail = await openDetail("规范库");
    const panel = panelOf(detail);

    expect(within(panel).getByRole("heading", { level: 4 }).textContent).toBe("检索测试");
    expect(within(panel).getByText(IDLE)).toBeTruthy();
    expect(questionOf(panel).placeholder).toBe(PLACEHOLDER);
    expect(panel.textContent).not.toContain("召回");
    expect(valuesOf(panel)).toEqual(["", "0.2", "0.7"]);

    type(questionOf(panel), "销售额怎么统计");
    fireEvent.click(buttonOf(panel));

    const items = await within(panel).findAllByRole("listitem");
    expect(fake.retrieveFromKnowledgeBase.mock.calls).toEqual([
      ["k1", { question: "销售额怎么统计", threshold: 0.2, vectorWeight: 0.7 }],
    ]);
    expect(within(panel).getByRole("list").tagName).toBe("OL");
    expect(items).toHaveLength(2);
    const [first, second] = items as [HTMLElement, HTMLElement];
    for (const text of ["#1", "spec.md", "相似度 0.68"]) {
      expect(within(first).getByText(text)).toBeTruthy();
    }
    for (const text of ["#2", "guide.pdf", "相似度 0.50"]) {
      expect(within(second).getByText(text)).toBeTruthy();
    }
    const content = within(first).getByText(HITS[0]?.content ?? "", { normalizer: (t) => t });
    expect(content.className).toContain("whitespace-pre-wrap");
    expect(within(panel).queryByText(IDLE)).toBeNull();
    // 文档表本身显示「已切片 N」与「<空间名>/<路径>」，断言只限检索测试区域。
    expect(detail.textContent).toContain("已切片 3");
    expect(panel.textContent).not.toContain("切片");
    expect(panel.textContent).not.toContain("docs/spec.md");
    expect(panel.textContent).not.toContain("项目空间");
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);

    const held = holdNext(fake);
    fireEvent.click(buttonOf(panel));
    expect(buttonOf(panel).textContent).toBe("正在检索");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);

    await act(async () => held.resolve({ hits: [], retrieval: STORED }));
    expect(await within(panel).findByText(EMPTY)).toBeTruthy();
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
    expect(fake.retrieveFromKnowledgeBase).toHaveBeenCalledTimes(2);
  });

  it("同一文档的两条命中各占一行，次序同应答，没有重复 key 的报错；相似度 1 显示为 1.00", async () => {
    const fake = twoBases();
    const twice: RetrievalHit[] = [
      { documentId: "d1", name: "spec.md", similarity: 1, content: "第一段" },
      { documentId: "d1", name: "spec.md", similarity: 0.3, content: "第二段" },
    ];
    fake.retrieveFromKnowledgeBase.mockResolvedValueOnce({ hits: twice, retrieval: STORED });
    const errors = vi.spyOn(console, "error");
    renderPanel(fake);
    const panel = await openRetrieval("规范库");

    type(questionOf(panel), "口径");
    fireEvent.click(buttonOf(panel));

    const items = await within(panel).findAllByRole("listitem");
    expect(items.map((item) => within(item).getByText(/^相似度/u).textContent)).toEqual([
      "相似度 1.00",
      "相似度 0.30",
    ]);
    expect(items.map((item) => item.textContent?.includes("第一段"))).toEqual([true, false]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("检索测试的参数与禁用", () => {
  it("越界与空白问句时禁用（越界的字段旁有原因）；在途为「正在检索」；放行后字段取应答值，列表同步且不重取", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    const threshold = thresholdOf(panel);

    for (const field of [threshold, weightOf(panel)]) {
      expect(field.type).toBe("number");
      expect(field.inputMode).toBe("decimal");
      expect([field.min, field.max, field.step]).toEqual(["0", "1", "0.01"]);
    }
    expect(buttonOf(panel).disabled).toBe(true);
    expectNoReason(panel);

    type(questionOf(panel), "销售额");
    expect(buttonOf(panel).disabled).toBe(false);
    type(threshold, "1.5");
    expect(buttonOf(panel).disabled).toBe(true);
    expectReason(threshold);

    type(threshold, "0.10");
    type(questionOf(panel), "  \n ");
    expect(buttonOf(panel).disabled).toBe(true);
    expectNoReason(panel);

    type(questionOf(panel), "销售额");
    const held = holdNext(fake);
    fireEvent.click(buttonOf(panel));
    expect(fake.retrieveFromKnowledgeBase.mock.calls).toEqual([
      ["k1", { question: "销售额", threshold: 0.1, vectorWeight: 0.7 }],
    ]);
    expect(buttonOf(panel).textContent).toBe("正在检索");
    expect(buttonOf(panel).disabled).toBe(true);
    expect(questionOf(panel).disabled).toBe(false);

    await act(async () => held.resolve({ hits: [], retrieval: LOWERED }));
    await waitFor(() => expect(buttonOf(panel).textContent).toBe("检索"));
    expect(valuesOf(panel)).toEqual(["销售额", "0.1", "0.7"]);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);

    // 列表里该库的 `retrieval` 已是新值：换库再回来，面板以它初始化，仍没有重取列表。
    const again = await switchAwayAndBack();
    expect(valuesOf(again)).toEqual(["", "0.1", "0.7"]);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
  });
});

describe("清空数字字段", () => {
  it("清空阈值、权重填 abc 或越界时禁用并在该字段旁说明，零次调用；0.123 合法", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    const threshold = thresholdOf(panel);
    const weight = weightOf(panel);
    type(questionOf(panel), "销售额");

    type(threshold, "");
    expect(buttonOf(panel).disabled).toBe(true);
    expectReason(threshold);
    fireEvent.click(buttonOf(panel));
    pressEnter(questionOf(panel));

    type(threshold, "0.2");
    type(weight, "abc");
    expect(buttonOf(panel).disabled).toBe(true);
    expectReason(weight);
    expect(threshold.getAttribute("aria-invalid")).toBeNull();
    pressEnter(questionOf(panel));

    type(weight, "-0.1");
    expect(buttonOf(panel).disabled).toBe(true);
    expectReason(weight);
    pressEnter(questionOf(panel));
    expect(fake.retrieveFromKnowledgeBase).not.toHaveBeenCalled();

    type(weight, "0.123");
    expect(buttonOf(panel).disabled).toBe(false);
    expectNoReason(panel);
  });
});

describe("Enter 检索", () => {
  it("问句框按 Enter 恰一次调用；输入法组合中、数字框里与空白问句时的 Enter 不发请求", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    const question = questionOf(panel);
    type(question, "工单超时");

    pressEnter(question, { isComposing: true });
    pressEnter(question, { keyCode: 229 });
    pressEnter(thresholdOf(panel));
    expect(fake.retrieveFromKnowledgeBase).not.toHaveBeenCalled();

    pressEnter(question);
    expect(await within(panel).findByText(EMPTY)).toBeTruthy();
    expect(fake.retrieveFromKnowledgeBase.mock.calls).toEqual([
      ["k1", { question: "工单超时", threshold: 0.2, vectorWeight: 0.7 }],
    ]);

    type(question, "   ");
    pressEnter(question);
    expect(fake.retrieveFromKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it("请求挂起期间再点一次、再按一次 Enter，仍只有一次调用", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    type(questionOf(panel), "工单超时");
    const held = holdNext(fake);

    pressEnter(questionOf(panel));
    fireEvent.click(buttonOf(panel));
    pressEnter(questionOf(panel));
    expect(fake.retrieveFromKnowledgeBase).toHaveBeenCalledTimes(1);

    await act(async () => held.resolve({ hits: [], retrieval: STORED }));
    expect(await within(panel).findByText(EMPTY)).toBeTruthy();
    expect(fake.retrieveFromKnowledgeBase).toHaveBeenCalledTimes(1);
  });
});

describe("检索测试只在 ready 时出现", () => {
  it("ready 的库不论文档表在读、读取失败还是为空都有检索测试；rebuilding 与 rebuild_failed 没有", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("k1", { name: "就绪库" }),
        base("k2", { name: "重建库", state: "rebuilding" }),
        base("k3", { name: "失败库", state: "rebuild_failed", stateMessage: "重建失败" }),
      ],
    );
    const reading = deferred<never>();
    fake.listKbDocuments.mockImplementationOnce(() => reading.promise);
    renderPanel(fake);

    let detail = await openDetail("就绪库");
    expect(within(detail).getByText("正在读取文档")).toBeTruthy();
    expect(panelOf(detail)).toBeTruthy();

    for (const name of ["重建库", "失败库"]) {
      detail = await openDetail(name);
      await within(detail).findByText("该知识库暂无文档");
      expect(within(detail).queryByRole("region", { name: "检索测试" })).toBeNull();
    }

    fake.listKbDocuments.mockRejectedValueOnce(new ApiError(503, "kb_unavailable", UNAVAILABLE));
    detail = await openDetail("就绪库");
    expect(await within(detail).findByRole("button", { name: "重试" })).toBeTruthy();
    expect(panelOf(detail)).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "重试" }));
    await within(detail).findByText("该知识库暂无文档");
    expect(panelOf(detail)).toBeTruthy();
  });
});

describe("检索失败", () => {
  it("信封文案在面板内以 alert 显示，命中清掉，三个输入保持；数值与初值相等（0.20）不重取列表；再提交先清掉 alert", async () => {
    const fake = twoBases();
    fake.retrieveFromKnowledgeBase.mockResolvedValueOnce({ hits: HITS, retrieval: STORED });
    fake.retrieveFromKnowledgeBase.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", UNAVAILABLE),
    );
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    type(questionOf(panel), "销售额");
    fireEvent.click(buttonOf(panel));
    await within(panel).findAllByRole("listitem");

    type(thresholdOf(panel), "0.20");
    fireEvent.click(buttonOf(panel));

    expect((await within(panel).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(panel).queryByText(EMPTY)).toBeNull();
    expect(within(panel).queryByText(IDLE)).toBeNull();
    expect(valuesOf(panel)).toEqual(["销售额", "0.20", "0.7"]);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);

    const held = holdNext(fake);
    fireEvent.click(buttonOf(panel));
    expect(within(panel).queryByRole("alert")).toBeNull();
    await act(async () => held.reject(new TypeError("network")));
    expect((await within(panel).findByRole("alert")).textContent).toBe(REQUEST_FAILED_MESSAGE);

    const tooLong = "问句不能超过 1000 个字符";
    fake.retrieveFromKnowledgeBase.mockRejectedValueOnce(new ApiError(400, "bad_request", tooLong));
    fireEvent.click(buttonOf(panel));
    await waitFor(() => expect(within(panel).getByRole("alert").textContent).toBe(tooLong));
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
  });
});

describe("失败后列表与服务端一致", () => {
  it("参数有变的检索失败后恰一次静默重取：详情不卸载、alert 与输入都在、不重读状态；重取不覆盖输入也不改基线；切走再切回取服务端的值；参数未变的失败不重取", async () => {
    const fake = twoBases();
    fake.retrieveFromKnowledgeBase.mockImplementationOnce(async () => {
      fake.setRetrievalOf("k1", { threshold: 0.15, vectorWeight: 0.7 });
      throw unavailable();
    });
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    submitWith(panel, "0.1", false, fake);

    await listReads(fake, 2);
    await act(async () => undefined);
    expect(within(panel).getByRole("alert").textContent).toBe(UNAVAILABLE);
    expect(valuesOf(panel)).toEqual(["销售额", "0.1", "0.7"]);
    expect(panel.isConnected).toBe(true);
    expect(fake.getKbStatus).toHaveBeenCalledTimes(1);
    expect(pageAlerts()).toEqual([UNAVAILABLE]);

    // 列表已是 0.15，基线仍是打开时的 0.2：发 0.15 与基线不同，照样重取。
    submitWith(panel, "0.15", true, fake);
    await listReads(fake, 3);

    const again = await switchAwayAndBack();
    expect(valuesOf(again)).toEqual(["", "0.15", "0.7"]);

    fake.retrieveFromKnowledgeBase.mockRejectedValueOnce(unavailable());
    type(questionOf(again), "销售额");
    fireEvent.click(buttonOf(again));
    expect((await within(again).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(3);
  });

  it("静默重取失败不改视图、不写页顶提示：列表与详情都在", async () => {
    const fake = twoBases();
    fake.retrieveFromKnowledgeBase.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", UNAVAILABLE),
    );
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    fake.listKnowledgeBases.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", "列表读不到"),
    );
    type(questionOf(panel), "销售额");
    type(weightOf(panel), "0.9");
    fireEvent.click(buttonOf(panel));

    await waitFor(() => expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(pageAlerts()).toEqual([UNAVAILABLE]);
    expect(panel.isConnected).toBe(true);
    expect(screen.getByRole("cell", { name: "手册库" })).toBeTruthy();
    expect(valuesOf(panel)).toEqual(["销售额", "0.2", "0.9"]);
  });
});

describe("换库中途放行", () => {
  it("参数有变的检索挂起时切到别的库：放行成功后原库的 retrieval 是新值，切回来初值也是新值；别的库面板不受影响", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const { held, other } = await switchWhileHeld(fake);
    await act(async () => held.resolve({ hits: HITS, retrieval: LOWERED }));
    expect(within(other).getByText(IDLE)).toBeTruthy();
    expect(within(other).queryAllByRole("listitem")).toHaveLength(0);
    expect(valuesOf(other)).toEqual(["", "0.2", "0.7"]);

    const back = await openRetrieval("规范库");
    expect(valuesOf(back)).toEqual(["", "0.1", "0.7"]);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
  });

  it("失败变体：放行后恰一次 listKnowledgeBases，别的库面板没有 alert", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const { held, other } = await switchWhileHeld(fake);
    await act(async () => held.reject(new ApiError(503, "kb_unavailable", UNAVAILABLE)));
    await waitFor(() => expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(2));
    expect(within(other).queryByRole("alert")).toBeNull();
    expect(pageAlerts()).toEqual([]);
  });
});

/** 打开「规范库」，以 0.1 检索失败，它触发的静默重取挂起；返回假客户端、面板与挂起的重取。 */
async function failWithHeldRefetch() {
  const fake = twoBases();
  renderPanel(fake);
  const panel = await openRetrieval("规范库");
  const stale = holdList(fake);
  submitWith(panel, "0.1", true, fake);
  await listReads(fake, 2);
  return { fake, panel, stale };
}

describe("静默重取与本地改动", () => {
  it("在途重取之后同一库检索成功（0.3）：旧应答（0.1）放行后被丢弃，切走再切回初值为 0.3", async () => {
    const { fake, panel, stale } = await failWithHeldRefetch();
    expect(within(panel).getByRole("alert").textContent).toBe(UNAVAILABLE);

    submitWith(panel, "0.3", false, fake);
    expect(await within(panel).findByText(EMPTY)).toBeTruthy();
    await listReads(fake, 3);
    await act(async () => stale.resolve(rows(LOWERED)));

    const again = await switchAwayAndBack();
    expect(valuesOf(again)).toEqual(["", "0.3", "0.7"]);
  });

  it("在途重取之后换到别的库检索成功：旧应答放行后那个库仍是新值", async () => {
    const { fake, stale } = await failWithHeldRefetch();

    const other = await openRetrieval("手册库");
    submitWith(other, "0.3", false, fake);
    expect(await within(other).findByText(EMPTY)).toBeTruthy();
    await listReads(fake, 3);
    await act(async () => stale.resolve(rows(LOWERED, STORED)));

    await openRetrieval("规范库");
    expect(valuesOf(await openRetrieval("手册库"))).toEqual(["", "0.3", "0.7"]);
  });

  it("在途重取之后删库与建库：旧应答放行后删掉的行不回来、新建的行不消失", async () => {
    const { fake, panel, stale } = await failWithHeldRefetch();

    fireEvent.click(
      within(screen.getByRole("cell", { name: "手册库" }).closest("tr") as HTMLElement).getByRole(
        "button",
        { name: "删除知识库" },
      ),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }),
    );
    await waitFor(() => expect(screen.queryByRole("cell", { name: "手册库" })).toBeNull());
    await listReads(fake, 3);
    await act(async () => stale.resolve(rows()));
    expect(screen.queryByRole("cell", { name: "手册库" })).toBeNull();

    const late = holdList(fake);
    submitWith(panel, "0.3", true, fake);
    await listReads(fake, 4);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "新库" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("cell", { name: "新库" })).toBeTruthy();
    await listReads(fake, 5);
    await act(async () => late.resolve(rows()));
    expect(screen.getByRole("cell", { name: "新库" })).toBeTruthy();
  });

  it("两次重叠的重取乱序到达：列表取后发的那次", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    const first = holdList(fake);
    submitWith(panel, "0.1", true, fake);
    await listReads(fake, 2);
    const second = holdList(fake);
    submitWith(panel, "0.3", true, fake);
    await listReads(fake, 3);

    await act(async () => second.resolve(rows(RAISED)));
    await act(async () => first.resolve(rows(LOWERED)));

    expect(valuesOf(await switchAwayAndBack())).toEqual(["", "0.3", "0.7"]);
  });

  it("「参数有变」也比列表当前值：失败写回 0.3 并重取后，未重挂载时改回 0.2 再失败，仍重取一次", async () => {
    const fake = twoBases();
    fake.retrieveFromKnowledgeBase.mockImplementationOnce(async () => {
      fake.setRetrievalOf("k1", RAISED);
      throw unavailable();
    });
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    submitWith(panel, "0.3", false, fake);
    await listReads(fake, 2);
    await act(async () => undefined);

    submitWith(panel, "0.2", true, fake);
    expect((await within(panel).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    await listReads(fake, 3);
  });

  it("问句原样发出，不去首尾空白", async () => {
    const fake = twoBases();
    renderPanel(fake);
    const panel = await openRetrieval("规范库");
    type(questionOf(panel), " 销售额 ");
    fireEvent.click(buttonOf(panel));
    expect(fake.retrieveFromKnowledgeBase.mock.calls).toEqual([
      ["k1", { question: " 销售额 ", threshold: 0.2, vectorWeight: 0.7 }],
    ]);
    expect(await within(panel).findByText(EMPTY)).toBeTruthy();
  });
});
