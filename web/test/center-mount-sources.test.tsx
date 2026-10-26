// workspace-mounts「中心「挂载源」tab」（s1b-workspace-mounts 任务 13.2）的两个场景「登记与删除」「就地失败与空态」与
// 同一 requirement 的其余条款：客户端按「挂载源端点」的名称与路径规则校验（名称 1..64 个字符、不含 U+0000–U+001F 与
// U+007F；路径以 `/` 开头——`server/src/workspaces/mounts/validate.ts` 的 `validateMountSourceBody`；存在与包含关系
// 只由服务端判），删除确认框内的失败、`useEscapeFallback`，以及 model-registry「中心页外壳」MODIFIED 的普通用户导航。
//
// 接缝：面板级用例照中心「连接器」tab，经 `MountSourcesPanel({client})` 注入假 `ApiClient`（三个挂载源方法按端点语义
// 改它，其余方法一律会抛错）；导航用例经真实路由（`createAppRouter`）与替身 `fetch`，`GET /api/mount-sources` 显式计数。
// 校验原因的文案 spec 未给，取自本组实现（超长一条与组 11 对话框同字，design D18）。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MountSourcesPanel } from "../src/features/center/mount-sources-tab.js";
import {
  type ApiClient,
  ApiError,
  type CreateMountSourceInput,
  createApiClient,
  type MountSourceList,
  type MountSourceRow,
  REQUEST_FAILED_MESSAGE,
} from "../src/lib/api.js";
import { expectLocation } from "./files-fixture.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  calls,
  centerRoutes,
  composerOptionsRoute,
  composerReadRoutes,
  createFetchMock,
  currentLocation,
  expectExpertsTabSettled,
  jsonResponse,
  setBrowserPath,
} from "./support.js";
import "./radix-platform.js";

const EMPTY_TITLE = "尚未登记挂载源";
const EMPTY_TEXT = "在服务器上挂好 NFS 或本机目录后，在此登记；用户即可在工作空间里挂载它。";
const DELETE_NOTE = "删除后，所有引用它的挂载都会被卸载";
const NAS: MountSourceRow = {
  id: "src-nas",
  name: "NAS",
  path: "/mnt/nas",
  readOnly: true,
  createdAt: 1_760_000_000_000,
};
const ARCHIVE: MountSourceRow = {
  id: "src-archive",
  name: "归档",
  path: "/srv/archive",
  readOnly: false,
  createdAt: 1_760_000_000_001,
};
/** 合法的登记取值。 */
const VALID = { name: "共享盘", path: "/srv/share" };
const conflict = () => new ApiError(409, "conflict", "同名资源已存在");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBrowserPath("/");
});

type Call = [method: string, ...args: unknown[]];

/**
 * 假客户端：持有挂载源表（按名称排序，同服务端的 UTF-8 字节序在本例的名字上一致）；`listMountSources` 回管理员视图
 * （空表即 `{view:"user", sources:[]}`，`parseMountSources` 对空表的结果），`createMountSource` 追加一行，
 * `deleteMountSource` 删掉该行。调用记进 `calls`。
 */
function fakeSources(initial: readonly MountSourceRow[]) {
  let rows = [...initial];
  let next = 0;
  const calls: Call[] = [];
  const sorted = () => [...rows].sort((a, b) => (a.name < b.name ? -1 : 1));
  const methods = {
    listMountSources: vi.fn(async (): Promise<MountSourceList> => {
      calls.push(["listMountSources"]);
      return rows.length === 0
        ? { view: "user", sources: [] }
        : { view: "admin", sources: structuredClone(sorted()) };
    }),
    createMountSource: vi.fn(async (input: CreateMountSourceInput) => {
      calls.push(["createMountSource", input]);
      const row = { id: `src-new-${++next}`, ...input, createdAt: 1_760_000_000_100 };
      rows = [...rows, row];
      return row;
    }),
    deleteMountSource: vi.fn(async (id: string) => {
      calls.push(["deleteMountSource", id]);
      rows = rows.filter((row) => row.id !== id);
    }),
  };
  const base = createApiClient();
  const others = Object.fromEntries(
    Object.keys(base)
      .filter((name) => !(name in methods))
      .map((name) => [
        name,
        vi.fn(async () => {
          throw new Error(`unexpected ${name}`);
        }),
      ]),
  );
  const client = { ...base, ...others, ...methods } as ApiClient;
  const otherCalls = () =>
    Object.entries(others)
      .filter(([, spy]) => spy.mock.calls.length > 0)
      .map(([name]) => name);
  return { client, calls, otherCalls, ...methods };
}

type Fake = ReturnType<typeof fakeSources>;

async function renderPanel(fake: Fake): Promise<void> {
  render(<MountSourcesPanel client={fake.client} />);
  await waitFor(() => expect(screen.queryByText("正在读取挂载源")).toBeNull());
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function cells(name: string): string[] {
  return within(rowOf(name))
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

function rowNames(): string[] {
  return screen
    .queryAllByRole("row")
    .map((row) => within(row).queryAllByRole("cell")[0]?.textContent)
    .filter((name): name is string => name !== undefined);
}

async function openForm(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "登记挂载源" }));
  return screen.findByRole("dialog", { name: "登记挂载源" });
}

function fill(dialog: HTMLElement, values: { name?: string; path?: string; readOnly?: boolean }) {
  if (values.name !== undefined) {
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: values.name } });
  }
  if (values.path !== undefined) {
    fireEvent.change(within(dialog).getByLabelText("服务器路径"), {
      target: { value: values.path },
    });
  }
  const toggle = within(dialog).getByRole("switch", { name: "只读" });
  if (
    values.readOnly !== undefined &&
    (toggle.getAttribute("aria-checked") === "true") !== values.readOnly
  ) {
    fireEvent.click(toggle);
  }
}

function submit(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "登记" }));
}

async function flush(): Promise<void> {
  await act(async () => {});
}

describe("登记与删除", () => {
  it("列表三列文本与「删除」；登记恰一次 createMountSource 后关闭并重取；删除确认后恰一次 deleteMountSource 并重取", async () => {
    const fake = fakeSources([NAS]);
    await renderPanel(fake);

    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "名称",
      "服务器路径",
      "读写",
      "操作",
    ]);
    expect(cells("NAS")).toEqual(["NAS", "/mnt/nas", "只读", "删除"]);
    // 没有编辑：行内只有一个按钮。
    expect(
      within(rowOf("NAS"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["删除"]);

    const dialog = await openForm();
    // 「只读」缺省关闭。
    expect(within(dialog).getByRole("switch", { name: "只读" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    fill(dialog, { name: "共享盘", path: "/srv/share", readOnly: false });
    submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.listMountSources).toHaveBeenCalledTimes(2));
    expect(fake.createMountSource).toHaveBeenCalledTimes(1);
    expect(fake.createMountSource.mock.calls[0]?.[0]).toEqual({
      name: "共享盘",
      path: "/srv/share",
      readOnly: false,
    });
    expect(await screen.findByRole("cell", { name: "共享盘" })).toBeTruthy();
    expect(cells("共享盘")).toEqual(["共享盘", "/srv/share", "可写", "删除"]);

    fireEvent.click(within(rowOf("NAS")).getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("alertdialog", { name: "删除挂载源 NAS？" });
    expect(within(confirm).getByText(DELETE_NOTE).textContent).toBe(DELETE_NOTE);
    expect(fake.deleteMountSource).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(fake.listMountSources).toHaveBeenCalledTimes(3));
    expect(fake.deleteMountSource.mock.calls).toEqual([["src-nas"]]);
    await waitFor(() => expect(rowNames()).toEqual(["共享盘"]));
    expect(fake.calls.map(([name]) => name)).toEqual([
      "listMountSources",
      "createMountSource",
      "listMountSources",
      "deleteMountSource",
      "listMountSources",
    ]);
    expect(fake.otherCalls()).toEqual([]);
  });

  it("打开「只读」后登记：body 的 readOnly 为 true", async () => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    const dialog = await openForm();
    fill(dialog, { name: "只读盘", path: "/srv/ro", readOnly: true });
    submit(dialog);
    await waitFor(() => expect(fake.createMountSource).toHaveBeenCalledTimes(1));
    expect(fake.createMountSource.mock.calls[0]?.[0]).toEqual({
      name: "只读盘",
      path: "/srv/ro",
      readOnly: true,
    });
    expect(await screen.findByRole("cell", { name: "只读盘" })).toBeTruthy();
    expect(cells("只读盘")).toEqual(["只读盘", "/srv/ro", "只读", "删除"]);
  });

  it("确认框点「取消」或按 Escape：不调用 deleteMountSource，不重取", async () => {
    const fake = fakeSources([NAS, ARCHIVE]);
    await renderPanel(fake);

    fireEvent.click(within(rowOf("NAS")).getByRole("button", { name: "删除" }));
    let confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(within(rowOf("归档")).getByRole("button", { name: "删除" }));
    confirm = await screen.findByRole("alertdialog", { name: "删除挂载源 归档？" });
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(fake.deleteMountSource).not.toHaveBeenCalled();
    expect(fake.listMountSources).toHaveBeenCalledTimes(1);
    expect(rowNames()).toEqual(["NAS", "归档"]);
  });
});

describe("就地失败与空态", () => {
  it.each([
    ["409 conflict", conflict()],
    ["400 bad_request", new ApiError(400, "bad_request", "请求格式不正确")],
  ])(
    "登记时服务端返回 %s：对话框保持打开、就地显示 message、已填的值都在，不重取",
    async (_label, error) => {
      const fake = fakeSources([NAS]);
      fake.createMountSource.mockRejectedValueOnce(error);
      await renderPanel(fake);

      const dialog = await openForm();
      fill(dialog, { name: "NAS", path: "/mnt/nas", readOnly: true });
      submit(dialog);
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe(error.message);
      expect(screen.getByRole("dialog", { name: "登记挂载源" })).toBe(dialog);
      expect((within(dialog).getByLabelText("名称") as HTMLInputElement).value).toBe("NAS");
      expect((within(dialog).getByLabelText("服务器路径") as HTMLInputElement).value).toBe(
        "/mnt/nas",
      );
      expect(within(dialog).getByRole("button", { name: "登记" }).hasAttribute("disabled")).toBe(
        false,
      );
      expect(fake.createMountSource).toHaveBeenCalledTimes(1);
      expect(fake.listMountSources).toHaveBeenCalledTimes(1);
    },
  );

  it("删除失败：确认框保持打开并显示该 ApiError.message，不重取；再点「删除」恰再发一次", async () => {
    const fake = fakeSources([NAS]);
    fake.deleteMountSource.mockRejectedValueOnce(
      new ApiError(404, "not_found", "请求的资源不存在"),
    );
    await renderPanel(fake);

    fireEvent.click(within(rowOf("NAS")).getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("alertdialog", { name: "删除挂载源 NAS？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    expect((await within(confirm).findByRole("alert")).textContent).toBe("请求的资源不存在");
    expect(screen.getByRole("alertdialog")).toBe(confirm);
    expect(fake.deleteMountSource).toHaveBeenCalledTimes(1);
    expect(fake.listMountSources).toHaveBeenCalledTimes(1);

    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteMountSource).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(fake.listMountSources).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(EMPTY_TITLE)).toBeTruthy());
  });

  it("GET 返回 {sources:[]}：空态标题与说明逐字，页顶仍有「登记挂载源」，没有表格", async () => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    expect(screen.getByRole("heading", { name: EMPTY_TITLE }).textContent).toBe(EMPTY_TITLE);
    expect(screen.getByText(EMPTY_TEXT).textContent).toBe(EMPTY_TEXT);
    expect(screen.getByRole("button", { name: "登记挂载源" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("读取失败：页内显示该 ApiError.message；管理员收到非空的三键视图视为无效应答", async () => {
    const failing = fakeSources([]);
    failing.listMountSources.mockRejectedValueOnce(new ApiError(403, "forbidden", "没有权限"));
    await renderPanel(failing);
    expect(screen.getByRole("alert").textContent).toBe("没有权限");
    cleanup();

    const userView = fakeSources([]);
    userView.listMountSources.mockResolvedValueOnce({
      view: "user",
      sources: [{ id: "src-nas", name: "NAS", readOnly: true }],
    });
    await renderPanel(userView);
    expect(screen.getByRole("alert").textContent).toBe(REQUEST_FAILED_MESSAGE);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("登记成功而重取失败：对话框关闭，页顶提示该 message", async () => {
    const fake = fakeSources([NAS]);
    await renderPanel(fake);
    fake.listMountSources.mockRejectedValueOnce(new ApiError(503, "unavailable", "服务暂不可用"));

    const dialog = await openForm();
    fill(dialog, { name: "共享盘", path: "/srv/share" });
    submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("alert")).textContent).toBe("服务暂不可用");
    expect(rowNames()).toEqual(["NAS"]);
  });
});

describe("客户端校验（「挂载源端点」的名称与路径规则）", () => {
  it.each([
    ["空名称", { ...VALID, name: "" }, "名称", "名称不能为空"],
    ["65 个字符的名称", { ...VALID, name: "名".repeat(65) }, "名称", "名称不能超过 64 个字符"],
    ["含 U+0007 的名称", { ...VALID, name: "共享\u0007盘" }, "名称", "名称不能含控制字符"],
    ["含 U+007F 的名称", { ...VALID, name: "共享\u007f" }, "名称", "名称不能含控制字符"],
    [
      "相对路径",
      { ...VALID, path: "srv/share" },
      "服务器路径",
      "服务器路径须为以 / 开头的绝对路径",
    ],
    ["空路径", { ...VALID, path: "" }, "服务器路径", "服务器路径须为以 / 开头的绝对路径"],
  ])("%s：该字段旁显示原因，不发请求、对话框不关", async (_label, values, field, reason) => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    const dialog = await openForm();
    fill(dialog, values);
    submit(dialog);
    await flush();

    const input = within(dialog).getByLabelText(field);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(reason);
    expect(within(dialog).getAllByText(reason)).toHaveLength(1);
    expect(fake.createMountSource).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "登记挂载源" })).toBe(dialog);
    expect(fake.listMountSources).toHaveBeenCalledTimes(1);
  });

  it("64 个码点的名称（含增补平面字符）、首尾空格与路径不存在由服务端判：照样提交，原样上送", async () => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    const name = ` ${"𝔸".repeat(62)} `;
    const dialog = await openForm();
    fill(dialog, { name, path: "/no/such/dir/" });
    submit(dialog);
    await waitFor(() => expect(fake.createMountSource).toHaveBeenCalledTimes(1));
    expect(fake.createMountSource.mock.calls[0]?.[0]).toEqual({
      name,
      path: "/no/such/dir/",
      readOnly: false,
    });
  });

  it("改正后再提交：原因消失，恰一次 createMountSource", async () => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    const dialog = await openForm();
    fill(dialog, { name: "", path: "rel" });
    submit(dialog);
    await flush();
    expect(within(dialog).getByText("名称不能为空")).toBeTruthy();
    expect(within(dialog).getByText("服务器路径须为以 / 开头的绝对路径")).toBeTruthy();

    fill(dialog, VALID);
    submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createMountSource).toHaveBeenCalledTimes(1);
  });
});

describe("对话框的关闭（useEscapeFallback）", () => {
  it("Escape 与「取消」关闭登记对话框、不发请求，焦点回到「登记挂载源」；重开时字段为空", async () => {
    const fake = fakeSources([]);
    await renderPanel(fake);

    let dialog = await openForm();
    fill(dialog, VALID);
    fireEvent.keyDown(within(dialog).getByLabelText("名称"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "登记挂载源" })),
    );

    dialog = await openForm();
    expect((within(dialog).getByLabelText("名称") as HTMLInputElement).value).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createMountSource).not.toHaveBeenCalled();
  });

  it("请求在途：「登记」「取消」禁用，Escape 关不掉；结算后关闭", async () => {
    const fake = fakeSources([]);
    let settle!: () => void;
    fake.createMountSource.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          settle = () => resolve({ id: "src-x", ...input, createdAt: 1 });
        }),
    );
    await renderPanel(fake);

    const dialog = await openForm();
    fill(dialog, VALID);
    submit(dialog);
    await flush();
    expect(within(dialog).getByRole("button", { name: "登记" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(within(dialog).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(within(dialog).getByLabelText("名称"), { key: "Escape" });
    submit(dialog);
    await flush();
    expect(screen.getByRole("dialog", { name: "登记挂载源" })).toBe(dialog);
    expect(fake.createMountSource).toHaveBeenCalledTimes(1);

    await act(async () => settle());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("中心页外壳（真实路由）", () => {
  const ADMIN = { ...authenticatedPrincipal, account: "lisi", role: "管理员" };
  const MEMBER = authenticatedPrincipal;

  function openApp(path: string, principal: typeof MEMBER) {
    const fetchMock = createFetchMock({
      "/api/auth/me": () => jsonResponse(principal),
      "/api/sessions": () => jsonResponse({ sessions: [] }),
      "/api/workspaces": () => jsonResponse({ workspaces: [] }),
      "/api/mount-sources": () => jsonResponse({ sources: [NAS] }),
      ...composerOptionsRoute(),
      ...composerReadRoutes(),
      ...centerRoutes(),
    });
    const mounted = mountAuthenticatedApp(path, fetchMock);
    dispose = () => mounted.router.dispose();
    return fetchMock;
  }

  function tabStates() {
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    return tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
  }

  it("普通用户打开 /center?tab=mount-sources：以 replace 变为 /center?tab=experts，tab 条没有「挂载源」，零 GET /api/mount-sources", async () => {
    const before = window.history.length;
    const fetchMock = openApp("/center?tab=mount-sources", MEMBER);

    await expectExpertsTabSettled(fetchMock);
    await expectLocation("/center?tab=experts");
    expect(window.history.length).toBe(before);
    expect(tabStates()).toEqual([
      ["专家", "true"],
      ["技能", "false"],
      ["连接器", "false"],
    ]);
    expect(calls(fetchMock, "/api/mount-sources")).toHaveLength(0);
  });

  it("管理员打开 /center?tab=mount-sources：留在原地，「挂载源」选中，恰一次 GET 并列出 NAS", async () => {
    const fetchMock = openApp("/center?tab=mount-sources", ADMIN);

    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("cell", { name: "NAS" })).toBeTruthy();
    expect(currentLocation()).toBe("/center?tab=mount-sources");
    expect(tabStates()).toEqual([
      ["专家", "false"],
      ["技能", "false"],
      ["连接器", "false"],
      ["模型", "false"],
      ["挂载源", "true"],
    ]);
    expect(within(main).getByRole("button", { name: "登记挂载源" })).toBeTruthy();
    expect(calls(fetchMock, "/api/mount-sources")).toHaveLength(1);
  });
});
