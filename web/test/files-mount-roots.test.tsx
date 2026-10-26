/**
 * s1b-workspace-mounts 任务 10.3：workspace-mounts「挂载根行」的三个场景（「在线、只读与离线」「卸载」「两处同一份
 * 实现」）与同一 requirement 的其余条款（无 `更多操作`、不可拖、不是放下目标、`位置` 下拉、`GET …/mounts` 失败、
 * `刷新` 重取、不轮询），files-web「工作空间页」「有挂载时的菜单与空根」的空根部分。
 *
 * 接缝：文件页与会话页侧边栏的真实外壳（桩掉的 `fetch`），「不轮询」的句柄一例直接渲染 `WorkspaceBrowser`。挂载
 * 端点的请求经 `calls(fetchMock, path)` 显式计数（共享的 `paths()` / `since()` 滤掉它们，见 `support.ts`）。
 * 期望值是规格里的字面量：图标、`只读`、`在线` / `离线`、副行 `<host>:<remotePath>`、确认框的标题与说明、
 * `离线，重新连接后可浏览`；请求地址按端点约定手写（`tree?path=` 整段编码、`…/mounts/<id>`）。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import {
  listing,
  mountSidebarPage,
  openSidebar,
  dir as sidebarDir,
  file as sidebarFile,
  treeOf,
  W1,
} from "./chat-workspace-sidebar-support.js";
import {
  expectEmptyPreview,
  findRow,
  previewRegion,
  row,
  rowNames,
  settle,
  tree,
} from "./files-deep-link-support.js";
import {
  chooseCreationMenuItem,
  cleanupFilesFixture,
  expectLocation,
  hasLucideGlyph,
} from "./files-fixture.js";
import {
  cancelButton,
  deleted,
  dirEntry,
  dragOnto,
  dropOn,
  entriesUrl,
  expand,
  fileEntry,
  fileUrl,
  type Listings,
  MOVE,
  openDelete,
  openFiles,
  openRename,
  renameTo,
  rowsUnder,
  treeUrl,
} from "./files-ops-support.js";
import { calls, createFetchMock, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const ROOT = "设计文档";
const DW = "数据仓库导出";
const SHARE = "产品共享盘";
const LOCAL = "资料";
const OFFLINE_NOTE = "离线，重新连接后可浏览";

const view = {
  backend: "sftp",
  port: 22,
  sourceId: null,
  sourceName: null,
  readOnly: false,
  status: "online",
  createdAt: 1_760_000_000_000,
};
/** 在线只读 `sftp`。 */
const dw = {
  ...view,
  id: "m-dw",
  name: DW,
  host: "dw-node-02.intra",
  remotePath: "/export/dw",
  readOnly: true,
};
/** 离线可写 `smb`。 */
const share = {
  ...view,
  id: "m-share",
  name: SHARE,
  backend: "smb",
  port: null,
  host: "nas.intra",
  remotePath: "/share",
  status: "offline",
};
/** 在线可写 `local`。 */
const local = {
  ...view,
  id: "m-local",
  name: LOCAL,
  backend: "local",
  host: null,
  port: null,
  remotePath: null,
  sourceId: "s-1",
  sourceName: "资料库",
};

type Mount = typeof dw | typeof share | typeof local;

const NOT_FOUND = () =>
  jsonResponse({ error: { code: "not_found", message: "请求的资源不存在" } }, 404);

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await cleanupSessionMeta();
});

/** 一个可改的挂载列表：`GET …/mounts` 每次读它此刻的值。 */
function mountsRoute(initial: Mount[]) {
  const state = { mounts: initial };
  return { state, route: () => jsonResponse({ enabled: true, mounts: state.mounts }) };
}

/** 文件页；根下只有目录 `out`（服务端不列出挂载点），`数据仓库导出` 里是 `a.csv` 与目录 `2026`。 */
function openPage(mounts: Mount[], listings: Partial<Listings> = {}, extra = {}) {
  const list = mountsRoute(mounts);
  const page = openFiles(
    {
      "": [dirEntry("out")],
      out: [fileEntry("a.md")],
      [DW]: [fileEntry("a.csv"), dirEntry("2026")],
      [`${DW}/2026`]: [],
      [LOCAL]: [dirEntry("报告")],
      [`${LOCAL}/报告`]: [],
      [SHARE]: [fileEntry("s.md")],
      ...listings,
    } as Listings,
    { [MOUNTS]: list.route, ...extra },
  );
  return { ...page, list, mountsGets: () => calls(page.fetchMock, MOUNTS).length };
}

/** 挂载根行（`<li>`），按名字。 */
function mountRow(name: string, scope: HTMLElement = tree()) {
  const found = [...scope.querySelectorAll<HTMLElement>('[data-slot="mount-root"]')].find(
    (item) => item.querySelector('[data-slot="tree-name"]')?.textContent === name,
  );
  if (!found) throw new Error(`expected a mount root row named ${name}`);
  return found;
}

/** 每个挂载根行看得到的东西，自上而下（只看行本身那一条，不看展开后的子行）。 */
function mountFacts(scope: HTMLElement) {
  return [...scope.querySelectorAll<HTMLElement>('[data-slot="mount-root"]')].map((item) => {
    const line = item.firstElementChild as HTMLElement;
    const name = line.querySelector('[data-slot="tree-name"]')?.textContent ?? "";
    return {
      name,
      icon: ["cloud", "folder"].filter((glyph) => hasLucideGlyph(line, glyph)),
      readOnly: within(line).queryByText("只读", { exact: true }) !== null,
      status: line.querySelector('[data-slot="mount-status"]')?.textContent,
      subline: item.querySelector(':scope > [data-slot="tree-root-path"]')?.textContent ?? null,
      expandable: within(line).queryByRole("button", { name: `展开 ${name}` }) !== null,
      unmount: within(line).queryByRole("button", { name: `卸载 ${name}` }) !== null,
      menu: within(item).queryByRole("button", { name: `更多操作 ${name}` }) !== null,
      offlineNote: within(item).queryByText(OFFLINE_NOTE) !== null,
    };
  });
}

const DW_FACTS = {
  name: DW,
  icon: ["cloud"],
  readOnly: true,
  status: "在线",
  subline: "dw-node-02.intra:/export/dw",
  expandable: true,
  unmount: true,
  menu: false,
  offlineNote: false,
};
const SHARE_FACTS = {
  name: SHARE,
  icon: ["cloud"],
  readOnly: false,
  status: "离线",
  subline: "nas.intra:/share",
  expandable: false,
  unmount: true,
  menu: false,
  offlineNote: true,
};

async function mountRowsShown(names: string[], scope?: HTMLElement) {
  await waitFor(() =>
    expect(
      [...(scope ?? tree()).querySelectorAll('[data-slot="mount-root"] [data-slot="tree-name"]')]
        .filter((node) => node.closest('[data-slot="mount-root"] ul') === null)
        .map((node) => node.textContent),
    ).toStrictEqual(names),
  );
}

/** `位置` 下拉的各项文字。 */
async function locationOptions() {
  await chooseCreationMenuItem("新建文件夹");
  const dialog = await screen.findByRole("dialog", { name: "新建文件夹" });
  const options = [...within(dialog).getByLabelText<HTMLSelectElement>("位置").options].map(
    (option) => option.textContent,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建文件夹" })).toBeNull());
  return options;
}

describe("挂载根行：在线、只读与离线", () => {
  it("空间根之下只有 out；其后依次是两个挂载根行：数据仓库导出 cloud、只读、在线、副行 host:remotePath，展开恰一次 tree?path=数据仓库导出；产品共享盘 离线、不可展开、其下是离线说明、点击不发请求", async () => {
    const page = openPage([dw, share]);
    await findRow(`折叠 ${ROOT}`);
    await mountRowsShown([DW, SHARE]);

    expect(rowsUnder(ROOT)).toStrictEqual(["out"]);
    expect(rowNames()).toStrictEqual([ROOT, "out", DW, SHARE]);
    expect(mountFacts(tree())).toStrictEqual([DW_FACTS, SHARE_FACTS]);
    expect(page.mountsGets()).toBe(1);

    const before = page.fetchMock.mock.calls.length;
    fireEvent.click(within(mountRow(SHARE)).getByText(SHARE));
    await settle();
    expect(page.fetchMock.mock.calls.length).toBe(before);
    expect(within(mountRow(SHARE)).queryByRole("button", { name: `展开 ${SHARE}` })).toBeNull();
    expect(mountRow(SHARE).querySelector("ul")).toBeNull();

    const since = page.mark();
    fireEvent.click(row(`展开 ${DW}`));
    await findRow(`折叠 ${DW}`);
    await waitFor(() => expect(within(mountRow(DW)).getByText("a.csv")).toBeTruthy());
    expect(since()).toStrictEqual([treeUrl(DW)]);
    expect(row(`折叠 ${DW}`).getAttribute("aria-expanded")).toBe("true");
  });

  it("local 挂载：folder 图标，副行是挂载源名称；没有只读标签", async () => {
    openPage([local]);
    await mountRowsShown([LOCAL]);

    expect(mountFacts(tree())).toStrictEqual([
      { ...DW_FACTS, name: LOCAL, icon: ["folder"], readOnly: false, subline: "资料库" },
    ]);
  });

  it("新建文件夹的位置下拉不含只读或离线挂载：两挂载都不在；在线可写的 local 与它已加载的子目录在", async () => {
    openPage([dw, share, local]);
    await mountRowsShown([DW, SHARE, LOCAL]);
    await expand(DW);
    await expand(LOCAL);
    await expand("报告");

    expect(await locationOptions()).toStrictEqual([`根目录　${ROOT}`, LOCAL, `${LOCAL}/报告`]);
  });

  it("在线可写的挂载经 刷新 变为离线：它与它下面已加载的目录离开位置下拉，行显示离线说明、不再有子行", async () => {
    const page = openPage([{ ...share, status: "online" }]);
    await mountRowsShown([SHARE]);
    await expand(SHARE);
    expect(await locationOptions()).toStrictEqual([`根目录　${ROOT}`, SHARE]);

    page.list.state.mounts = [share];
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(mountFacts(tree())).toStrictEqual([SHARE_FACTS]));
    expect(within(mountRow(SHARE)).queryByText("s.md")).toBeNull();
    expect(await locationOptions()).toStrictEqual([`根目录　${ROOT}`]);
  });

  it("挂载根行没有更多操作、不可拖动、不是放下目标；挂载里的子行照常有行菜单", async () => {
    const page = openPage([dw]);
    await mountRowsShown([DW]);
    await expand(DW);

    const mountButton = row(`折叠 ${DW}`);
    expect(mountButton.hasAttribute("draggable")).toBe(false);
    expect(within(mountRow(DW)).queryByRole("button", { name: `更多操作 ${DW}` })).toBeNull();
    expect(within(mountRow(DW)).getByRole("button", { name: "更多操作 a.csv" })).toBeTruthy();

    const source = row("展开 out");
    const { accepted, transfer } = dragOnto(source, mountButton);
    expect(accepted).toBe(false);
    expect(mountButton.hasAttribute("data-drop-target")).toBe(false);
    dropOn(source, mountButton, transfer);
    await settle();
    expect(calls(page.fetchMock, MOVE)).toStrictEqual([]);
  });
});

describe("挂载根行：卸载", () => {
  it("选中 数据仓库导出/a.csv 后点 卸载：确认框标题、说明、两按钮、焦点在取消；取消零请求；确认恰一次 DELETE，行消失、选中清除、挂载列表重取，不重列目录", async () => {
    const page = openPage(
      [dw, share],
      {},
      {
        [fileUrl(`${DW}/a.csv`)]: () => textPreviewResponse("a,b\n1,2"),
        [`${MOUNTS}/m-dw`]: () => {
          page.list.state.mounts = [share];
          return deleted();
        },
      },
    );
    await mountRowsShown([DW, SHARE]);
    await expand(DW);
    fireEvent.click(await findRow("a.csv"));
    await expectLocation(`/files?ws=workspace-1&path=${encodeURIComponent(`${DW}/a.csv`)}`);
    await waitFor(() => expect(previewRegion().getByText(`${DW}/a.csv`)).toBeTruthy());

    const since = page.mark();
    const before = page.fetchMock.mock.calls.length;
    fireEvent.click(row(`卸载 ${DW}`));
    const dialog = await screen.findByRole("alertdialog", { name: `卸载「${DW}」？` });
    const note = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("只断开挂载，远端文件不受影响。");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toStrictEqual(["取消", "卸载"]);
    await waitFor(() => expect(document.activeElement).toBe(cancelButton(dialog)));

    fireEvent.click(cancelButton(dialog));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(page.fetchMock.mock.calls.length).toBe(before);
    expect(page.mountsGets()).toBe(1);
    expect(since()).toStrictEqual([]);

    await yieldMacrotask();
    fireEvent.click(row(`卸载 ${DW}`));
    const again = await screen.findByRole("alertdialog", { name: `卸载「${DW}」？` });
    fireEvent.click(within(again).getByRole("button", { name: "卸载" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await mountRowsShown([SHARE]);

    expect(calls(page.fetchMock, `${MOUNTS}/m-dw`).map(([, options]) => options?.method)).toEqual([
      "DELETE",
    ]);
    await waitFor(() => expect(page.mountsGets()).toBe(2));
    expect(since()).toStrictEqual([]);
    await expectLocation("/files?ws=workspace-1");
    expectEmptyPreview();
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();
  });

  it("DELETE 答 404：确认框里显示信封文案、仍开着，行还在，挂载列表不重取", async () => {
    const page = openPage([dw], {}, { [`${MOUNTS}/m-dw`]: NOT_FOUND });
    await mountRowsShown([DW]);

    fireEvent.click(row(`卸载 ${DW}`));
    const dialog = await screen.findByRole("alertdialog", { name: `卸载「${DW}」？` });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    expect(screen.getByRole("alertdialog", { name: `卸载「${DW}」？` })).toBe(dialog);
    expect(calls(page.fetchMock, `${MOUNTS}/m-dw`)).toHaveLength(1);
    expect(page.mountsGets()).toBe(1);
    expect(mountFacts(document.body).map((facts) => facts.name)).toStrictEqual([DW]);
  });

  it("选中的文件不在被卸载的挂载里：选中与地址不变", async () => {
    const page = openPage(
      [dw],
      {},
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("甲"),
        [`${MOUNTS}/m-dw`]: () => {
          page.list.state.mounts = [];
          return deleted();
        },
      },
    );
    await mountRowsShown([DW]);
    await expand("out");
    fireEvent.click(await findRow("a.md"));
    await expectLocation(`/files?ws=workspace-1&path=${encodeURIComponent("out/a.md")}`);

    fireEvent.click(row(`卸载 ${DW}`));
    const dialog = await screen.findByRole("alertdialog", { name: `卸载「${DW}」？` });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
    await mountRowsShown([]);

    await expectLocation(`/files?ws=workspace-1&path=${encodeURIComponent("out/a.md")}`);
    expect(row("a.md").getAttribute("aria-current")).toBe("true");
  });
});

describe("挂载根行：卸载之后的焦点", () => {
  it("确认卸载成功：焦点回到空间根那一行的按钮，不落在 body 上", async () => {
    const page = openPage(
      [dw, share],
      {},
      {
        [`${MOUNTS}/m-dw`]: () => {
          page.list.state.mounts = [share];
          return deleted();
        },
      },
    );
    await mountRowsShown([DW, SHARE]);

    fireEvent.click(row(`卸载 ${DW}`));
    const dialog = await screen.findByRole("alertdialog", { name: `卸载「${DW}」？` });
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await mountRowsShown([SHARE]);

    await waitFor(() => expect(document.activeElement).toBe(row(`折叠 ${ROOT}`)));
  });
});

describe("挂载列表的读取", () => {
  it("GET …/mounts 失败：不渲染挂载根行，树区上方 role=alert 是信封文案，空间根照常可用", async () => {
    const page = openPage(
      [],
      {},
      {
        [MOUNTS]: () =>
          jsonResponse({ error: { code: "internal", message: "服务器开小差了" } }, 500),
      },
    );
    await findRow(`折叠 ${ROOT}`);

    const column = screen.getByRole("complementary", { name: "工作空间文件" });
    await waitFor(() =>
      expect(
        within(column)
          .queryAllByRole("alert")
          .filter((alert) => alert.closest("nav") === null)
          .map((alert) => alert.textContent),
      ).toStrictEqual(["服务器开小差了"]),
    );
    expect(document.querySelector('[data-slot="mount-root"]')).toBeNull();
    await expand("out");
    expect(rowsUnder("out")).toStrictEqual(["a.md"]);
    expect(page.mountsGets()).toBe(1);
  });

  it("进入空间恰一次；展开、选中、删除、移动（改名）之后都不重取；刷新 重取一次并显示新状态", async () => {
    const page = openPage(
      [dw],
      { out: [fileEntry("a.md"), fileEntry("b.md")] },
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("甲"),
        [entriesUrl("out/b.md")]: deleted,
        [MOVE]: () => jsonResponse({ path: "out/c.md" }),
      },
    );
    await mountRowsShown([DW]);
    await expand("out");
    await expand(DW);
    fireEvent.click(await findRow("a.md"));
    await waitFor(() => expect(previewRegion().getByText("甲")).toBeTruthy());

    const confirm = await openDelete("b.md");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    renameTo(await openRename("a.md"), "c.md");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull());
    await settle();
    expect(calls(page.fetchMock, MOVE)).toHaveLength(1);
    expect(page.mountsGets()).toBe(1);

    page.list.state.mounts = [{ ...dw, status: "offline" }];
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(page.mountsGets()).toBe(2));
    await waitFor(() =>
      expect(mountFacts(tree())).toStrictEqual([
        { ...DW_FACTS, status: "离线", expandable: false, offlineNote: true },
      ]),
    );
    await settle();
    expect(page.mountsGets()).toBe(2);
  });

  it("离线的挂载恢复在线：点一次 刷新 就重列它已加载的各层（恰一次），新条目出现；每次 刷新 恰一次 GET …/mounts", async () => {
    let entries = [dirEntry("2026"), fileEntry("a.csv")];
    const page = openPage([dw], {}, { [treeUrl(DW)]: () => jsonResponse({ path: DW, entries }) });
    await mountRowsShown([DW]);
    await expand(DW);
    await expand("2026");
    expect(page.mountsGets()).toBe(1);

    page.list.state.mounts = [{ ...dw, status: "offline" }];
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(mountFacts(tree())[0]?.status).toBe("离线"));
    await settle();
    expect(page.mountsGets()).toBe(2);

    entries = [dirEntry("2026"), fileEntry("a.csv"), fileEntry("b.csv")];
    page.list.state.mounts = [dw];
    const since = page.mark();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(rowsUnder(DW)).toStrictEqual(["2026", "a.csv", "b.csv"]));
    await settle();
    expect(page.mountsGets()).toBe(3);
    expect(since().filter((path) => path === treeUrl(DW))).toHaveLength(1);
    expect(since().filter((path) => path === treeUrl(`${DW}/2026`))).toHaveLength(1);
  });

  it("句柄的 refresh（会话页侧边栏随助手改动调用）不重取挂载列表；换一个 workspaceId 取那个空间的", async () => {
    const fetchMock = createFetchMock({
      [MOUNTS]: () => jsonResponse({ enabled: true, mounts: [dw] }),
      "/api/workspaces/workspace-2/mounts": () => jsonResponse({ enabled: true, mounts: [] }),
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [dirEntry("out")] }),
      [treeUrl("out")]: () => jsonResponse({ path: "out", entries: [] }),
      "/api/workspaces/workspace-2/tree?path=": () => jsonResponse({ path: "", entries: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();
    const handle = createRef<WorkspaceBrowserHandle>();
    const props = { account: "zhangsan", client, onPathChange: () => {}, path: null };
    const view = render(<WorkspaceBrowser {...props} ref={handle} workspaceId="workspace-1" />);
    await mountRowsShown([DW]);

    act(() => handle.current?.refresh());
    act(() => handle.current?.refresh(["out/a.md"]));
    await settle();
    expect(calls(fetchMock, MOUNTS)).toHaveLength(1);

    view.rerender(<WorkspaceBrowser {...props} ref={handle} workspaceId="workspace-2" />);
    await waitFor(() =>
      expect(calls(fetchMock, "/api/workspaces/workspace-2/mounts")).toHaveLength(1),
    );
    await mountRowsShown([]);
    expect(calls(fetchMock, MOUNTS)).toHaveLength(1);
  });
});

describe("空根", () => {
  it("根 tree 为空而有挂载：空间根之下显示 空目录 而不是 该工作空间暂无目录，其后是挂载根行", async () => {
    openPage([dw], { "": [] });
    await mountRowsShown([DW]);

    const rootItem = row(`折叠 ${ROOT}`).closest("li") as HTMLElement;
    expect(within(rootItem).getByText("空目录")).toBeTruthy();
    expect(screen.queryByText("该工作空间暂无目录")).toBeNull();
    expect(screen.queryByText("点击左上角 ＋ 新建文件夹")).toBeNull();
    expect(rowNames()).toStrictEqual([ROOT, DW]);
  });

  it("对照：根 tree 为空且没有挂载（功能开着）时仍是 该工作空间暂无目录", async () => {
    const page = openPage([], { "": [] });
    await findRow(`折叠 ${ROOT}`);
    await waitFor(() => expect(page.mountsGets()).toBe(1));
    await settle();

    expect(await screen.findByText("该工作空间暂无目录")).toBeTruthy();
    expect(screen.getByText("点击左上角 ＋ 新建文件夹")).toBeTruthy();
    expect(screen.queryByText("空目录")).toBeNull();
  });
});

describe("挂载根行：两处同一份实现", () => {
  it("会话页侧边栏里同一空间的挂载根行、状态、只读标签与卸载与文件页相同；侧边栏的新建菜单没有 挂载目录", async () => {
    const mounts = `/api/workspaces/${W1.id}/mounts`;
    await mountSidebarPage(undefined, {
      [mounts]: () => jsonResponse({ enabled: true, mounts: [dw, share] }),
      [treeOf(W1.id, DW)]: listing(DW, [sidebarFile("a.csv"), sidebarDir("2026")]),
    });
    const { region } = await openSidebar("readme.md");
    await mountRowsShown([DW, SHARE], region);

    expect(mountFacts(region)).toStrictEqual([DW_FACTS, SHARE_FACTS]);
    fireEvent.click(within(region).getByRole("button", { name: `展开 ${DW}` }));
    await waitFor(() => expect(within(mountRow(DW, region)).getByText("a.csv")).toBeTruthy());

    await yieldMacrotask();
    const create = within(region).getByRole("button", { name: "新建" });
    fireEvent.pointerDown(create, { button: 0, clientX: 500, clientY: 500 });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toStrictEqual(["新建文件夹"]);
    expect(within(menu).queryByRole("menuitem", { name: "挂载目录" })).toBeNull();
  });
});
