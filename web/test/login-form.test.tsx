import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider } from "../src/features/auth/index.js";
import {
  anonymousGetInit,
  expectFilesShell,
  expectLastLoginRequest,
  expectLogin,
  getLoginForm,
  requestSignal,
  unauthenticatedResponse,
} from "./auth-router-support.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  calls,
  createFetchMock,
  currentLocation,
  type DeferredResponse,
  deferredResponse,
  expectPaths,
  type FetchMock,
  jsonResponse,
  lastCall,
  paths,
  serviceInfo,
  setBrowserPath,
} from "./support.js";
import { readRepoFile, ruleBody, stripComments, yieldMacrotask } from "./ui-support.js";

type LoginRoutes = Parameters<typeof createFetchMock>[0];

let router: ReturnType<typeof mountAuthenticatedApp>["router"] | undefined;

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  setBrowserPath("/");
});

function loginFetchMock(routes: LoginRoutes = {}): FetchMock {
  return createFetchMock({ "/api/auth/me": () => unauthenticatedResponse(), ...routes });
}

/** 经路由挂载的登录页；登录成功后 `/files` 会读取工作空间列表。 */
function routedLoginFetchMock(routes: LoginRoutes): FetchMock {
  return loginFetchMock({ "/api/workspaces": () => jsonResponse({ workspaces: [] }), ...routes });
}

function renderRoutedLogin(path: string, fetchMock: FetchMock) {
  router = mountAuthenticatedApp(path, fetchMock).router;
}

/** 未登录态直接挂 AuthProvider + AuthGuard（登录页唯一消费者），不经路由。 */
async function openLoginPage({ routes = {}, strict = false } = {}) {
  const fetchMock = loginFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  const tree = (
    <AuthProvider>
      <AuthGuard>
        <p>受保护内容</p>
      </AuthGuard>
    </AuthProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  const heading = await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" });
  return { fetchMock, heading, ...loginFields() };
}

function loginFields() {
  return {
    account: screen.getByLabelText("账号") as HTMLInputElement,
    password: screen.getByLabelText("密码") as HTMLInputElement,
    button: screen.getByRole("button", { name: "登录" }) as HTMLButtonElement,
  };
}

function fillAndSubmit(fields: ReturnType<typeof loginFields>) {
  fireEvent.change(fields.account, { target: { value: "zhangsan" } });
  fireEvent.change(fields.password, { target: { value: "demo" } });
  fireEvent.click(fields.button);
}

async function expectAccountFocused() {
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByLabelText("账号"));
  });
}

/** 断言 nodes 在文档中严格按给定顺序出现。 */
function expectDocumentOrder(nodes: Element[]) {
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1] as Element;
    const next = nodes[index] as Element;
    expect(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}

describe("login card structure", () => {
  it("renders brand, title, subtitle, fields and the primary button in demo order", async () => {
    const { fetchMock, heading, account, password, button } = await openLoginPage();

    const subtitle = screen.getByText("内网统一身份 · 本实例不出网");
    expect(subtitle.tagName).toBe("P");
    expect(subtitle.classList.contains("login-sub")).toBe(true);

    const card = document.querySelector(".login-card") as HTMLElement;
    const brand = card.querySelector(".login-brand") as HTMLElement;
    expect(brand).not.toBeNull();
    const mark = brand.querySelector("svg.ui-brand-mark") as SVGElement;
    expect(mark.getAttribute("width")).toBe("26");
    expect(mark.getAttribute("height")).toBe("26");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(within(brand).getByText("WorkBuddy", { exact: true })).toBeTruthy();

    const ordered = [brand, heading, subtitle, account, password, button];
    for (const node of ordered) expect(card.contains(node)).toBe(true);
    expectDocumentOrder(ordered);

    // 默认 helper 不注册 /api/info：请求落为 requestFailed(0)，info 不可用时快捷区不渲染。
    await settleInfoRequest(fetchMock);
    expect(screen.queryByText(/演示账号/)).toBeNull();
    expect(document.querySelector(".login-quick")).toBeNull();
    expect(document.querySelector(".brand-mark")).toBeNull();
  });

  it("focuses the account field on mount", async () => {
    await openLoginPage();
    await expectAccountFocused();
  });

  it("focuses the account field on mount under StrictMode", async () => {
    await openLoginPage({ strict: true });
    await expectAccountFocused();
  });

  it("exposes exact field attributes and label associations", async () => {
    const { account, password } = await openLoginPage();

    expect(account.getAttribute("placeholder")).toBe("域账号，如 zhangsan");
    expect(account.getAttribute("autocomplete")).toBe("username");
    expect(account.getAttribute("name")).toBe("account");
    expect(account.required).toBe(true);

    expect(password.getAttribute("placeholder")).toBe("密码");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("name")).toBe("password");

    for (const [text, input] of [
      ["账号", account],
      ["密码", password],
    ] as const) {
      expect(input.classList.contains("ui-input")).toBe(true);
      expect(input.id).not.toBe("");
      const label = screen.getByText(text, { selector: "label" }) as HTMLLabelElement;
      expect(label.htmlFor).toBe(input.id);
      expect(label.classList.contains("login-label")).toBe(true);
    }
  });
});

describe("login card submission", () => {
  it("shows 正在登录 on the disabled button, then the envelope message above it", async () => {
    const pendingLogin = deferredResponse();
    const fields = await openLoginPage({
      routes: { "/api/auth/login": () => pendingLogin.promise },
    });
    const { password, button } = fields;

    fillAndSubmit(fields);

    await waitFor(() => {
      expect(button.textContent).toBe("正在登录");
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "正在登录" })).toBe(button);
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    expect(screen.getAllByText("正在登录")).toHaveLength(1);

    pendingLogin.resolve(
      jsonResponse(
        { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
        403,
      ),
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(button.textContent).toBe("登录");
    });
    expect(button.disabled).toBe(false);
    expect(alert.textContent).toBe("该账号已停用，请联系管理员");
    expect(alert.classList.contains("login-err")).toBe(true);
    expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expectDocumentOrder([password, alert, button]);
  });

  it("shows the stable fallback on network failure and clears the password", async () => {
    const fields = await openLoginPage({
      routes: { "/api/auth/login": () => new Error("private transport failure") },
    });

    fillAndSubmit(fields);

    expect((await screen.findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    await waitFor(() => {
      expect(fields.button.disabled).toBe(false);
    });
    expect(fields.password.value).toBe("");
  });
});

describe("login card routing and scope", () => {
  it("renders the focused login page at /files without changing the URL", async () => {
    const mounted = mountAuthenticatedApp("/files", loginFetchMock());
    router = mounted.router;

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(currentLocation()).toBe("/files");
    await expectAccountFocused();
  });

  it("issues no request beyond /api/auth/me and the quick-login info read", async () => {
    const { fetchMock } = await openLoginPage();
    await expectAccountFocused();

    const requested = paths(fetchMock);
    expect(requested).toEqual(expect.arrayContaining(["/api/auth/me", "/api/info"]));
    expect(requested).toHaveLength(2);
  });
});

describe("login card static contract", () => {
  const authCssPath = "web/src/features/auth/auth.css";

  it("auth.css carries demo provenance and demo-aligned geometry on semantic tokens", () => {
    const raw = readRepoFile(authCssPath);
    expect(raw).toContain("resource/workbuddy-live-demo.html:637");
    const css = stripComments(raw);

    const card = ruleBody(css, ".login-card");
    expect(card).toContain("width: 360px;");
    expect(card).toContain("border: 1px solid var(--wb-border-card);");
    expect(card).toContain("max-width: calc(100vw - 32px);");
    expect(ruleBody(css, ".login-sub")).toContain("color: var(--wb-text-tertiary);");
    expect(ruleBody(css, ".login-btn")).toContain("height: 36px;");
    expect(ruleBody(css, ".login-err")).toContain("var(--wb-status-error-soft-bg)");
  });

  it("styles.css imports auth.css and drops the migrated login and brand-mark rules", () => {
    const styles = readRepoFile("web/src/styles.css");
    expect(styles).toContain('@import "./features/auth/auth.css";');
    expect(styles).not.toContain(".brand-mark");
    expect(styles).not.toContain(".login-");
    expect(styles).not.toContain(".login-dialog");
  });

  it("login-form.tsx avoids autoFocus, radix and ui-muted and imports primitives via ui/index", () => {
    const source = readRepoFile("web/src/features/auth/login-form.tsx");
    expect(source).not.toContain("autoFocus");
    expect(source).not.toContain("@radix-ui");
    expect(source).not.toContain("ui-muted");
    expect(source).toContain('from "../../ui/index.js"');
  });
});

describe("login form", () => {
  it.each([
    ["the bare files route", "/files"],
    ["a files deep link", "/files?from=deep-link#target"],
  ])(
    "submits once while pending and restores %s after a Principal response",
    async (_label, requestedPath) => {
      const pendingLogin = deferredResponse();
      const fetchMock = routedLoginFetchMock({ "/api/auth/login": pendingLogin.promise });

      renderRoutedLogin(requestedPath, fetchMock);
      await expectLogin();
      const { account, password, submit } = getLoginForm();
      fireEvent.change(account, { target: { value: "  ZhangSan " } });
      fireEvent.change(password, { target: { value: "demo" } });
      fireEvent.submit(submit.closest("form") as HTMLFormElement);
      fireEvent.submit(submit.closest("form") as HTMLFormElement);

      expect(submit.disabled).toBe(true);
      await waitFor(() => expectPaths(fetchMock, ["/api/auth/me", "/api/info", "/api/auth/login"]));
      expectLastLoginRequest(fetchMock, '{"account":"  ZhangSan ","password":"demo"}');

      pendingLogin.resolve(jsonResponse(authenticatedPrincipal));

      await expectFilesShell();
      expect(currentLocation()).toBe(requestedPath);
      expectPaths(fetchMock, ["/api/auth/me", "/api/info", "/api/auth/login", "/api/workspaces"]);
    },
  );

  it("uses the native form submit seam for Enter", async () => {
    const fetchMock = routedLoginFetchMock({
      "/api/auth/login": jsonResponse(authenticatedPrincipal),
    });

    renderRoutedLogin("/files", fetchMock);
    await expectLogin();
    const { account, password } = getLoginForm();
    fireEvent.change(account, { target: { value: "zhangsan" } });
    fireEvent.change(password, { target: { value: "demo" } });
    fireEvent.keyDown(password, { key: "Enter", code: "Enter" });
    fireEvent.submit(password.closest("form") as HTMLFormElement);

    await expectFilesShell();
    expectPaths(fetchMock, ["/api/auth/me", "/api/info", "/api/auth/login", "/api/workspaces"]);
  });

  it.each([
    [
      "the account-disabled message",
      jsonResponse(
        { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
        403,
      ),
      "该账号已停用，请联系管理员",
    ],
    [
      "the invalid-credentials message",
      jsonResponse({ error: { code: "invalid_credentials", message: "账号或密码不正确" } }, 401),
      "账号或密码不正确",
    ],
  ])(
    "shows %s, retains the account, clears the password, and permits retry",
    async (_label, loginResponse, message) => {
      renderRoutedLogin("/files", routedLoginFetchMock({ "/api/auth/login": loginResponse }));
      await expectLogin();
      const { account, password, submit } = getLoginForm();
      fireEvent.change(account, { target: { value: "wangwu" } });
      fireEvent.change(password, { target: { value: "demo" } });
      fireEvent.submit(submit.closest("form") as HTMLFormElement);

      expect((await screen.findByRole("alert")).textContent).toBe(message);
      expect(account.value).toBe("wangwu");
      expect(password.value).toBe("");
      expect(submit.disabled).toBe(false);
      expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
    },
  );

  it("uses browser-filled DOM values and permits a real retry after failure", async () => {
    const fetchMock = routedLoginFetchMock({
      "/api/auth/login": [
        jsonResponse(
          { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
          403,
        ),
        jsonResponse(authenticatedPrincipal),
      ],
    });

    renderRoutedLogin("/files", fetchMock);
    await expectLogin();
    const { account, password, submit } = getLoginForm();
    account.value = "  Filled Account ";
    password.value = "filled-password";
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toBe("该账号已停用，请联系管理员");
    expectLastLoginRequest(
      fetchMock,
      '{"account":"  Filled Account ","password":"filled-password"}',
    );
    expect(account.value).toBe("  Filled Account ");
    expect(password.value).toBe("");
    expect(submit.disabled).toBe(false);

    password.value = "retry-password";
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    await expectFilesShell();
    expectLastLoginRequest(
      fetchMock,
      '{"account":"  Filled Account ","password":"retry-password"}',
    );
    expectPaths(fetchMock, [
      "/api/auth/me",
      "/api/info",
      "/api/auth/login",
      "/api/auth/login",
      "/api/workspaces",
    ]);
  });

  it.each([
    ["a malformed login response", () => jsonResponse({ account: "zhangsan" })],
    ["a network failure", () => new Error("private transport failure")],
  ])("shows the stable fallback for %s", async (_label, loginResult) => {
    renderRoutedLogin("/files", routedLoginFetchMock({ "/api/auth/login": loginResult }));
    await expectLogin();
    const { account, password, submit } = getLoginForm();
    fireEvent.change(account, { target: { value: "zhangsan" } });
    fireEvent.change(password, { target: { value: "demo" } });
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    expect(account.value).toBe("zhangsan");
    expect(password.value).toBe("");
    expect(submit.disabled).toBe(false);
    expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
  });
});

const QUICK_CARD_NAMES = ["zhangsan 成员", "zhaoliu 成员", "lisi 管理员"];

function infoResponse(provider: string) {
  return jsonResponse({ ...serviceInfo, auth: { provider } });
}

const devStubRoutes = { "/api/info": () => jsonResponse(serviceInfo) };

/** 等 LoginForm 的 info 请求发出并落定（再让出一个宏任务）。 */
async function settleInfoRequest(fetchMock: FetchMock) {
  await waitFor(() => {
    expect(calls(fetchMock, "/api/info")).toHaveLength(1);
  });
  await yieldMacrotask();
}

async function findQuickCards() {
  const list = await screen.findByRole("list", { name: "快捷登录" });
  return { list, cards: within(list).getAllByRole("button") as HTMLButtonElement[] };
}

function expectCardsDisabled(disabled: boolean) {
  const list = screen.getByRole("list", { name: "快捷登录" });
  for (const card of within(list).getAllByRole("button")) {
    expect((card as HTMLButtonElement).disabled).toBe(disabled);
  }
}

const failedLoginResponse = () =>
  jsonResponse({ error: { code: "invalid_credentials", message: "账号或密码不正确" } }, 401);

describe("quick login", () => {
  it("renders the demo hint and three seed cards after the form under dev-stub", async () => {
    const { fetchMock } = await openLoginPage({ routes: devStubRoutes });
    const { list, cards } = await findQuickCards();

    expect(lastCall(fetchMock, "/api/info")).toEqual(["/api/info", anonymousGetInit]);
    expect(cards).toHaveLength(QUICK_CARD_NAMES.length);
    QUICK_CARD_NAMES.forEach((name, index) => {
      expect(within(list).getByRole("button", { name })).toBe(cards[index]);
    });
    const hint = document.querySelector(".login-hint") as HTMLElement;
    expect(hint.textContent).toBe("演示账号：zhangsan / zhaoliu / lisi（管理员），密码均为 demo");

    const card = document.querySelector(".login-card") as HTMLElement;
    const form = document.querySelector(".login-form") as HTMLElement;
    for (const node of [hint, list]) expect(card.contains(node)).toBe(true);
    expectDocumentOrder([form, hint, list]);
    expect(card.textContent).not.toMatch(/张三|赵六|李四|部/);
  });

  it.each([
    ["an oidc provider", { "/api/info": () => infoResponse("oidc") }],
    ["an unregistered info path", {}],
    [
      "a 500 envelope",
      {
        "/api/info": () =>
          jsonResponse({ error: { code: "internal_error", message: "服务暂不可用" } }, 500),
      },
    ],
    [
      "a malformed two-key body",
      { "/api/info": () => jsonResponse({ name: serviceInfo.name, version: serviceInfo.version }) },
    ],
    ["an ldap provider", { "/api/info": () => infoResponse("ldap") }],
  ])("renders no quick login and keeps the form usable after %s", async (_label, routes) => {
    const fields = await openLoginPage({
      routes: { ...routes, "/api/auth/login": () => jsonResponse(authenticatedPrincipal) },
    });
    await settleInfoRequest(fields.fetchMock);

    expect(screen.queryByRole("list", { name: "快捷登录" })).toBeNull();
    expect(document.querySelector(".login-hint")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fillAndSubmit(fields);

    expect(await screen.findByText("受保护内容", { exact: true })).toBeTruthy();
    expect(calls(fields.fetchMock, "/api/info")).toHaveLength(1);
  });

  it("shows quick login under dev-stub after the same settle wait", async () => {
    const { fetchMock } = await openLoginPage({ routes: devStubRoutes });
    await settleInfoRequest(fetchMock);

    expect(screen.queryByRole("list", { name: "快捷登录" })).not.toBeNull();
    expect(document.querySelector(".login-hint")).not.toBeNull();
  });

  it("submits the picked account with demo exactly once and locks every card", async () => {
    const pendingLogin = deferredResponse();
    const { fetchMock, account, button } = await openLoginPage({
      routes: { ...devStubRoutes, "/api/auth/login": () => pendingLogin.promise },
    });
    const { list } = await findQuickCards();
    const zhangsan = within(list).getByRole("button", { name: "zhangsan 成员" });

    act(() => {
      zhangsan.click();
      zhangsan.click();
    });
    await yieldMacrotask();

    expectCardsDisabled(true);
    expect(button.textContent).toBe("正在登录");
    expect(button.disabled).toBe(true);
    expect(calls(fetchMock, "/api/auth/login")).toHaveLength(1);
    expect(lastCall(fetchMock, "/api/auth/login")[1]?.body).toBe(
      '{"account":"zhangsan","password":"demo"}',
    );
    expect(account.value).toBe("zhangsan");

    pendingLogin.resolve(jsonResponse(authenticatedPrincipal));

    expect(await screen.findByText("受保护内容", { exact: true })).toBeTruthy();
    expect(calls(fetchMock, "/api/auth/login")).toHaveLength(1);
  });

  it("aborts the info read on unmount", async () => {
    const pendingInfo = deferredResponse();
    const { fetchMock } = await openLoginPage({
      routes: { "/api/info": () => pendingInfo.promise },
    });
    const signal = await requestSignal(fetchMock, "/api/info");
    expect(signal.aborted).toBe(false);

    cleanup();

    expect(signal.aborted).toBe(true);
  });

  it("ignores the late result of the info read aborted by a StrictMode effect rerun", async () => {
    const pendingInfos = [deferredResponse(), deferredResponse()];
    const infoQueue = [...pendingInfos];
    const { fetchMock } = await openLoginPage({
      routes: { "/api/info": () => (infoQueue.shift() as DeferredResponse).promise },
      strict: true,
    });
    await waitFor(() => {
      expect(calls(fetchMock, "/api/info")).toHaveLength(2);
    });
    const [first, second] = pendingInfos as [DeferredResponse, DeferredResponse];
    expect(calls(fetchMock, "/api/info")[0]?.[1]?.signal?.aborted).toBe(true);

    second.resolve(infoResponse("oidc"));
    await yieldMacrotask();
    first.resolve(jsonResponse(serviceInfo));
    await yieldMacrotask();

    expect(screen.queryByRole("list", { name: "快捷登录" })).toBeNull();
    expect(document.querySelector(".login-hint")).toBeNull();
  });

  it("keeps the info read out of the provider operation slot while login is pending", async () => {
    const pendingInfo = deferredResponse();
    const pendingLogin = deferredResponse();
    const fields = await openLoginPage({
      routes: {
        "/api/info": () => pendingInfo.promise,
        "/api/auth/login": () => pendingLogin.promise,
      },
    });
    const infoSignal = await requestSignal(fields.fetchMock, "/api/info");

    fillAndSubmit(fields);
    const loginSignal = await requestSignal(fields.fetchMock, "/api/auth/login");

    expect(infoSignal.aborted).toBe(false);
    expect(loginSignal.aborted).toBe(false);

    pendingLogin.resolve(failedLoginResponse());
    expect((await screen.findByRole("alert")).textContent).toBe("账号或密码不正确");

    pendingInfo.resolve(jsonResponse(serviceInfo));
    const { cards } = await findQuickCards();
    expect(cards).toHaveLength(3);
    expect(infoSignal.aborted).toBe(false);
  });

  it("aborts a still-pending info read when a login succeeds and unmounts the form", async () => {
    const pendingInfo = deferredResponse();
    const fields = await openLoginPage({
      routes: {
        "/api/info": () => pendingInfo.promise,
        "/api/auth/login": () => jsonResponse(authenticatedPrincipal),
      },
    });
    const infoSignal = await requestSignal(fields.fetchMock, "/api/info");

    fillAndSubmit(fields);

    expect(await screen.findByText("受保护内容", { exact: true })).toBeTruthy();
    expect(infoSignal.aborted).toBe(true);
  });

  it("keeps the quick login cards usable after a failed login", async () => {
    const fields = await openLoginPage({
      routes: { ...devStubRoutes, "/api/auth/login": failedLoginResponse },
    });
    await findQuickCards();

    fillAndSubmit(fields);

    expect((await screen.findByRole("alert")).textContent).toBe("账号或密码不正确");
    await waitFor(() => {
      expect(fields.button.disabled).toBe(false);
    });
    const { cards } = await findQuickCards();
    expect(cards).toHaveLength(3);
    expectCardsDisabled(false);
  });

  it("renders the quick login once under StrictMode and aborts the first read", async () => {
    const { fetchMock } = await openLoginPage({ routes: devStubRoutes, strict: true });
    const { cards } = await findQuickCards();

    expect(cards).toHaveLength(3);
    expect(screen.getAllByRole("list", { name: "快捷登录" })).toHaveLength(1);
    expect(document.querySelectorAll(".login-hint")).toHaveLength(1);
    const infoCalls = calls(fetchMock, "/api/info");
    expect(infoCalls).toHaveLength(2);
    expect(infoCalls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps the account label and 登录 button name unique for substring locators", async () => {
    const { button } = await openLoginPage({ routes: devStubRoutes });
    // 以 hint 出现为渲染完成信号，不依赖待测的列表名与卡片名。
    await waitFor(() => {
      expect(document.querySelector(".login-hint")).not.toBeNull();
    });
    const cards = document.querySelectorAll(".login-quick-item");
    expect(cards).toHaveLength(3);

    const accountLabelled = screen.getAllByLabelText(/账号/);
    expect(accountLabelled).toHaveLength(1);
    expect(accountLabelled[0]).toBe(screen.getByLabelText("账号"));
    const loginNamed = screen.getAllByRole("button", { name: /登录/ });
    expect(loginNamed).toHaveLength(1);
    expect(loginNamed[0]).toBe(button);
    for (const card of cards) expect(card.textContent).not.toContain("登录");
  });
});

describe("quick login static contract", () => {
  it("quick-login.tsx reads info through an anonymous client, not the provider", () => {
    const source = readRepoFile("web/src/features/auth/quick-login.tsx");
    for (const forbidden of ["loadServiceInfo", "useAuth", "@radix-ui"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("createApiClient(");
    const ariaLabels = [...source.matchAll(/aria-label="([^"]*)"/g)].map(([, label]) => label);
    expect(ariaLabels.length).toBeGreaterThan(0);
    for (const label of ariaLabels) expect(label).not.toMatch(/账号|密码/);
    expect(readRepoFile("web/src/features/auth/login-form.tsx")).not.toContain("loadServiceInfo");
  });

  it("dev-accounts.ts mirrors only seed account and role", () => {
    const source = readRepoFile("web/src/features/auth/dev-accounts.ts");
    for (const forbidden of ["wangwu", "name:", "dept"]) expect(source).not.toContain(forbidden);
  });

  it("auth.css scrolls the login root and centers the card with auto margins", () => {
    const css = stripComments(readRepoFile("web/src/features/auth/auth.css"));
    const root = ruleBody(css, ".login-root");
    expect(root).toContain("overflow-y: auto;");
    expect(root).toMatch(/(^|[^-])height: 100dvh;/);
    expect(root).not.toContain("align-items: center;");
    expect(ruleBody(css, ".login-card")).toContain("margin: auto;");
    expect(ruleBody(css, ".login-quick-item")).toContain("cursor: pointer;");
  });
});
