// connectors「中心「连接器」tab」（s1d-connectors 任务 6.2）的对话框部分：新增 stdio / http（只发碰过的键）、
// 提交前的客户端校验（名称规则、长度与个数上限、以 `!` 开头、含 `${`，不发请求）、值恰为宿主子进程环境变量名
// 的输入照常提交而服务端 400 的 message 就地显示、编辑时的整体替换 body（与 `启用` 开关同一构造：留空的凭证键为
// `null`、填了新值取新值）、保存后自动探活规则、发布失败、在途与 Escape 回退。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "../src/features/center/connectors/panel.js";
import { type ConnectorListing, type ConnectorView, createApiClient } from "../src/lib/api.js";
import {
  addEntry,
  badRequest,
  callNames,
  chooseType,
  DOCS,
  DOCS_URL,
  deferred,
  enabledSwitch,
  fakeConnectors,
  flush,
  GITLAB,
  GITLAB_COMMAND,
  httpView,
  LINT,
  openForm,
  pageAlerts,
  publishFailed,
  renderPanel,
  rowButton,
  rowOf,
  save,
  settled,
  stdioView,
  TOKEN,
  type,
  WIKI_URL,
} from "./center-connectors-support.js";
import { createFetchMock, jsonResponse } from "./support.js";

const KEEP = "留空保留现有值";
/** omp 的插值起始符；拼出 `${NAME}` 形式的取值（字面写在字符串里会被当成漏写的模板）。 */
const INTERP = "${";
const MOUNT = ["listConnectors", "getConnectorDefaults"];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function input(dialog: HTMLElement, label: string): HTMLInputElement {
  return within(dialog).getByLabelText(label) as HTMLInputElement;
}

describe("新增", () => {
  it("stdio gitlab：名称、命令、参数、一个环境变量 → 恰一次 createConnector，input 只含碰过的键；不探活，随后重取", async () => {
    const fake = fakeConnectors([]);
    await renderPanel(fake);

    const dialog = await openForm();
    expect(within(dialog).getByRole("combobox", { name: "类型" }).textContent).toBe("stdio");
    expect(within(dialog).queryByLabelText("地址")).toBeNull();
    type(dialog, "名称", "gitlab");
    type(dialog, "命令", GITLAB_COMMAND);
    type(dialog, "参数（每行一个）", "--stdio\n--verbose");
    addEntry(dialog, "变量", "TOKEN", TOKEN);
    expect(input(dialog, "变量值 1").type).toBe("password");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createConnector.mock.calls).toEqual([
      [
        {
          name: "gitlab",
          type: "stdio",
          command: GITLAB_COMMAND,
          args: ["--stdio", "--verbose"],
          env: { TOKEN },
        },
      ],
    ]);
    expect(callNames(fake)).toEqual([...MOUNT, "createConnector", "listConnectors"]);
    expect(screen.getByRole("cell", { name: "gitlab" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("没碰过的可选键不发：描述填了又清空、参数为空、没有环境变量 → input 恰为 {name, type, command}", async () => {
    const fake = fakeConnectors([]);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "名称", "lint");
    type(dialog, "描述", "检查");
    type(dialog, "描述", "");
    type(dialog, "命令", "/opt/lint-mcp");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createConnector.mock.calls).toEqual([
      [{ name: "lint", type: "stdio", command: "/opt/lint-mcp" }],
    ]);
  });

  it("规格例子：http wiki（地址与一个请求头）→ 恰一次 createConnector，紧接着恰一次 probeConnector(wiki)，随后重取；stdio 的字段不发", async () => {
    const fake = fakeConnectors([]);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "名称", "wiki");
    type(dialog, "命令", "/opt/left-over");
    await chooseType(dialog, "http");
    expect(within(dialog).queryByLabelText("命令")).toBeNull();
    type(dialog, "描述", "知识库");
    type(dialog, "地址", WIKI_URL);
    addEntry(dialog, "请求头", "authorization", `Bearer ${TOKEN}`);
    save(dialog);

    await settled(fake, 2);
    expect(fake.createConnector.mock.calls).toEqual([
      [
        {
          name: "wiki",
          type: "http",
          description: "知识库",
          url: WIKI_URL,
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      ],
    ]);
    expect(fake.probeConnector.mock.calls).toEqual([["wiki"]]);
    expect(callNames(fake)).toEqual([
      ...MOUNT,
      "createConnector",
      "probeConnector",
      "listConnectors",
    ]);
  });

  it("新增的键值对可移除，移除后不发", async () => {
    const fake = fakeConnectors([]);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "名称", "gitlab");
    type(dialog, "命令", GITLAB_COMMAND);
    addEntry(dialog, "变量", "TOKEN", TOKEN);
    fireEvent.click(within(dialog).getByRole("button", { name: "移除变量 1" }));
    save(dialog);

    await settled(fake, 2);
    expect(fake.createConnector.mock.calls).toEqual([
      [{ name: "gitlab", type: "stdio", command: GITLAB_COMMAND }],
    ]);
  });
});

type Fill = (dialog: HTMLElement) => void | Promise<void>;

const stdio =
  (patch: Partial<Record<"名称" | "描述" | "命令" | "参数（每行一个）", string>>): Fill =>
  (dialog) => {
    const values = { 名称: "gitlab", 命令: GITLAB_COMMAND, ...patch };
    for (const [label, value] of Object.entries(values)) type(dialog, label, value);
  };

const http =
  (url: string, header?: [string, string]): Fill =>
  async (dialog) => {
    type(dialog, "名称", "wiki");
    await chooseType(dialog, "http");
    type(dialog, "地址", url);
    if (header) addEntry(dialog, "请求头", ...header);
  };

describe("客户端校验：有原因就不发请求", () => {
  const NAME = "名称需为 1–32 个小写字母";
  it.each<[string, Fill, string]>([
    ["名称带数字", stdio({ 名称: "git2" }), NAME],
    ["名称带大写", stdio({ 名称: "Git" }), NAME],
    ["名称带下划线", stdio({ 名称: "git_lab" }), NAME],
    ["名称为空", stdio({ 名称: "" }), NAME],
    ["名称 33 个字母", stdio({ 名称: "a".repeat(33) }), NAME],
    ["描述 201 个字符", stdio({ 描述: "字".repeat(201) }), "描述不能超过 200 个字符"],
    ["命令不是绝对路径", stdio({ 命令: "node" }), "命令需为以 / 开头的绝对路径"],
    ["命令超过 1024 字节", stdio({ 命令: `/${"字".repeat(342)}` }), "命令不能超过 1024 字节"],
    ["命令以 ! 开头", stdio({ 命令: "!cat /etc/passwd" }), "命令不能以 ! 开头"],
    ["命令含 ${", stdio({ 命令: `/opt/${INTERP}HOME}/mcp` }), "命令不能含 ${"],
    ["参数含 ${", stdio({ "参数（每行一个）": `--ok\n${INTERP}HOME}` }), "参数不能含 ${"],
    ["参数以 ! 开头", stdio({ "参数（每行一个）": "!id" }), "参数不能以 ! 开头"],
    ["参数 33 项", stdio({ "参数（每行一个）": Array(33).fill("x").join("\n") }), "参数至多 32 项"],
    [
      "参数一项 1025 个字符",
      stdio({ "参数（每行一个）": "y".repeat(1025) }),
      "每项参数不能超过 1024 个字符",
    ],
    [
      "环境变量值以 ! 开头",
      async (dialog) => {
        await stdio({})(dialog);
        addEntry(dialog, "变量", "TOKEN", "!cat /etc/passwd");
      },
      "变量值不能以 ! 开头",
    ],
    [
      "环境变量名小写",
      async (dialog) => {
        await stdio({})(dialog);
        addEntry(dialog, "变量", "token", "x");
      },
      "变量名需为大写字母、数字或下划线（不以数字开头，至多 64 个字符）",
    ],
    [
      "环境变量值为空",
      async (dialog) => {
        await stdio({})(dialog);
        addEntry(dialog, "变量", "TOKEN", "");
      },
      "变量值需为 1–4096 个字符",
    ],
    [
      "地址不是 http(s)",
      http("ftp://wiki.example/mcp"),
      "地址需以 http:// 或 https:// 开头，且不含空白、# 或 @",
    ],
    ["地址含 ${", http(`https://wiki.example/${INTERP}PATH}`), "地址不能含 ${"],
    [
      "请求头值含 ${",
      http(WIKI_URL, ["authorization", `Bearer ${INTERP}WORKBUDDY_MODEL_TOKEN}`]),
      "请求头值不能含 ${",
    ],
    ["请求头值以 ! 开头", http(WIKI_URL, ["x-token", "!whoami"]), "请求头值不能以 ! 开头"],
  ])("%s：字段旁显示原因，对话框不关，不发请求", async (_label, fill, reason) => {
    const fake = fakeConnectors([]);
    await renderPanel(fake);

    const dialog = await openForm();
    await fill(dialog);
    save(dialog);

    expect(await within(dialog).findByText(reason, { exact: true })).toBeTruthy();
    await flush();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(callNames(fake)).toEqual(MOUNT);
  });

  it("值恰为宿主子进程环境变量名（PATH）只由服务端判定：照常提交，400 的 message 在对话框内就地显示，对话框不关、不探活、不重取", async () => {
    const fake = fakeConnectors([]);
    fake.createConnector.mockRejectedValueOnce(badRequest());
    await renderPanel(fake);

    const dialog = await openForm();
    await stdio({})(dialog);
    addEntry(dialog, "变量", "X", "PATH");
    save(dialog);

    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("请求格式不正确"),
    );
    expect(fake.createConnector.mock.calls).toEqual([
      [{ name: "gitlab", type: "stdio", command: GITLAB_COMMAND, env: { X: "PATH" } }],
    ]);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(pageAlerts()).toEqual([]);
    expect(fake.probeConnector).not.toHaveBeenCalled();
    expect(fake.listConnectors).toHaveBeenCalledTimes(1);
  });
});

describe("编辑：与「启用」开关同一构造的整体替换 body", () => {
  it("名称只读、类型不可改；已有键名只读、值框为空且 placeholder「留空保留现有值」；只改描述 → env 每个已有键为 null、enabled 取视图；stdio 不探活", async () => {
    const fake = fakeConnectors([GITLAB]);
    await renderPanel(fake);

    const dialog = await openForm("gitlab");
    expect(input(dialog, "名称").readOnly).toBe(true);
    expect(input(dialog, "名称").value).toBe("gitlab");
    const kind = within(dialog).getByRole("combobox", { name: "类型" });
    expect(kind.textContent).toBe("stdio");
    expect((kind as HTMLButtonElement).disabled).toBe(true);
    expect(input(dialog, "命令").value).toBe(GITLAB_COMMAND);
    expect(input(dialog, "参数（每行一个）").value).toBe("--stdio");
    expect(input(dialog, "变量名 1").value).toBe("TOKEN");
    expect(input(dialog, "变量名 1").readOnly).toBe(true);
    expect(input(dialog, "变量值 1").value).toBe("");
    expect(input(dialog, "变量值 1").placeholder).toBe(KEEP);
    expect(within(dialog).queryByRole("button", { name: "移除变量 1" })).toBeNull();

    type(dialog, "描述", "代码库 v2");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateConnector.mock.calls).toEqual([
      [
        "gitlab",
        {
          description: "代码库 v2",
          command: GITLAB_COMMAND,
          args: ["--stdio"],
          env: { TOKEN: null },
          enabled: true,
        },
      ],
    ]);
    expect(callNames(fake)).toEqual([...MOUNT, "updateConnector", "listConnectors"]);
  });

  it("填了已有键的新值取新值、新增的键带值、没填的已有键仍为 null；停用的视图 enabled 仍为 false", async () => {
    const view = stdioView("gitlab", {
      command: GITLAB_COMMAND,
      envKeys: ["HOST", "TOKEN"],
      enabled: false,
    });
    const fake = fakeConnectors([view]);
    await renderPanel(fake);

    const dialog = await openForm("gitlab");
    expect(input(dialog, "参数（每行一个）").value).toBe("");
    type(dialog, "变量值 2", TOKEN);
    addEntry(dialog, "变量", "EXTRA", "1");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateConnector.mock.calls).toEqual([
      [
        "gitlab",
        {
          description: "",
          command: GITLAB_COMMAND,
          args: [],
          env: { HOST: null, TOKEN, EXTRA: "1" },
          enabled: false,
        },
      ],
    ]);
    expect(fake.probeConnector).not.toHaveBeenCalled();
  });

  it('参数按换行精确拆合：视图 [--a, "", --b] 原样回到 body', async () => {
    const fake = fakeConnectors([stdioView("lint", { args: ["--a", "", "--b"] })]);
    await renderPanel(fake);

    const dialog = await openForm("lint");
    expect(input(dialog, "参数（每行一个）").value).toBe("--a\n\n--b");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateConnector.mock.calls[0]?.[1]).toMatchObject({ args: ["--a", "", "--b"] });
  });

  it.each<[string, Fill, Record<string, unknown>, boolean]>([
    ["只改描述", (d) => type(d, "描述", "文档 v2"), { description: "文档 v2" }, false],
    ["改地址", (d) => type(d, "地址", WIKI_URL), { url: WIKI_URL }, true],
    [
      "填已有请求头的新值",
      (d) => type(d, "请求头值 1", `Bearer ${TOKEN}`),
      { headers: { authorization: `Bearer ${TOKEN}` } },
      true,
    ],
    [
      "新增一个请求头",
      (d) => addEntry(d, "请求头", "x-team", "core"),
      { headers: { authorization: null, "x-team": "core" } },
      true,
    ],
  ])(
    "http docs %s：body 按视图构造；地址或请求头有改动才紧接着恰一次探活",
    async (_label, fill, patch, probes) => {
      const fake = fakeConnectors([DOCS]);
      await renderPanel(fake);

      const dialog = await openForm("docs");
      expect(input(dialog, "地址").value).toBe(DOCS_URL);
      expect(input(dialog, "请求头名 1").value).toBe("authorization");
      expect(input(dialog, "请求头值 1").placeholder).toBe(KEEP);
      await fill(dialog);
      save(dialog);

      await settled(fake, 2);
      expect(fake.updateConnector.mock.calls).toEqual([
        [
          "docs",
          {
            description: "文档",
            url: DOCS_URL,
            headers: { authorization: null },
            enabled: false,
            ...patch,
          },
        ],
      ]);
      expect(callNames(fake)).toEqual([
        ...MOUNT,
        "updateConnector",
        ...(probes ? ["probeConnector"] : []),
        "listConnectors",
      ]);
    },
  );
});

describe("保存成功后先以应答替换该行，再自动探活", () => {
  it("编辑 http wiki（新地址 + 新请求头）后探活挂起，期间切换「启用」：body 取保存后的视图——新地址、新键为 null（已是既有键）、enabled 取反", async () => {
    const NEW_URL = "https://wiki2.example/mcp";
    const fake = fakeConnectors([httpView("wiki", { headerKeys: ["authorization"] })]);
    const gate = deferred<void>();
    const original = fake.probeConnector.getMockImplementation() as (
      name: string,
    ) => Promise<ConnectorView>;
    fake.probeConnector.mockImplementationOnce(async (name: string) => {
      await gate.promise;
      return original(name);
    });
    await renderPanel(fake);

    const dialog = await openForm("wiki");
    type(dialog, "地址", NEW_URL);
    addEntry(dialog, "请求头", "x-team", "core");
    save(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fake.probeConnector).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(enabledSwitch("wiki"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    expect(fake.updateConnector.mock.calls).toEqual([
      [
        "wiki",
        {
          description: "",
          url: NEW_URL,
          headers: { authorization: null, "x-team": "core" },
          enabled: true,
        },
      ],
      [
        "wiki",
        {
          description: "",
          url: NEW_URL,
          headers: { authorization: null, "x-team": null },
          enabled: false,
        },
      ],
    ]);

    await act(async () => gate.resolve());
    await settled(fake, 3);
    expect(callNames(fake)).toEqual([
      ...MOUNT,
      "updateConnector",
      "updateConnector",
      "listConnectors",
      "probeConnector",
      "listConnectors",
    ]);
    expect(enabledSwitch("wiki").getAttribute("aria-checked")).toBe("false");
  });

  it("保存前已在途的重取（带旧 wiki 视图）在自动探活期间才返回：被丢弃，行仍显示保存后的地址；随后「启用」的 body 取保存后的视图", async () => {
    const NEW_URL = "https://wiki2.example/mcp";
    const fake = fakeConnectors([LINT, httpView("wiki", { headerKeys: ["authorization"] })]);
    await renderPanel(fake);
    // 切换 lint 的「启用」触发的那次重取：发出时即取下当时（保存前）的表，挂起到 `stale` 放行。
    const stale = deferred<void>();
    const list = fake.listConnectors.getMockImplementation() as () => Promise<ConnectorListing>;
    fake.listConnectors.mockImplementationOnce(async () => {
      const old = await list();
      await stale.promise;
      return old;
    });
    const probe = deferred<void>();
    const probeImpl = fake.probeConnector.getMockImplementation() as (
      name: string,
    ) => Promise<ConnectorView>;
    fake.probeConnector.mockImplementationOnce(async (name: string) => {
      await probe.promise;
      return probeImpl(name);
    });

    fireEvent.click(enabledSwitch("lint"));
    await waitFor(() => expect(fake.listConnectors).toHaveBeenCalledTimes(2));
    const dialog = await openForm("wiki");
    type(dialog, "地址", NEW_URL);
    addEntry(dialog, "请求头", "x-team", "core");
    save(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fake.probeConnector).toHaveBeenCalledTimes(1);
    });
    const urlCell = () => within(rowOf("wiki")).getAllByRole("cell")[3]?.textContent;
    expect(urlCell()).toBe(NEW_URL);

    await act(async () => stale.resolve());
    await flush();
    expect(urlCell()).toBe(NEW_URL);

    fireEvent.click(enabledSwitch("wiki"));
    await waitFor(() => expect(fake.updateConnector).toHaveBeenCalledTimes(3));
    expect(fake.updateConnector.mock.calls[2]).toEqual([
      "wiki",
      {
        description: "",
        url: NEW_URL,
        headers: { authorization: null, "x-team": null },
        enabled: false,
      },
    ]);

    await act(async () => probe.resolve());
    await settled(fake, 4);
    expect(urlCell()).toBe(NEW_URL);
  });
});

describe("真实传输层（createApiClient + 替身 fetch，不经假 ApiClient）", () => {
  it('新增 stdio：参数 textarea 以换行结尾 → args 末项为 ""；201 应答照常解析——对话框关闭、列表出现该行、页顶无提示', async () => {
    const view = stdioView("gitlab", { command: GITLAB_COMMAND, args: ["--stdio", ""] });
    const lists = [{ connectors: [] }, { connectors: [view] }];
    const fetchMock = createFetchMock({
      "/api/connectors/defaults": () => jsonResponse({ disabledConnectors: [] }),
      "/api/connectors": (_path, options) =>
        options?.method === "POST" ? jsonResponse(view, 201) : jsonResponse(lists.shift()),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectorsPanel admin client={createApiClient()} />);
    await waitFor(() => expect(screen.queryByText("正在读取连接器")).toBeNull());

    const dialog = await openForm();
    type(dialog, "名称", "gitlab");
    type(dialog, "命令", GITLAB_COMMAND);
    type(dialog, "参数（每行一个）", "--stdio\n");
    save(dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("cell", { name: "gitlab" })).toBeTruthy());
    expect(pageAlerts()).toEqual([]);
    const requests = fetchMock.mock.calls.map(([path, init]) => [init?.method, path, init?.body]);
    expect(requests).toEqual([
      ["GET", "/api/connectors", undefined],
      ["GET", "/api/connectors/defaults", undefined],
      [
        "POST",
        "/api/connectors",
        JSON.stringify({
          name: "gitlab",
          type: "stdio",
          command: GITLAB_COMMAND,
          args: ["--stdio", ""],
        }),
      ],
      ["GET", "/api/connectors", undefined],
    ]);
  });
});

describe("发布失败与自动探活失败", () => {
  it("新增 http 收到非信封 500：关对话框、不自动探活、重取列表，页顶显示 REQUEST_FAILED_MESSAGE", async () => {
    const fake = fakeConnectors([]);
    fake.createConnector.mockRejectedValueOnce(publishFailed());
    await renderPanel(fake);

    const dialog = await openForm();
    await http(WIKI_URL)(dialog);
    save(dialog);

    await settled(fake, 2);
    expect(fake.probeConnector).not.toHaveBeenCalled();
    expect(pageAlerts()).toEqual(["请求失败，请稍后重试"]);
  });

  it("保存后的自动探活抛 ApiError：页顶显示其 message，照样重取", async () => {
    const fake = fakeConnectors([]);
    fake.probeConnector.mockRejectedValueOnce(badRequest());
    await renderPanel(fake);

    const dialog = await openForm();
    await http(WIKI_URL)(dialog);
    save(dialog);

    await settled(fake, 2);
    // `mockRejectedValueOnce` 换掉了这一次的实现（不记进 `calls`），次序看 spy 的调用序号。
    expect(fake.probeConnector.mock.calls).toEqual([["wiki"]]);
    const [probed] = fake.probeConnector.mock.invocationCallOrder;
    expect(fake.createConnector.mock.invocationCallOrder[0]).toBeLessThan(probed ?? 0);
    expect(fake.listConnectors.mock.invocationCallOrder[1]).toBeGreaterThan(probed ?? 0);
    expect(pageAlerts()).toEqual(["请求格式不正确"]);
  });
});

describe("在途与 Escape", () => {
  it("提交在途：保存与取消禁用，Escape 关不掉；结算后关闭", async () => {
    const fake = fakeConnectors([]);
    const gate = deferred<ConnectorView>();
    fake.createConnector.mockReturnValueOnce(gate.promise);
    await renderPanel(fake);

    const dialog = await openForm();
    await stdio({})(dialog);
    save(dialog);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(within(dialog).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(input(dialog, "命令"), { key: "Escape" });
    save(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(fake.createConnector).toHaveBeenCalledTimes(1);

    gate.resolve(GITLAB);
    await settled(fake, 2);
  });

  it.each([
    ["新增", undefined],
    ["编辑", "gitlab"],
  ])("%s对话框按一次 Escape：关闭、不发请求、焦点回到打开它的按钮", async (_label, name) => {
    const fake = fakeConnectors([GITLAB]);
    await renderPanel(fake);

    const dialog = await openForm(name);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(callNames(fake)).toEqual(MOUNT);
    expect(document.activeElement).toBe(
      name === undefined
        ? screen.getByRole("button", { name: "新增连接器" })
        : rowButton(name, "编辑"),
    );
  });
});
