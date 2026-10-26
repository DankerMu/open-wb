/**
 * s1b-workspace-mounts 任务 11.2：workspace-mounts「挂载对话框」的三个场景（「入口随开关」「提交与失败就地显示」
 * 「本地校验与服务器目录」）与同一 requirement 的其余条款（保留名、`aria-modal` 与初始焦点、请求中禁用与 `取消`
 * 中止、关闭后凭证清空、地址与 Web Storage 无私钥、无 Toast），files-web「有挂载时的菜单与空根」的菜单部分。
 *
 * 接缝：文件页的真实外壳（真实 `createApiClient`，桩掉的 `fetch`，同组 10）。挂载端点与 `/api/mount-sources` 的
 * 请求经 `calls(fetchMock, path)` 显式计数。期望值是规格里的字面量（菜单项、字段名、placeholder、校验文案、
 * `正在连接…`、` · 只读`、`管理员尚未登记服务器目录`；超长名称与 SMB 缺共享名两条文案取自 design D18）与服务端契约（`server/src/workspaces/mounts/validate.ts`：
 * 键集按 `backend` 严格、`port` / `domain` 可空即不带该键；`core/errors` 的 `mount_host_rejected` 文案）。
 * 私钥是低熵的测试哨兵，不是任何真实密钥。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findRow, row, rowNames, settle, tree } from "./files-deep-link-support.js";
import { chooseCreationMenuItem, cleanupFilesFixture } from "./files-fixture.js";
import { dirEntry, fileEntry, type Listings, openFiles, treeUrl } from "./files-ops-support.js";
import { calls, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const SOURCES = "/api/mount-sources";
const SENTINEL = "PRIVATE_KEY_SENTINEL";
const PRIVATE_KEY = `-----BEGIN TEST FIXTURE-----\n${SENTINEL}\n-----END TEST FIXTURE-----`;
const DEMO_HINT = "仅允许内网主机，公网地址将被拒绝";
const HOST_REJECTED = { error: { code: "mount_host_rejected", message: "该主机不允许挂载" } };

type Route = (path: string, options?: RequestInit) => Response | Promise<Response>;

const remote = {
  id: "m-remote",
  name: "远端",
  backend: "sftp",
  host: "files.intra",
  port: null,
  remotePath: "/srv/remote",
  sourceId: null,
  sourceName: null,
  readOnly: false,
  status: "online",
  createdAt: 1_760_000_000_000,
};
/** `POST` 的 201：新挂载 `数据`。 */
const created = {
  ...remote,
  id: "m-data",
  name: "数据",
  host: "files2.intra",
  remotePath: "/srv/data",
  readOnly: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * 文件页；`GET …/mounts` 每次读 `state` 此刻的值（`list` 给了就换成它）；`POST …/mounts` 交给 `post`。
 * 根下只有 `out`，`数据` 里是 `a.csv`。
 */
function openPage(
  options: { enabled?: boolean; post?: Route; sources?: Route; list?: Route; root?: Listings } = {},
) {
  const state = { mounts: [] as (typeof remote)[] };
  const list: Route =
    options.list ??
    (() => jsonResponse({ enabled: options.enabled ?? true, mounts: state.mounts }));
  const page = openFiles(
    { "": [dirEntry("out")], out: [], 数据: [fileEntry("a.csv")], ...options.root },
    {
      [MOUNTS]: (path, init) => {
        if (init?.method === "POST") {
          if (!options.post) throw new Error("unexpected POST …/mounts");
          return options.post(path, init);
        }
        return list(path, init);
      },
      ...(options.sources ? { [SOURCES]: options.sources } : {}),
    },
  );
  return {
    ...page,
    state,
    mountsGets: () => calls(page.fetchMock, MOUNTS).filter(([, init]) => init?.method !== "POST"),
    posts: () => calls(page.fetchMock, MOUNTS).filter(([, init]) => init?.method === "POST"),
    sourceGets: () => calls(page.fetchMock, SOURCES),
  };
}

type Page = ReturnType<typeof openPage>;

/** 等根列表与挂载列表都回来（菜单只在后者回来之后才可能有 `挂载目录`）。 */
async function ready(page: Page) {
  await findRow("折叠 设计文档");
  await waitFor(() => expect(page.mountsGets()).toHaveLength(1));
  await settle();
}

/** 打开 `新建` 菜单，读出各项，再按 Escape 关掉。 */
async function menuItems() {
  await yieldMacrotask();
  pressPointer(screen.getByRole("button", { name: "新建" }));
  const menu = await screen.findByRole("menu");
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return items;
}

async function openDialog() {
  await chooseCreationMenuItem("挂载目录");
  return screen.findByRole("dialog", { name: "挂载目录" });
}

/** 输入框（`密码` / `私钥` 也是 `认证方式` 两个 radio 的名字，按元素种类排除它们）。 */
const TEXT_FIELD = { selector: "input, textarea" };

function field<T extends HTMLElement = HTMLInputElement>(dialog: HTMLElement, label: string) {
  return within(dialog).getByLabelText<T>(label, TEXT_FIELD);
}

function maybeField(dialog: HTMLElement, label: string) {
  return within(dialog).queryByLabelText(label, TEXT_FIELD);
}

function type(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(field(dialog, label), { target: { value } });
}

/** 拷入层 select：Enter 打开，Enter 选中（写法同 `center-connectors-support.tsx` 的 `chooseType`）。 */
async function choose(dialog: HTMLElement, label: string, option: string) {
  const trigger = within(dialog).getByRole("combobox", { name: label });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.keyDown(await screen.findByRole("option", { name: option }), { key: "Enter" });
  await waitFor(() => expect(trigger.textContent).toBe(option));
}

function radio(dialog: HTMLElement, name: "密码" | "私钥") {
  return within(dialog).getByRole("radio", { name });
}

function readOnlySwitch(dialog: HTMLElement) {
  return within(dialog).getByRole("switch", { name: "只读挂载" });
}

function submitButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "测试连通并挂载" });
}

function submit(dialog: HTMLElement) {
  fireEvent.click(submitButton(dialog));
}

/** 对话框里 `role="alert"` 的文案（没有为 null）。 */
function alertText(dialog: HTMLElement) {
  return within(dialog).queryByRole("alert")?.textContent ?? null;
}

/** 「提交与失败就地显示」的一套 SFTP + 私钥取值。 */
function fillSftpKey(dialog: HTMLElement, host = "files.intra") {
  type(dialog, "挂载名称", "数据");
  type(dialog, "主机", host);
  type(dialog, "目录路径", "/srv/data");
  type(dialog, "用户名", "reader");
  fireEvent.click(radio(dialog, "私钥"));
  type(dialog, "私钥", PRIVATE_KEY);
}

function bodyOf(call: ReturnType<typeof calls>[number] | undefined) {
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

/** 地址与两个 Web Storage 的全部键值。 */
function exposed() {
  const storage = (store: Storage) =>
    Array.from({ length: store.length }, (_, index) => {
      const key = store.key(index) ?? "";
      return `${key}=${store.getItem(key)}`;
    });
  return [window.location.href, ...storage(localStorage), ...storage(sessionStorage)].join("\n");
}

describe("挂载对话框：入口随开关", () => {
  it("enabled 为 false：新建 菜单恰为 新建文件夹、新建工作空间", async () => {
    const page = openPage({ enabled: false });
    await ready(page);

    expect(await menuItems()).toStrictEqual(["新建文件夹", "新建工作空间"]);
  });

  it("enabled 为 true：依次为 新建文件夹、挂载目录、新建工作空间", async () => {
    const page = openPage();
    await ready(page);

    expect(await menuItems()).toStrictEqual(["新建文件夹", "挂载目录", "新建工作空间"]);
  });

  it("尚未取到 GET …/mounts（应答挂起）时没有 挂载目录；取列表失败时也没有", async () => {
    const pending = openPage({ list: () => new Promise<Response>(() => {}) });
    await findRow("折叠 设计文档");
    await waitFor(() => expect(pending.mountsGets()).toHaveLength(1));
    expect(await menuItems()).toStrictEqual(["新建文件夹", "新建工作空间"]);
    cleanupFilesFixture();

    const failed = openPage({
      list: () => jsonResponse({ error: { code: "internal", message: "服务器开小差了" } }, 500),
    });
    await ready(failed);
    expect(await menuItems()).toStrictEqual(["新建文件夹", "新建工作空间"]);
  });

  it("files-web 有挂载时的菜单与空根：根 tree 为空、挂载 远端 在列表里——空间根下是 空目录、其后 远端 根行，菜单依次三项", async () => {
    const page = openPage({ root: { "": [] } });
    page.state.mounts = [remote];
    await ready(page);
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "远端"]));

    expect(screen.queryByText("该工作空间暂无目录")).toBeNull();
    const rootItem = row("折叠 设计文档").closest("li") as HTMLElement;
    expect(within(rootItem).getByText("空目录")).toBeTruthy();
    expect(await menuItems()).toStrictEqual(["新建文件夹", "挂载目录", "新建工作空间"]);
  });
});

describe("挂载对话框：外观", () => {
  it("aria-modal、标题、初始焦点在 挂载名称；SFTP 缺省的字段、placeholder、密码框属性、只读开关与两个按钮；不沿用 demo 的内网提示", async () => {
    const page = openPage();
    await ready(page);
    const dialog = await openDialog();

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const name = field(dialog, "挂载名称");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.placeholder).toBe("例如 数据仓库导出");
    expect(within(dialog).getByRole("combobox", { name: "协议" }).textContent).toBe("SFTP");
    expect(field(dialog, "端口").placeholder).toBe("22");
    expect(field(dialog, "目录路径").placeholder).toBe("/srv/data");
    expect(field(dialog, "主机")).toBeTruthy();
    expect(field(dialog, "用户名")).toBeTruthy();
    expect(within(dialog).getByRole("radiogroup", { name: "认证方式" })).toBeTruthy();
    expect(within(dialog).getByText("认证方式")).toBeTruthy();
    expect(radio(dialog, "密码").getAttribute("aria-checked")).toBe("true");
    expect(radio(dialog, "私钥").getAttribute("aria-checked")).toBe("false");
    const password = field(dialog, "密码");
    expect(password.type).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(maybeField(dialog, "私钥")).toBeNull();
    expect(maybeField(dialog, "域")).toBeNull();

    const readOnly = readOnlySwitch(dialog);
    expect(readOnly.getAttribute("aria-checked")).toBe("true");
    expect(readOnly.hasAttribute("disabled")).toBe(false);
    const note = document.getElementById(readOnly.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("禁止写入，防止误改源目录");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((text) => text === "取消" || text === "测试连通并挂载"),
    ).toStrictEqual(["取消", "测试连通并挂载"]);
    expect(document.body.textContent).not.toContain(DEMO_HINT);

    fireEvent.click(radio(dialog, "私钥"));
    const key = field<HTMLTextAreaElement>(dialog, "私钥");
    expect(key.tagName).toBe("TEXTAREA");
    expect(key.getAttribute("spellcheck")).toBe("false");
    expect(key.getAttribute("autocomplete")).toBe("off");
    expect(maybeField(dialog, "密码")).toBeNull();
  });

  it("SMB：端口 placeholder 445、目录路径 /共享名/目录、有 域、没有 认证方式；协议下拉恰三项", async () => {
    const page = openPage();
    await ready(page);
    const dialog = await openDialog();

    const trigger = within(dialog).getByRole("combobox", { name: "协议" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toStrictEqual([
      "SFTP",
      "SMB",
      "服务器目录",
    ]);
    fireEvent.keyDown(screen.getByRole("option", { name: "SMB" }), { key: "Enter" });
    await waitFor(() => expect(trigger.textContent).toBe("SMB"));

    expect(field(dialog, "端口").placeholder).toBe("445");
    expect(field(dialog, "目录路径").placeholder).toBe("/共享名/目录");
    expect(field(dialog, "域")).toBeTruthy();
    expect(field(dialog, "密码").type).toBe("password");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).queryByText("认证方式")).toBeNull();
    expect(page.sourceGets()).toHaveLength(0);
  });
});

describe("挂载对话框：提交与失败就地显示", () => {
  it("SFTP + 私钥：403 时恰一次 POST、键集恰七个、框内显示 该主机不允许挂载 且值保留；改主机后 201：关闭、重取 mounts、数据 根行出现并展开、焦点在该行；无 Toast，地址与 Web Storage 无私钥", async () => {
    const answers = [jsonResponse(HOST_REJECTED, 403)];
    const page = openPage({
      post: () => {
        const answer = answers.shift();
        if (answer) return answer;
        page.state.mounts = [created];
        return jsonResponse(created, 201);
      },
    });
    await ready(page);
    const dialog = await openDialog();
    fillSftpKey(dialog);
    submit(dialog);

    await waitFor(() => expect(alertText(dialog)).toBe("该主机不允许挂载"));
    expect(page.posts()).toHaveLength(1);
    const [first] = page.posts();
    expect(first?.[1]?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(Object.keys(bodyOf(first)).sort()).toStrictEqual(
      ["backend", "host", "name", "privateKey", "readOnly", "remotePath", "username"].sort(),
    );
    expect(bodyOf(first)).toStrictEqual({
      name: "数据",
      backend: "sftp",
      host: "files.intra",
      remotePath: "/srv/data",
      readOnly: true,
      username: "reader",
      privateKey: PRIVATE_KEY,
    });
    expect(screen.getByRole("dialog", { name: "挂载目录" })).toBe(dialog);
    expect(field(dialog, "挂载名称").value).toBe("数据");
    expect(field(dialog, "主机").value).toBe("files.intra");
    expect(field(dialog, "目录路径").value).toBe("/srv/data");
    expect(field(dialog, "用户名").value).toBe("reader");
    expect(field<HTMLTextAreaElement>(dialog, "私钥").value).toBe(PRIVATE_KEY);
    expect(page.mountsGets()).toHaveLength(1);
    expect(screen.getAllByText("该主机不允许挂载")).toHaveLength(1);

    type(dialog, "主机", "files2.intra");
    submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());
    expect(page.posts()).toHaveLength(2);
    expect(bodyOf(page.posts()[1])).toMatchObject({ host: "files2.intra" });
    await waitFor(() => expect(page.mountsGets()).toHaveLength(2));
    const mountButton = await findRow("折叠 数据");
    expect(mountButton.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(within(tree()).getByText("a.csv")).toBeTruthy());
    expect(calls(page.fetchMock, treeUrl("数据"))).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(mountButton));
    await settle();
    expect(document.activeElement).toBe(mountButton);

    expect(document.body.textContent).not.toContain("已挂载");
    expect(screen.queryByText("该主机不允许挂载")).toBeNull();
    expect(screen.queryAllByRole("status")).toStrictEqual([]);
    expect(exposed()).not.toContain(SENTINEL);
    expect(exposed()).not.toContain("BEGIN TEST FIXTURE");
  });

  it("SFTP + 密码带端口：port 是数字、没有 privateKey；先填过私钥再换回密码也不带它", async () => {
    const page = openPage({ post: () => jsonResponse(HOST_REJECTED, 403) });
    await ready(page);
    const dialog = await openDialog();
    fillSftpKey(dialog);
    fireEvent.click(radio(dialog, "密码"));
    type(dialog, "密码", "pw-1");
    type(dialog, "端口", "2222");
    submit(dialog);

    await waitFor(() => expect(page.posts()).toHaveLength(1));
    expect(bodyOf(page.posts()[0])).toStrictEqual({
      name: "数据",
      backend: "sftp",
      host: "files.intra",
      port: 2222,
      remotePath: "/srv/data",
      readOnly: true,
      username: "reader",
      password: "pw-1",
    });
  });

  it("SMB：域与端口留空不带这两个键；填了就带上；先在 SFTP 填过私钥也不带它；关掉 只读挂载 即 readOnly false", async () => {
    const page = openPage({ post: () => jsonResponse(HOST_REJECTED, 403) });
    await ready(page);
    const dialog = await openDialog();
    fillSftpKey(dialog);
    await choose(dialog, "协议", "SMB");
    type(dialog, "目录路径", "/share/dir");
    type(dialog, "密码", "pw-2");
    fireEvent.click(readOnlySwitch(dialog));
    submit(dialog);

    await waitFor(() => expect(page.posts()).toHaveLength(1));
    expect(bodyOf(page.posts()[0])).toStrictEqual({
      name: "数据",
      backend: "smb",
      host: "files.intra",
      remotePath: "/share/dir",
      readOnly: false,
      username: "reader",
      password: "pw-2",
    });

    await waitFor(() => expect(alertText(dialog)).toBe("该主机不允许挂载"));
    type(dialog, "域", "CORP");
    type(dialog, "端口", "445");
    submit(dialog);
    await waitFor(() => expect(page.posts()).toHaveLength(2));
    expect(bodyOf(page.posts()[1])).toStrictEqual({
      name: "数据",
      backend: "smb",
      host: "files.intra",
      port: 445,
      remotePath: "/share/dir",
      readOnly: false,
      username: "reader",
      password: "pw-2",
      domain: "CORP",
    });
  });
});

describe("挂载对话框：本地校验", () => {
  it("每条本地校验显示规格文案且零请求；名称 uploads 与 screenshots 各显示 该名称已保留", async () => {
    const page = openPage();
    await ready(page);
    const dialog = await openDialog();
    type(dialog, "主机", "files.intra");
    type(dialog, "目录路径", "/srv/data");
    type(dialog, "用户名", "reader");
    type(dialog, "密码", "pw");

    const cases: [string, string, string][] = [
      ["挂载名称", "", "请填写挂载名称"],
      ["挂载名称", "a.b", "名称只能包含字母、数字、下划线、连字符与汉字"],
      ["挂载名称", "a b", "名称只能包含字母、数字、下划线、连字符与汉字"],
      ["挂载名称", "a".repeat(65), "名称不能超过 64 个字符"],
      ["挂载名称", "数".repeat(65), "名称不能超过 64 个字符"],
      ["挂载名称", "uploads", "该名称已保留"],
      ["挂载名称", "screenshots", "该名称已保留"],
    ];
    for (const [label, value, message] of cases) {
      type(dialog, label, value);
      submit(dialog);
      await waitFor(() => expect(alertText(dialog)).toBe(message));
    }
    type(dialog, "挂载名称", "数".repeat(64));
    type(dialog, "主机", "");
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("请填写主机"));
    type(dialog, "主机", "files.intra");
    type(dialog, "挂载名称", "数据_x-1");
    const remoteCases: [string, string, string][] = [
      ["主机", "", "请填写主机"],
      ["目录路径", "srv/data", "请填写绝对路径，如 /srv/data"],
      ["目录路径", "", "请填写绝对路径，如 /srv/data"],
      ["用户名", "", "请填写用户名"],
      ["密码", "", "请填写密码"],
      ["端口", "0", "端口应为 1 到 65535 的整数"],
      ["端口", "65536", "端口应为 1 到 65535 的整数"],
      ["端口", "22.5", "端口应为 1 到 65535 的整数"],
      ["端口", "abc", "端口应为 1 到 65535 的整数"],
    ];
    const restore: Record<string, string> = {
      主机: "files.intra",
      目录路径: "/srv/data",
      用户名: "reader",
      密码: "pw",
      端口: "",
    };
    for (const [label, value, message] of remoteCases) {
      type(dialog, label, value);
      submit(dialog);
      await waitFor(() => expect(alertText(dialog)).toBe(message));
      type(dialog, label, restore[label] ?? "");
    }
    fireEvent.click(radio(dialog, "私钥"));
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("请填写私钥"));

    await choose(dialog, "协议", "SMB");
    type(dialog, "密码", "pw");
    for (const path of ["/", "//share"]) {
      type(dialog, "目录路径", path);
      submit(dialog);
      await waitFor(() => expect(alertText(dialog)).toBe("请填写共享名与目录，如 /共享名/目录"));
      type(dialog, "目录路径", "/srv/data");
    }
    type(dialog, "目录路径", "srv/data");
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("请填写绝对路径，如 /srv/data"));

    await settle();
    expect(page.posts()).toHaveLength(0);
    expect(page.sourceGets()).toHaveLength(0);
    expect(page.mountsGets()).toHaveLength(1);
  });
});

describe("挂载对话框：服务器目录", () => {
  it("挂载源为空：显示 管理员尚未登记服务器目录，提交禁用；恰一次 GET /api/mount-sources", async () => {
    const page = openPage({ sources: () => jsonResponse({ sources: [] }) });
    await ready(page);
    const dialog = await openDialog();
    type(dialog, "挂载名称", "数据");
    await choose(dialog, "协议", "服务器目录");

    expect(await within(dialog).findByText("管理员尚未登记服务器目录")).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "目录" })).toBeNull();
    expect(submitButton(dialog).hasAttribute("disabled")).toBe(true);
    expect(maybeField(dialog, "主机")).toBeNull();
    expect(page.sourceGets()).toHaveLength(1);
    expect(page.sourceGets()[0]?.[1]?.method).toBe("GET");
  });

  it("只读挂载源（服务端按名字字节序给出，归档 在前）：下拉项带 · 只读、首项预选，只读挂载 即强制打开并禁用（先手动关掉过也一样），body 恰为 {name, backend:local, sourceId, readOnly:true}；换选可写源恢复手动的选择", async () => {
    const page = openPage({
      sources: () =>
        jsonResponse({
          sources: [
            { id: "b".repeat(32), name: "归档", readOnly: true },
            { id: "a".repeat(32), name: "资料库", readOnly: false },
          ],
        }),
      post: () => jsonResponse(HOST_REJECTED, 403),
    });
    await ready(page);
    const dialog = await openDialog();
    type(dialog, "挂载名称", "数据");
    fireEvent.click(readOnlySwitch(dialog));
    expect(readOnlySwitch(dialog).getAttribute("aria-checked")).toBe("false");
    await choose(dialog, "协议", "服务器目录");

    const directory = await within(dialog).findByRole("combobox", { name: "目录" });
    expect(directory.textContent).toBe("归档 · 只读");
    fireEvent.keyDown(directory, { key: "Enter" });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toStrictEqual(["归档 · 只读", "资料库"]);
    fireEvent.keyDown(screen.getByRole("option", { name: "归档 · 只读" }), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());

    const forced = readOnlySwitch(dialog);
    expect(forced.getAttribute("aria-checked")).toBe("true");
    expect(forced.hasAttribute("disabled")).toBe(true);
    submit(dialog);
    await waitFor(() => expect(page.posts()).toHaveLength(1));
    expect(bodyOf(page.posts()[0])).toStrictEqual({
      name: "数据",
      backend: "local",
      sourceId: "b".repeat(32),
      readOnly: true,
    });

    await choose(dialog, "目录", "资料库");
    expect(readOnlySwitch(dialog).getAttribute("aria-checked")).toBe("false");
    expect(readOnlySwitch(dialog).hasAttribute("disabled")).toBe(false);
    expect(page.sourceGets()).toHaveLength(1);
  });

  it("管理员五键视图：下拉照常列出各项，界面不显示 path", async () => {
    const page = openPage({
      sources: () =>
        jsonResponse({
          sources: [
            {
              id: "c".repeat(32),
              name: "共享盘",
              path: "/mnt/secret-share",
              readOnly: false,
              createdAt: 1,
            },
            {
              id: "d".repeat(32),
              name: "NAS",
              path: "/srv/nas-root",
              readOnly: true,
              createdAt: 2,
            },
          ],
        }),
    });
    await ready(page);
    const dialog = await openDialog();
    await choose(dialog, "协议", "服务器目录");

    const directory = await within(dialog).findByRole("combobox", { name: "目录" });
    fireEvent.keyDown(directory, { key: "Enter" });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toStrictEqual(["共享盘", "NAS · 只读"]);
    expect(document.body.textContent).not.toContain("/mnt/secret-share");
    expect(document.body.textContent).not.toContain("/srv/nas-root");
  });

  it("GET /api/mount-sources 失败：框内 role=alert 显示信封文案，提交禁用", async () => {
    const page = openPage({
      sources: () => jsonResponse({ error: { code: "internal", message: "服务器开小差了" } }, 500),
    });
    await ready(page);
    const dialog = await openDialog();
    await choose(dialog, "协议", "服务器目录");

    await waitFor(() => expect(alertText(dialog)).toBe("服务器开小差了"));
    expect(submitButton(dialog).hasAttribute("disabled")).toBe(true);
  });

  it("换协议清掉上一次的本地校验文案：SFTP 下 请填写主机 之后选 服务器目录，读取失败的信封文案照常显示", async () => {
    const page = openPage({
      sources: () => jsonResponse({ error: { code: "internal", message: "服务器开小差了" } }, 500),
    });
    await ready(page);
    const dialog = await openDialog();
    type(dialog, "挂载名称", "数据");
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("请填写主机"));

    await choose(dialog, "协议", "服务器目录");
    await waitFor(() => expect(page.sourceGets()).toHaveLength(1));
    await waitFor(() => expect(alertText(dialog)).toBe("服务器开小差了"));
    expect(submitButton(dialog).hasAttribute("disabled")).toBe(true);
    expect(page.posts()).toHaveLength(0);
  });
});

describe("挂载对话框：请求中与关闭", () => {
  it("请求中提交禁用并显示 正在连接…，再提交不发第二次；取消 中止等待、关闭对话框并恰重取一次 mounts：服务端已建出的 数据 根行出现，不展开、不抢焦点；迟到的 201 不再重取", async () => {
    let release: (response: Response) => void = () => {};
    const page = openPage({
      post: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await ready(page);
    const dialog = await openDialog();
    fillSftpKey(dialog);
    submit(dialog);

    expect(await within(dialog).findByText("正在连接…")).toBeTruthy();
    expect(submitButton(dialog).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(submitButton(dialog).closest("form") as HTMLFormElement);
    await settle();
    expect(page.posts()).toHaveLength(1);
    const signal = page.posts()[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    // 服务端已建出挂载、应答尚未到达时取消。
    page.state.mounts = [created];
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());
    expect(signal?.aborted).toBe(true);

    const mountButton = await findRow("展开 数据");
    expect(page.mountsGets()).toHaveLength(2);
    expect(mountButton.getAttribute("aria-expanded")).toBe("false");
    const newButton = screen.getByRole("button", { name: "新建" });
    await waitFor(() => expect(document.activeElement).toBe(newButton));

    release(jsonResponse(created, 201));
    await settle();
    expect(page.mountsGets()).toHaveLength(2);
    expect(row("展开 数据").getAttribute("aria-expanded")).toBe("false");
    expect(calls(page.fetchMock, treeUrl("数据"))).toHaveLength(0);
    expect(document.activeElement).toBe(newButton);
  });

  it("未发出 POST 就取消（含 Escape）：关闭对话框，不重取 mounts", async () => {
    const page = openPage();
    await ready(page);
    let dialog = await openDialog();
    type(dialog, "挂载名称", "数据");
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("请填写主机"));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());

    dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());
    await settle();
    expect(page.posts()).toHaveLength(0);
    expect(page.mountsGets()).toHaveLength(1);
  });

  it("挂载后的重取失败、之后 刷新 才读到新挂载：根行出现但不展开、不抢焦点", async () => {
    const failure = () =>
      jsonResponse({ error: { code: "internal", message: "服务器开小差了" } }, 500);
    let hold: (response: Response) => void = () => {};
    const answers: (() => Response | Promise<Response>)[] = [
      () => jsonResponse({ enabled: true, mounts: [] }),
      // `刷新` 的 GET：对话框打开之后才失败，挂载根行随之隐去。
      () =>
        new Promise<Response>((resolve) => {
          hold = resolve;
        }),
      failure,
      () => jsonResponse({ enabled: true, mounts: [created] }),
    ];
    const page = openPage({
      list: () => (answers.shift() ?? failure)(),
      post: () => jsonResponse(created, 201),
    });
    await ready(page);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(page.mountsGets()).toHaveLength(2));
    const dialog = await openDialog();
    hold(failure());
    await waitFor(() => expect(screen.getByText("服务器开小差了")).toBeTruthy());

    fillSftpKey(dialog);
    submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());
    await waitFor(() => expect(page.mountsGets()).toHaveLength(3));
    await settle();
    expect(within(tree()).queryByRole("button", { name: /数据/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    const mountButton = await findRow("展开 数据");
    await settle();
    expect(page.mountsGets()).toHaveLength(4);
    expect(mountButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).not.toBe(mountButton);
    expect(calls(page.fetchMock, treeUrl("数据"))).toHaveLength(0);
  });

  it("关闭后凭证清空：失败后取消、Escape 关闭，再打开时 密码 与 私钥 都是空的；地址与 Web Storage 无私钥", async () => {
    const page = openPage({ post: () => jsonResponse(HOST_REJECTED, 403) });
    await ready(page);
    let dialog = await openDialog();
    fillSftpKey(dialog);
    submit(dialog);
    await waitFor(() => expect(alertText(dialog)).toBe("该主机不允许挂载"));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());

    dialog = await openDialog();
    expect(radio(dialog, "密码").getAttribute("aria-checked")).toBe("true");
    expect(field(dialog, "密码").value).toBe("");
    fireEvent.click(radio(dialog, "私钥"));
    expect(field<HTMLTextAreaElement>(dialog, "私钥").value).toBe("");
    expect(alertText(dialog)).toBeNull();

    fireEvent.click(radio(dialog, "密码"));
    type(dialog, "密码", "pw-escape");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "挂载目录" })).toBeNull());
    dialog = await openDialog();
    expect(field(dialog, "密码").value).toBe("");
    expect(document.body.textContent).not.toContain(SENTINEL);
    expect(exposed()).not.toContain(SENTINEL);
    expect(exposed()).not.toContain("pw-escape");
  });
});
