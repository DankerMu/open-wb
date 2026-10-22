// model-registry「模型 tab」：列表的列与标签、首次读取失败、删除确认与 409、设缺省、探活与在途禁用、
// 写操作的非信封 500（s1d-model-registry 任务 10.2）。假 `ApiClient` 经 `ModelsPanel({client})` 注入。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelsPanel } from "../src/features/center/models/panel.js";
import { ApiError, REQUEST_FAILED_MESSAGE } from "../src/lib/api.js";
import {
  callNames,
  fakeModels,
  M2,
  M3,
  PROBED_AT,
  pageAlerts,
  probeTime,
  publishFailed,
  renderPanel,
  rowButton,
  rowOf,
  SEED,
} from "./center-models-support.js";

const IN_USE = "该模型是缺省模型，先把缺省换成别的模型";

afterEach(() => {
  cleanup();
});

/** 一行各单元格的文字，按列次序（操作列只取按钮名）。 */
function cells(id: string): string[] {
  return within(rowOf(id))
    .getAllByRole("cell")
    .map((cell, index) =>
      index === 7
        ? within(cell)
            .getAllByRole("button")
            .map((button) => button.textContent)
            .join(" ")
        : (cell.textContent ?? ""),
    );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("列表", () => {
  it("表头八列；每行 id、名称、推理 / 看图标签、最大 tokens、上游、探活、缺省与行操作；挂载时恰取一次列表", async () => {
    const ok = { ...M3, probe: { status: "ok" as const, at: PROBED_AT, message: null } };
    const fake = fakeModels([SEED, M2, ok]);
    await renderPanel(fake);

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "ID",
      "名称",
      "能力",
      "最大 tokens",
      "上游",
      "探活",
      "缺省",
      "操作",
    ]);
    expect(cells(SEED.id)).toEqual([
      SEED.id,
      SEED.id,
      "推理看图",
      "32768",
      "已配置",
      "从未",
      "缺省",
      "编辑 删除 探活",
    ]);
    expect(cells("m2")).toEqual([
      "m2",
      "千问",
      "推理",
      "8192",
      "已配置",
      `失败：HTTP 401：bad key${probeTime(1_760_000_000_500)}`,
      "",
      "编辑 删除 设为缺省 探活",
    ]);
    expect(cells("m3")).toEqual([
      "m3",
      "本地",
      "",
      "32768",
      "未配置",
      `正常${probeTime(PROBED_AT)}`,
      "",
      "编辑 删除 设为缺省 探活",
    ]);
    expect(within(rowOf(SEED.id)).getByText("推理")).toBeTruthy();
    expect(within(rowOf(SEED.id)).getByText("看图")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新增模型" })).toBeTruthy();
    expect(callNames(fake)).toEqual(["listModels"]);
  });

  it("首次读取失败：页内 role=alert 显示 ApiError.message，不渲染表与「新增模型」", async () => {
    const fake = fakeModels([SEED]);
    fake.listModels.mockRejectedValueOnce(new ApiError(403, "forbidden", "没有权限执行此操作"));
    render(<ModelsPanel client={fake.client} />);

    expect((await screen.findByRole("alert")).textContent).toBe("没有权限执行此操作");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "新增模型" })).toBeNull();
    expect(fake.listModels).toHaveBeenCalledTimes(1);
  });
});

describe("删除", () => {
  it("确认框标题与说明；「取消」不调用；「删除」恰一次 deleteModel，随后重取一次、行消失", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "删除"));
    const confirm = await screen.findByRole("alertdialog", { name: "删除模型 千问？" });
    expect(within(confirm).getByText("删除后不可恢复。")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteModel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("m2", "删除"));

    fireEvent.click(rowButton("m2", "删除"));
    const again = await screen.findByRole("alertdialog", { name: "删除模型 千问？" });
    fireEvent.click(within(again).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByText("千问")).toBeNull());
    expect(callNames(fake)).toEqual(["listModels", "deleteModel", "listModels"]);
    expect(fake.deleteModel).toHaveBeenCalledWith("m2");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // 打开它的按钮随行删除：焦点落到「新增模型」。
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "新增模型" }));
  });

  it("缺省行的 409：确认框关闭，该行显示信封文案，行仍在，不重取", async () => {
    const fake = fakeModels([SEED, M2]);
    fake.deleteModel.mockRejectedValueOnce(new ApiError(409, "model_in_use", IN_USE));
    await renderPanel(fake);

    fireEvent.click(rowButton(SEED.id, "删除"));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const alert = await within(rowOf(SEED.id)).findByRole("alert");
    expect(alert.textContent).toBe(IN_USE);
    expect(within(rowOf("m2")).queryByRole("alert")).toBeNull();
    expect(fake.deleteModel).toHaveBeenCalledTimes(1);
    expect(fake.listModels).toHaveBeenCalledTimes(1);
    expect(pageAlerts()).toEqual([]);
  });

  it("非信封 500：确认框关闭，重取一次（行已写入），页顶显示 REQUEST_FAILED_MESSAGE", async () => {
    const fake = fakeModels([SEED, M2]);
    fake.deleteModel.mockImplementationOnce(async (id: string) => {
      fake.calls.push(["deleteModel", id]);
      throw publishFailed();
    });
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "删除"));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(pageAlerts()).toEqual([REQUEST_FAILED_MESSAGE]));
    await waitFor(() =>
      expect(callNames(fake)).toEqual(["listModels", "deleteModel", "listModels"]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(rowOf("m2")).queryByRole("alert")).toBeNull();
  });

  it("请求在途：两个按钮禁用，Escape 关不掉；结算后关闭", async () => {
    const fake = fakeModels([SEED, M2]);
    const gate = deferred<void>();
    fake.deleteModel.mockImplementationOnce(() => gate.promise);
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "删除"));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(within(confirm).getByRole("button", { name: "删除" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(within(confirm).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBe(confirm);

    gate.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteModel).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭确认框：不调用 deleteModel，焦点回到该行的「删除」", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "删除"));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteModel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("m2", "删除"));
  });
});

describe("设为缺省", () => {
  it("恰一次 setDefaultModel；刷新后该行有「缺省」且不再有「设为缺省」，原缺省行出现「设为缺省」", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "设为缺省"));
    await waitFor(() => expect(cells("m2")[6]).toBe("缺省"));
    expect(callNames(fake)).toEqual(["listModels", "setDefaultModel", "listModels"]);
    expect(fake.setDefaultModel).toHaveBeenCalledWith("m2");
    expect(within(rowOf("m2")).queryByRole("button", { name: "设为缺省" })).toBeNull();
    expect(cells(SEED.id)[6]).toBe("");
    expect(within(rowOf(SEED.id)).getByRole("button", { name: "设为缺省" })).toBeTruthy();
  });

  it("在途禁用该行的「设为缺省」；非信封 500 时重取并在页顶显示 REQUEST_FAILED_MESSAGE", async () => {
    const fake = fakeModels([SEED, M2, M3]);
    const gate = deferred<void>();
    fake.setDefaultModel.mockImplementationOnce(async (id: string) => {
      fake.calls.push(["setDefaultModel", id]);
      await gate.promise;
      throw publishFailed();
    });
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "设为缺省"));
    await waitFor(() => expect(rowButton("m2", "设为缺省").hasAttribute("disabled")).toBe(true));
    expect(rowButton("m3", "设为缺省").hasAttribute("disabled")).toBe(false);
    gate.resolve();

    await waitFor(() => expect(pageAlerts()).toEqual([REQUEST_FAILED_MESSAGE]));
    expect(callNames(fake)).toEqual(["listModels", "setDefaultModel", "listModels"]);
  });
});

describe("探活", () => {
  it("在途禁用该行「探活」、别的行不受影响；完成后重取，显示「正常」与本地时刻", async () => {
    const fake = fakeModels([SEED, M2]);
    const gate = deferred<void>();
    fake.probeModel.mockImplementationOnce(async (id: string) => {
      await gate.promise;
      fake.calls.push(["probeModel", id]);
      return M2;
    });
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "探活"));
    await waitFor(() => expect(rowButton("m2", "探活").hasAttribute("disabled")).toBe(true));
    expect(rowButton(SEED.id, "探活").hasAttribute("disabled")).toBe(false);
    fireEvent.click(rowButton("m2", "探活"));
    expect(fake.probeModel).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() => expect(rowButton("m2", "探活").hasAttribute("disabled")).toBe(false));
    await waitFor(() => expect(fake.listModels).toHaveBeenCalledTimes(2));
    expect(callNames(fake)).toEqual(["listModels", "probeModel", "listModels"]);
  });

  it("探活抛 ApiError：页顶显示其 message，照样重取", async () => {
    const fake = fakeModels([SEED, M2]);
    fake.probeModel.mockRejectedValueOnce(new ApiError(404, "not_found", "请求的资源不存在"));
    await renderPanel(fake);

    fireEvent.click(rowButton("m2", "探活"));

    await waitFor(() => expect(pageAlerts()).toEqual(["请求的资源不存在"]));
    await waitFor(() => expect(fake.listModels).toHaveBeenCalledTimes(2));
  });

  it("成功的探活：行显示「正常」与完成时刻", async () => {
    const fake = fakeModels([SEED, M3]);
    await renderPanel(fake);

    fireEvent.click(rowButton("m3", "探活"));

    await waitFor(() => expect(cells("m3")[5]).toBe(`正常${probeTime(PROBED_AT)}`));
    expect(fake.probeModel).toHaveBeenCalledWith("m3");
  });
});
