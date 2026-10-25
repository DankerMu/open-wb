// connectors「中心「连接器」tab」（s1d-connectors 任务 6.2）的列表部分：普通用户视图（名称、类型、描述与
// `默认启用`，没有命令 / 地址 / 管理按钮）与 `默认启用` 整表 `PUT`（含列表外名称、在途不可切换、失败回滚）；
// 管理员视图（命令或地址、探活状态、`启用` 开关、行操作、页顶 `新增连接器`）、`启用` 开关的整体替换 body（规格
// 「启用开关与空态」）、删除确认、探活在途禁用；空态文案。假 `ApiClient` 经 `ConnectorsPanel({client, admin})` 注入。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type ConnectorView } from "../src/lib/api.js";
import {
  badRequest,
  callNames,
  DOCS,
  DOCS_URL,
  defaultSwitch,
  deferred,
  enabledSwitch,
  fakeConnectors,
  flush,
  GITLAB,
  GITLAB_COMMAND,
  LINT,
  PROBED_AT,
  pageAlerts,
  probeTime,
  publishFailed,
  renderPanel,
  rowButton,
  rowOf,
  switchStates,
} from "./center-connectors-support.js";

const EMPTY_TITLE = "尚未接入内网连接器";
const EMPTY_TEXT =
  "公网 SaaS 连接器（文档/邮箱/IM）在内网部署下已移除。内网 GitLab 等系统部署完成后在此接入。";

afterEach(() => {
  cleanup();
});

function headers(): string[] {
  return screen.getAllByRole("columnheader").map((cell) => cell.textContent ?? "");
}

function cells(name: string): string[] {
  return within(rowOf(name))
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

/** 在途期间没有任何开关带 `disabled`（不可切换只用 `aria-disabled`）。 */
function noneDisabled(): boolean {
  return screen
    .queryAllByRole("switch")
    .every((element) => !(element as HTMLButtonElement).disabled);
}

async function defaultsSettled(): Promise<void> {
  await waitFor(() => {
    expect(
      screen
        .queryAllByRole("switch", { name: /^默认启用 / })
        .every((element) => !element.hasAttribute("aria-disabled")),
    ).toBe(true);
  });
}

describe("普通用户", () => {
  it("每行名称、类型、描述与「默认启用」开关；没有命令、地址、探活、启用开关与任何按钮；挂载恰一次 listConnectors 与 getConnectorDefaults", async () => {
    const fake = fakeConnectors([DOCS, GITLAB, LINT], {
      admin: false,
      disabled: ["ghost", "lint"],
    });
    await renderPanel(fake);

    expect(headers()).toEqual(["名称", "类型", "描述", "默认启用"]);
    // 停用的 docs 不在普通用户的列表里（服务端只给启用的行）。
    expect(cells("gitlab").slice(0, 3)).toEqual(["gitlab", "stdio", "代码库"]);
    expect(cells("lint").slice(0, 3)).toEqual(["lint", "stdio", ""]);
    expect(switchStates()).toEqual([
      ["默认启用 gitlab", true, false],
      ["默认启用 lint", false, false],
    ]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByText(GITLAB_COMMAND)).toBeNull();
    expect(screen.queryByText("从未")).toBeNull();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(callNames(fake)).toEqual(["listConnectors", "getConnectorDefaults"]);
    expect(fake.otherCalls()).toEqual([]);
  });

  it("规格例子：关闭 gitlab 的「默认启用」恰一次 PUT /api/connectors/defaults，body [gitlab]；不重取列表", async () => {
    const fake = fakeConnectors([GITLAB], { admin: false });
    await renderPanel(fake);

    fireEvent.click(defaultSwitch("gitlab"));
    await defaultsSettled();
    expect(fake.putConnectorDefaults.mock.calls).toEqual([[["gitlab"]]]);
    expect(defaultSwitch("gitlab").getAttribute("aria-checked")).toBe("false");
    expect(fake.listConnectors).toHaveBeenCalledTimes(1);
    expect(fake.otherCalls()).toEqual([]);
  });

  it("body 为切换后的完整列表：列表外的 ghost 保留、去重排序；接着重新打开，body 恰为 [ghost]", async () => {
    const fake = fakeConnectors([GITLAB, LINT], { admin: false, disabled: ["ghost"] });
    await renderPanel(fake);

    fireEvent.click(defaultSwitch("gitlab"));
    await defaultsSettled();
    fireEvent.click(defaultSwitch("gitlab"));
    await defaultsSettled();
    expect(fake.putConnectorDefaults.mock.calls.map(([body]) => body)).toEqual([
      ["ghost", "gitlab"],
      ["ghost"],
    ]);
    expect(defaultSwitch("gitlab").getAttribute("aria-checked")).toBe("true");
  });

  it("在途期间全部「默认启用」开关 aria-disabled（不是 disabled），焦点留在按下的开关上；再点不发请求、不改状态；应答后恢复", async () => {
    const fake = fakeConnectors([GITLAB, LINT], { admin: false, disabled: ["ghost"] });
    const pending = deferred<string[]>();
    fake.putConnectorDefaults.mockReturnValueOnce(pending.promise);
    await renderPanel(fake);

    const gitlab = defaultSwitch("gitlab");
    gitlab.focus();
    fireEvent.click(gitlab);
    await waitFor(() =>
      expect(switchStates()).toEqual([
        ["默认启用 gitlab", false, true],
        ["默认启用 lint", true, true],
      ]),
    );
    expect(noneDisabled()).toBe(true);
    expect(document.activeElement).toBe(gitlab);

    fireEvent.click(defaultSwitch("lint"));
    fireEvent.click(gitlab);
    await flush();
    expect(fake.putConnectorDefaults).toHaveBeenCalledTimes(1);
    expect(switchStates()).toEqual([
      ["默认启用 gitlab", false, true],
      ["默认启用 lint", true, true],
    ]);
    expect(document.activeElement).toBe(gitlab);

    await act(async () => pending.resolve(["ghost", "gitlab"]));
    await defaultsSettled();
    expect(switchStates()).toEqual([
      ["默认启用 gitlab", false, false],
      ["默认启用 lint", true, false],
    ]);
    expect(document.activeElement).toBe(gitlab);
    expect(fake.putConnectorDefaults).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["500", new ApiError(500, "internal_error", "服务器内部错误")],
    ["400", badRequest()],
  ])(
    "%s：开关回到切换前、焦点不动、页顶显示 ApiError.message；下一次切换的 body 仍以原列表为基",
    async (_status, error) => {
      const fake = fakeConnectors([GITLAB, LINT], { admin: false, disabled: ["ghost"] });
      fake.putConnectorDefaults.mockRejectedValueOnce(error);
      await renderPanel(fake);

      const gitlab = defaultSwitch("gitlab");
      gitlab.focus();
      fireEvent.click(gitlab);
      await waitFor(() => expect(pageAlerts()).toEqual([error.message]));
      await defaultsSettled();
      expect(switchStates()).toEqual([
        ["默认启用 gitlab", true, false],
        ["默认启用 lint", true, false],
      ]);
      expect(document.activeElement).toBe(gitlab);

      fireEvent.click(defaultSwitch("lint"));
      await defaultsSettled();
      expect(fake.putConnectorDefaults.mock.calls.map(([body]) => body)).toEqual([
        ["ghost", "gitlab"],
        ["ghost", "lint"],
      ]);
      expect(pageAlerts()).toEqual([]);
    },
  );

  it("getConnectorDefaults 失败：页内 role=alert 显示 ApiError.message，没有表与开关", async () => {
    const fake = fakeConnectors([GITLAB], { admin: false });
    fake.getConnectorDefaults.mockRejectedValueOnce(new ApiError(500, "x", "服务器内部错误"));
    await renderPanel(fake);

    expect(pageAlerts()).toEqual(["服务器内部错误"]);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
  });
});

describe("管理员", () => {
  it("另见命令或地址、探活状态、启用开关、行操作与页顶「新增连接器」；不显示任何凭证值", async () => {
    const fake = fakeConnectors([DOCS, GITLAB, LINT], { disabled: ["lint"] });
    await renderPanel(fake);

    expect(headers()).toEqual([
      "名称",
      "类型",
      "描述",
      "命令或地址",
      "探活",
      "启用",
      "默认启用",
      "操作",
    ]);
    expect(cells("docs").slice(0, 5)).toEqual([
      "docs",
      "http",
      "文档",
      DOCS_URL,
      `失败：HTTP 401：bad token${probeTime(1_760_000_000_500)}`,
    ]);
    expect(cells("gitlab").slice(0, 5)).toEqual([
      "gitlab",
      "stdio",
      "代码库",
      GITLAB_COMMAND,
      "从未",
    ]);
    expect(cells("lint")[4]).toBe(`正常${probeTime(1_760_000_000_700)}`);
    expect(switchStates()).toEqual([
      ["启用 docs", false, false],
      ["默认启用 docs", true, false],
      ["启用 gitlab", true, false],
      ["默认启用 gitlab", true, false],
      ["启用 lint", true, false],
      ["默认启用 lint", false, false],
    ]);
    for (const name of ["docs", "gitlab", "lint"]) {
      expect(
        within(rowOf(name))
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["编辑", "删除", "探活"]);
    }
    expect(screen.getByRole("button", { name: "新增连接器" })).toBeTruthy();
    expect(callNames(fake)).toEqual(["listConnectors", "getConnectorDefaults"]);
  });

  it("规格例子：关闭 gitlab 的「启用」恰一次 updateConnector，body 由管理员视图构造、凭证键为 null；随后重取列表", async () => {
    const fake = fakeConnectors([GITLAB]);
    await renderPanel(fake);

    fireEvent.click(enabledSwitch("gitlab"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    expect(fake.updateConnector.mock.calls).toEqual([
      [
        "gitlab",
        {
          description: "代码库",
          command: GITLAB_COMMAND,
          args: ["--stdio"],
          env: { TOKEN: null },
          enabled: false,
        },
      ],
    ]);
    expect(callNames(fake)).toEqual([
      "listConnectors",
      "getConnectorDefaults",
      "updateConnector",
      "listConnectors",
    ]);
    await waitFor(() => expect(enabledSwitch("gitlab").getAttribute("aria-checked")).toBe("false"));
    expect(fake.putConnectorDefaults).not.toHaveBeenCalled();
  });

  it("http 连接器打开「启用」：body 恰为 {description, url, headers: 每个键 null, enabled: true}", async () => {
    const fake = fakeConnectors([DOCS]);
    await renderPanel(fake);

    fireEvent.click(enabledSwitch("docs"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    expect(fake.updateConnector.mock.calls).toEqual([
      [
        "docs",
        { description: "文档", url: DOCS_URL, headers: { authorization: null }, enabled: true },
      ],
    ]);
  });

  it("「启用」在途：该开关 aria-disabled（不是 disabled）且显示切换后的状态，焦点不动，再点不发请求", async () => {
    const fake = fakeConnectors([GITLAB, LINT]);
    const gate = deferred<ConnectorView>();
    fake.updateConnector.mockReturnValueOnce(gate.promise);
    await renderPanel(fake);

    const gitlab = enabledSwitch("gitlab");
    gitlab.focus();
    fireEvent.click(gitlab);
    await waitFor(() => expect(gitlab.getAttribute("aria-disabled")).toBe("true"));
    expect(gitlab.getAttribute("aria-checked")).toBe("false");
    expect((gitlab as HTMLButtonElement).disabled).toBe(false);
    expect(enabledSwitch("lint").hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(gitlab);
    await flush();
    expect(fake.updateConnector).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(gitlab);

    await act(async () => gate.resolve({ ...GITLAB, enabled: false }));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(gitlab.hasAttribute("aria-disabled")).toBe(false));
    expect(document.activeElement).toBe(gitlab);
  });

  it("「启用」收到 400：开关回到原状态，页顶显示 message，不重取", async () => {
    const fake = fakeConnectors([GITLAB]);
    fake.updateConnector.mockRejectedValueOnce(badRequest());
    await renderPanel(fake);

    fireEvent.click(enabledSwitch("gitlab"));
    await waitFor(() => expect(pageAlerts()).toEqual(["请求格式不正确"]));
    expect(enabledSwitch("gitlab").getAttribute("aria-checked")).toBe("true");
    expect(enabledSwitch("gitlab").hasAttribute("aria-disabled")).toBe(false);
    expect(fake.listConnectors).toHaveBeenCalledTimes(1);
  });

  it("「启用」收到非信封 500（发布失败，行已写入）：重取列表，页顶显示 REQUEST_FAILED_MESSAGE", async () => {
    const fake = fakeConnectors([GITLAB]);
    fake.updateConnector.mockRejectedValueOnce(publishFailed());
    await renderPanel(fake);

    fireEvent.click(enabledSwitch("gitlab"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    expect(pageAlerts()).toEqual(["请求失败，请稍后重试"]);
  });
});

describe("界面身份按 principal，不按应答形状", () => {
  it("管理员却收到三键视图的非空表：视为无效应答，页内显示 REQUEST_FAILED_MESSAGE，没有表", async () => {
    const fake = fakeConnectors([GITLAB], { admin: false });
    await renderPanel(fake, true);

    expect(pageAlerts()).toEqual(["请求失败，请稍后重试"]);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("普通用户即使收到管理员视图，也只见名称、类型、描述与「默认启用」", async () => {
    const fake = fakeConnectors([GITLAB]);
    await renderPanel(fake, false);

    expect(headers()).toEqual(["名称", "类型", "描述", "默认启用"]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByText(GITLAB_COMMAND)).toBeNull();
  });
});

describe("删除", () => {
  it("确认框标题与说明；「取消」不调用；「删除」恰一次 deleteConnector，随后重取、行消失", async () => {
    const fake = fakeConnectors([GITLAB, LINT]);
    await renderPanel(fake);

    fireEvent.click(rowButton("gitlab", "删除"));
    let confirm = await screen.findByRole("alertdialog", { name: "删除连接器 gitlab？" });
    expect(within(confirm).getByText("删除后不可恢复。")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteConnector).not.toHaveBeenCalled();

    fireEvent.click(rowButton("gitlab", "删除"));
    confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByText("gitlab")).toBeNull());
    expect(fake.deleteConnector.mock.calls).toEqual([["gitlab"]]);
    expect(callNames(fake)).toEqual([
      "listConnectors",
      "getConnectorDefaults",
      "deleteConnector",
      "listConnectors",
    ]);
  });

  it("Escape 关闭确认框：不调用 deleteConnector，焦点回到该行的「删除」", async () => {
    const fake = fakeConnectors([GITLAB]);
    await renderPanel(fake);

    fireEvent.click(rowButton("gitlab", "删除"));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteConnector).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowButton("gitlab", "删除"));
  });
});

describe("探活", () => {
  it("在途禁用该行「探活」、别的行不受影响；完成后重取，显示「正常」与完成时刻", async () => {
    const fake = fakeConnectors([GITLAB, LINT]);
    const gate = deferred<void>();
    const original = fake.probeConnector.getMockImplementation();
    fake.probeConnector.mockImplementationOnce(async (name: string) => {
      await gate.promise;
      return (original as (name: string) => Promise<ConnectorView>)(name);
    });
    await renderPanel(fake);

    fireEvent.click(rowButton("gitlab", "探活"));
    await waitFor(() => expect(rowButton("gitlab", "探活").hasAttribute("disabled")).toBe(true));
    expect(rowButton("lint", "探活").hasAttribute("disabled")).toBe(false);
    fireEvent.click(rowButton("gitlab", "探活"));
    expect(fake.probeConnector).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowButton("gitlab", "探活").hasAttribute("disabled")).toBe(false));
    expect(cells("gitlab")[4]).toBe(`正常${probeTime(PROBED_AT)}`);
    expect(fake.probeConnector.mock.calls).toEqual([["gitlab"]]);
  });

  it("探活抛 ApiError：页顶显示其 message，照样重取", async () => {
    const fake = fakeConnectors([GITLAB]);
    fake.probeConnector.mockRejectedValueOnce(new ApiError(404, "not_found", "请求的资源不存在"));
    await renderPanel(fake);

    fireEvent.click(rowButton("gitlab", "探活"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    expect(pageAlerts()).toEqual(["请求的资源不存在"]);
  });
});

describe("空态", () => {
  it.each([
    ["管理员", true],
    ["普通用户", false],
  ])(
    "%s：GET 返回空表时显示标题与说明（逐字），没有表；只有管理员见「新增连接器」",
    async (_who, admin) => {
      const fake = fakeConnectors([], { admin });
      await renderPanel(fake);

      expect(screen.getByText(EMPTY_TITLE, { exact: true })).toBeTruthy();
      expect(screen.getByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByRole("button", { name: "新增连接器" }) !== null).toBe(admin);
      expect(pageAlerts()).toEqual([]);
    },
  );
});
