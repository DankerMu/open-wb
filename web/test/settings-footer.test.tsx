import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { createAppRouter } from "../src/routes/index.js";
import {
  createFetchMock,
  currentLocation,
  deferredResponse,
  jsonResponse,
  authenticatedPrincipal as principal,
  replaceFetchRoutes,
  requestOptionsAt,
  serviceInfo,
  setBrowserPath,
  unauthorizedResponseCases,
} from "./support.js";

function createAuthenticatedFetch(
  infoResponse: Error | Response | Promise<Response> = jsonResponse(serviceInfo),
) {
  return createFetchMock({
    "/api/auth/me": jsonResponse(principal),
    "/api/info": infoResponse,
  });
}

function authenticatedRoutes(routes: Record<string, Error | Promise<Response> | Response>) {
  return { "/api/auth/me": jsonResponse(principal), ...routes };
}

let router: ReturnType<typeof createAppRouter> | undefined;

function renderApp(path: string) {
  setBrowserPath(path);
  router = createAppRouter();
  return render(<RouterProvider router={router} />);
}

async function expectAuthenticatedShell(path: string) {
  const title =
    path === "/" ? "会话" : path === "/files" ? "工作空间" : path === "/center" ? "中心" : "设置";
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  const sidebar = screen.getByRole("complementary", { name: "侧栏" });
  expect(within(sidebar).getByText(principal.account, { exact: true })).toBeTruthy();
  expect(within(sidebar).getByText(principal.role, { exact: true })).toBeTruthy();
  expect(within(sidebar).getByRole("button", { name: "退出登录" })).toBeTruthy();
}

async function expectLoginAt(path: string) {
  expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
  expect(currentLocation()).toBe(path);
}

function getFooter() {
  return screen.getByRole("complementary", { name: "侧栏" });
}

function openLogoutDialog() {
  fireEvent.click(within(getFooter()).getByRole("button", { name: "退出登录" }));
  return screen.getByRole("alertdialog");
}

type AuthProbe = {
  loadServiceInfo: ReturnType<typeof useAuth>["loadServiceInfo"];
  login: ReturnType<typeof useAuth>["login"];
  logout: ReturnType<typeof useAuth>["logout"];
  principal: ReturnType<typeof useAuth>["principal"];
  status: ReturnType<typeof useAuth>["status"];
  error: ReturnType<typeof useAuth>["error"];
  logoutError: ReturnType<typeof useAuth>["logoutError"];
};

function AuthOperationProbe({ onState }: { onState(probe: AuthProbe): void }) {
  const auth = useAuth();
  onState({
    loadServiceInfo: auth.loadServiceInfo,
    login: auth.login,
    logout: auth.logout,
    principal: auth.principal,
    status: auth.status,
    error: auth.error,
    logoutError: auth.logoutError,
  });
  return null;
}

async function renderAuthenticatedProvider() {
  const fetchMock = createFetchMock(authenticatedRoutes({}));
  vi.stubGlobal("fetch", fetchMock);
  let probe: AuthProbe | undefined;
  const view = render(
    <AuthProvider>
      <AuthOperationProbe onState={(state) => (probe = state)} />
      <AuthGuard>
        <p>受保护内容</p>
      </AuthGuard>
    </AuthProvider>,
  );

  await waitFor(() => {
    expect(probe?.principal).toEqual(principal);
  });
  if (!probe) {
    throw new Error("expected AuthProvider probe");
  }

  return { fetchMock, getProbe: () => probe, view };
}

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  setBrowserPath("/");
});

describe("settings route", () => {
  it("mounts the theme owner before canonical navigation starts authentication", async () => {
    window.localStorage.setItem("workbuddy-theme", "dark");
    const pendingMe = deferredResponse();
    const fetchMock = createFetchMock({ "/api/auth/me": pendingMe.promise });
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/SeTTings///?from=canonical#target");

    await waitFor(() => {
      expect(currentLocation()).toBe("/settings?from=canonical#target");
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders only the appearance and about cards with the returned service identity", async () => {
    const fetchMock = createAuthenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/settings?from=deep-link#target");

    await expectAuthenticatedShell("/settings");
    expect(currentLocation()).toBe("/settings?from=deep-link#target");
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["外观", "关于"]);
    expect(screen.queryByRole("heading", { level: 2, name: "通用" })).toBeNull();
    const group = screen.getByRole("radiogroup", { name: "主题" });
    expect(within(group).getByRole("radio", { name: "浅色" })).toBeTruthy();
    expect(within(group).getByRole("radio", { name: "深色" })).toBeTruthy();
    expect(
      (within(group).getByRole("radio", { name: "跟随系统" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText("当前生效：浅色", { exact: true })).toBeTruthy();
    expect(await screen.findByText(serviceInfo.name, { exact: true })).toBeTruthy();
    expect(screen.getByText(`版本 ${serviceInfo.version}`, { exact: true })).toBeTruthy();
    expect(screen.queryByText("WorkBuddy", { exact: true })).toBeNull();
    expect(screen.queryByText("5.3.11", { exact: true })).toBeNull();
  });

  it("uses the single theme context to update appearance controls and the root immediately", async () => {
    const fetchMock = createAuthenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/settings");
    const group = await screen.findByRole("radiogroup", { name: "主题" });
    fireEvent.click(within(group).getByRole("radio", { name: "深色" }));

    expect((within(group).getByRole("radio", { name: "深色" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByText("当前生效：深色", { exact: true })).toBeTruthy();
    expect(window.localStorage.getItem("workbuddy-theme")).toBe("dark");
  });

  it("shows loading until the Provider-owned info operation returns", async () => {
    const pendingInfo = deferredResponse();
    const fetchMock = createAuthenticatedFetch(pendingInfo.promise);
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/settings");

    expect(await screen.findByText("正在读取服务信息", { exact: true })).toBeTruthy();
    pendingInfo.resolve(jsonResponse(serviceInfo));
    expect(await screen.findByText(serviceInfo.name, { exact: true })).toBeTruthy();
  });

  it.each([
    [
      "a legal non-401 envelope",
      jsonResponse({ error: { code: "maintenance", message: "服务信息暂不可用" } }, 503),
      "服务信息暂不可用",
    ],
    ["a malformed success", jsonResponse({ name: "private" }), "请求失败，请稍后重试"],
    ["a network failure", new Error("private transport detail"), "请求失败，请稍后重试"],
  ])("keeps the Principal and shell for %s", async (_label, infoResult, message) => {
    const fetchMock = createAuthenticatedFetch(infoResult);
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/settings?from=info-failure#target";

    renderApp(requestedPath);

    await expectAuthenticatedShell("/settings");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(currentLocation()).toBe(requestedPath);
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
  });

  it.each(unauthorizedResponseCases())(
    "transitions to login at the same URL for %s info 401",
    async (_label, infoResponse) => {
      const fetchMock = createAuthenticatedFetch(infoResponse);
      vi.stubGlobal("fetch", fetchMock);
      const requestedPath = "/settings?from=info-401#target";

      renderApp(requestedPath);

      await expectLoginAt(requestedPath);
      expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
    },
  );

  it("aborts the exact info request on settings cleanup and suppresses its late response", async () => {
    const pendingInfo = deferredResponse();
    const fetchMock = createAuthenticatedFetch(pendingInfo.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/settings");
    await screen.findByText("正在读取服务信息", { exact: true });
    const requestOptions = await requestOptionsAt(fetchMock, 1);
    const signal = requestOptions?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      await router?.navigate("/files");
    });
    expect(signal?.aborted).toBe(true);
    pendingInfo.resolve(jsonResponse(serviceInfo));

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  it("settles About after failed logout supersedes pending service information", async () => {
    const pendingInfo = deferredResponse();
    const pendingLogout = deferredResponse();
    const logoutError = "无法退出当前会话";
    const fetchMock = vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(
      (path, options) => {
        if (path === "/api/auth/me") {
          return Promise.resolve(jsonResponse(principal));
        }

        if (path === "/api/info") {
          return new Promise<Response>((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
            void pendingInfo.promise.then(resolve);
          });
        }

        if (path === "/api/auth/logout") {
          return pendingLogout.promise;
        }

        throw new Error(`unexpected request ${path}`);
      },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/settings?from=logout-supersedes-info#target";

    renderApp(requestedPath);
    await expectAuthenticatedShell("/settings");
    expect(await screen.findByText("正在读取服务信息", { exact: true })).toBeTruthy();
    const infoOptions = await requestOptionsAt(fetchMock, 1);

    fireEvent.click(within(openLogoutDialog()).getByRole("button", { name: "退出" }));
    await requestOptionsAt(fetchMock, 2);
    expect(infoOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(infoOptions?.signal?.aborted).toBe(true);

    const footer = getFooter();
    pendingLogout.resolve(
      jsonResponse({ error: { code: "forbidden", message: logoutError } }, 403),
    );
    await waitFor(() => {
      expect(within(footer).getByRole("alert").textContent).toBe(logoutError);
    });
    pendingInfo.resolve(jsonResponse(serviceInfo));
    await expectAuthenticatedShell("/settings");
    expect(currentLocation()).toBe(requestedPath);
    expect(within(footer).getByText(principal.account, { exact: true })).toBeTruthy();
    expect(within(footer).getByText(principal.role, { exact: true })).toBeTruthy();

    await waitFor(() => {
      const about = screen.getByRole("heading", { level: 2, name: "关于" }).closest("section");
      expect(about).toBeTruthy();
      expect(
        within(about as HTMLElement).queryByText("正在读取服务信息", { exact: true }),
      ).toBeNull();
      expect(within(about as HTMLElement).getByRole("alert").textContent).toBe(
        "请求失败，请稍后重试",
      );
    });

    await waitFor(() => {
      const about = screen.getByRole("heading", { level: 2, name: "关于" }).closest("section");
      expect(within(footer).getByRole("alert").textContent).toBe(logoutError);
      expect(within(about as HTMLElement).getByRole("alert").textContent).toBe(
        "请求失败，请稍后重试",
      );
      expect(
        within(about as HTMLElement).queryByText(serviceInfo.name, { exact: true }),
      ).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});

describe("AuthProvider info and logout coordination", () => {
  it("returns null without fetching when its caller has already aborted", async () => {
    const fixture = await renderAuthenticatedProvider();
    const caller = new AbortController();
    caller.abort();

    await expect(fixture.getProbe()?.loadServiceInfo(caller.signal)).resolves.toBeNull();

    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.getProbe()?.principal).toEqual(principal);
  });

  it("links caller abort to the provider operation signal and suppresses the late info completion", async () => {
    const pendingInfo = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({ "/api/info": pendingInfo.promise }),
    );
    const caller = new AbortController();
    const removeCallerAbortListener = vi.spyOn(caller.signal, "removeEventListener");
    const operation = fixture.getProbe()?.loadServiceInfo(caller.signal);

    const infoOptions = await requestOptionsAt(fixture.fetchMock, 1);
    expect(infoOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(infoOptions?.signal).not.toBe(caller.signal);
    caller.abort();
    expect(infoOptions?.signal?.aborted).toBe(true);
    pendingInfo.resolve(jsonResponse(serviceInfo));

    await expect(operation).resolves.toBeNull();
    expect(removeCallerAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(fixture.getProbe()?.principal).toEqual(principal);
  });

  it("lets a newer login supersede pending info without changing the authenticated Principal", async () => {
    const pendingInfo = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({
        "/api/info": pendingInfo.promise,
        "/api/auth/login": jsonResponse({ id: "user-2", account: "lisi", role: "admin" }),
      }),
    );
    const caller = new AbortController();
    const info = fixture.getProbe()?.loadServiceInfo(caller.signal);
    const infoOptions = await requestOptionsAt(fixture.fetchMock, 1);

    await expect(fixture.getProbe()?.login({ account: "lisi", password: "demo" })).resolves.toBe(
      true,
    );

    expect(infoOptions?.signal?.aborted).toBe(true);
    pendingInfo.resolve(jsonResponse(serviceInfo));
    await expect(info).resolves.toBeNull();
    await waitFor(() => {
      expect(fixture.getProbe()?.principal).toEqual({
        id: "user-2",
        account: "lisi",
        role: "admin",
      });
    });
  });

  it("lets logout supersede a pending login operation", async () => {
    const pendingLogin = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({
        "/api/auth/login": pendingLogin.promise,
        "/api/auth/logout": new Response(null, { status: 204 }),
      }),
    );
    const login = fixture.getProbe()?.login({ account: "lisi", password: "demo" });
    const loginOptions = await requestOptionsAt(fixture.fetchMock, 1);

    await expect(fixture.getProbe()?.logout()).resolves.toBe(true);

    expect(loginOptions?.signal?.aborted).toBe(true);
    pendingLogin.resolve(jsonResponse({ id: "user-2", account: "lisi", role: "admin" }));
    await expect(login).resolves.toBe(false);
    await waitFor(() => {
      expect(fixture.getProbe()).toMatchObject({ principal: null, status: "unauthenticated" });
    });
  });

  it("lets logout supersede a pending initial session operation", async () => {
    const pendingSession = deferredResponse();
    const fetchMock = createFetchMock({
      "/api/auth/me": pendingSession.promise,
      "/api/auth/logout": new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let probe: AuthProbe | undefined;
    render(
      <AuthProvider>
        <AuthOperationProbe onState={(state) => (probe = state)} />
      </AuthProvider>,
    );
    const sessionOptions = await requestOptionsAt(fetchMock, 0);

    await expect(probe?.logout()).resolves.toBe(true);

    expect(sessionOptions?.signal?.aborted).toBe(true);
    pendingSession.resolve(jsonResponse(principal));
    await waitFor(() => {
      expect(probe).toMatchObject({ principal: null, status: "unauthenticated" });
    });
  });

  it("lets logout supersede pending info and preserves the exact Principal on its non-401 failure", async () => {
    const pendingInfo = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({
        "/api/info": pendingInfo.promise,
        "/api/auth/logout": jsonResponse(
          { error: { code: "forbidden", message: "无法退出当前会话" } },
          403,
        ),
      }),
    );
    const infoController = new AbortController();
    const info = fixture.getProbe()?.loadServiceInfo(infoController.signal);
    const infoOptions = await requestOptionsAt(fixture.fetchMock, 1);
    const originalPrincipal = fixture.getProbe()?.principal;

    await expect(fixture.getProbe()?.logout()).resolves.toBe(false);

    expect(infoOptions?.signal?.aborted).toBe(true);
    await waitFor(() => {
      expect(fixture.getProbe()?.principal).toBe(originalPrincipal);
      expect(fixture.getProbe()?.error).toBeNull();
      expect(fixture.getProbe()?.logoutError).toBe("无法退出当前会话");
    });
    pendingInfo.resolve(jsonResponse(serviceInfo));
    await expect(info).resolves.toBeNull();
  });

  it.each(unauthorizedResponseCases())(
    "ends cleanly unauthenticated for %s current logout 401",
    async (_label, logoutResponse) => {
      const fixture = await renderAuthenticatedProvider();
      replaceFetchRoutes(
        fixture.fetchMock,
        authenticatedRoutes({ "/api/auth/logout": logoutResponse }),
      );

      await expect(fixture.getProbe()?.logout()).resolves.toBe(true);

      await waitFor(() => {
        expect(fixture.getProbe()).toMatchObject({
          error: null,
          logoutError: null,
          principal: null,
          status: "unauthenticated",
        });
      });
    },
  );

  it("lets a new info operation supersede pending logout without a late state write", async () => {
    const pendingLogout = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({
        "/api/auth/logout": pendingLogout.promise,
        "/api/info": jsonResponse(serviceInfo),
      }),
    );
    const logout = fixture.getProbe()?.logout();
    const logoutOptions = await requestOptionsAt(fixture.fetchMock, 1);

    await expect(
      fixture.getProbe()?.loadServiceInfo(new AbortController().signal),
    ).resolves.toEqual(serviceInfo);

    expect(logoutOptions?.signal?.aborted).toBe(true);
    pendingLogout.resolve(new Response(null, { status: 204 }));
    await expect(logout).resolves.toBe(false);
    expect(fixture.getProbe()?.principal).toEqual(principal);
  });

  it("aborts a pending logout on unmount and leaves a fresh mount clean", async () => {
    const pendingLogout = deferredResponse();
    const fixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      fixture.fetchMock,
      authenticatedRoutes({ "/api/auth/logout": pendingLogout.promise }),
    );
    const logout = fixture.getProbe()?.logout();
    const logoutOptions = await requestOptionsAt(fixture.fetchMock, 1);
    fixture.view.unmount();
    expect(logoutOptions?.signal?.aborted).toBe(true);
    pendingLogout.resolve(new Response(null, { status: 204 }));

    await expect(logout).resolves.toBe(false);
  });

  it("starts a fresh Provider without an aborted logout error", async () => {
    const firstPendingLogout = deferredResponse();
    const firstFixture = await renderAuthenticatedProvider();
    replaceFetchRoutes(
      firstFixture.fetchMock,
      authenticatedRoutes({ "/api/auth/logout": firstPendingLogout.promise }),
    );
    const firstLogout = firstFixture.getProbe()?.logout();
    await waitFor(() => {
      expect(firstFixture.fetchMock).toHaveBeenCalledTimes(2);
    });
    firstFixture.view.unmount();
    firstPendingLogout.resolve(
      jsonResponse({ error: { code: "forbidden", message: "stale logout failure" } }, 403),
    );
    await expect(firstLogout).resolves.toBe(false);

    const secondFixture = await renderAuthenticatedProvider();
    expect(secondFixture.getProbe()).toMatchObject({
      error: null,
      logoutError: null,
      principal,
      status: "authenticated",
    });
  });
});

describe("authenticated sidebar footer", () => {
  it.each(["/", "/files", "/center", "/settings"])(
    "shows exact Principal account and role on %s",
    async (path) => {
      const fetchMock = createAuthenticatedFetch();
      vi.stubGlobal("fetch", fetchMock);

      renderApp(path);

      await expectAuthenticatedShell(path);
    },
  );

  it("opens the exact inline confirmation and cancel makes no request or state change", async () => {
    const fetchMock = createAuthenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files?from=cancel#target");
    await expectAuthenticatedShell("/files");
    const dialog = openLogoutDialog();

    expect(within(dialog).getByRole("heading", { name: "退出登录？" })).toBeTruthy();
    expect(
      within(dialog).getByText("退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。", {
        exact: true,
      }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(currentLocation()).toBe("/files?from=cancel#target");
    expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
  });

  it("admits one same-tick confirmation and returns to login after 204", async () => {
    const pendingLogout = deferredResponse();
    const fetchMock = createFetchMock({
      "/api/auth/me": jsonResponse(principal),
      "/api/auth/logout": pendingLogout.promise,
    });
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/files?from=logout#target";

    renderApp(requestedPath);
    await expectAuthenticatedShell("/files");
    const dialog = openLogoutDialog();
    const confirm = within(dialog).getByRole("button", { name: "退出" }) as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(confirm.disabled).toBe(true);
    expect(
      within(getFooter()).getByRole("button", { name: "退出登录" }).hasAttribute("disabled"),
    ).toBe(true);
    pendingLogout.resolve(new Response(null, { status: 204 }));

    await expectLoginAt(requestedPath);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("unmounts a pending footer logout without a late React warning", async () => {
    const pendingLogout = deferredResponse();
    const fetchMock = createFetchMock({
      "/api/auth/me": jsonResponse(principal),
      "/api/auth/logout": pendingLogout.promise,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectAuthenticatedShell("/files");
    fireEvent.click(within(openLogoutDialog()).getByRole("button", { name: "退出" }));
    const logoutOptions = await requestOptionsAt(fetchMock, 1);
    view.unmount();
    expect(logoutOptions?.signal?.aborted).toBe(true);
    pendingLogout.resolve(new Response(null, { status: 204 }));

    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(unauthorizedResponseCases())(
    "clears the session at the same URL after %s logout 401",
    async (_label, logoutResponse) => {
      const fetchMock = createFetchMock({
        "/api/auth/me": jsonResponse(principal),
        "/api/auth/logout": logoutResponse,
      });
      vi.stubGlobal("fetch", fetchMock);
      const requestedPath = "/center?from=logout-401#target";

      renderApp(requestedPath);
      await expectAuthenticatedShell("/center");
      fireEvent.click(within(openLogoutDialog()).getByRole("button", { name: "退出" }));

      await expectLoginAt(requestedPath);
    },
  );

  it.each([
    [
      "a legal non-401 envelope",
      jsonResponse({ error: { code: "forbidden", message: "无法退出当前会话" } }, 403),
      "无法退出当前会话",
    ],
    ["a malformed success", jsonResponse({ ignored: true }), "请求失败，请稍后重试"],
    ["a network failure", new Error("private transport detail"), "请求失败，请稍后重试"],
  ])("keeps the shell and enables retry after %s", async (_label, logoutResult, message) => {
    const fetchMock = createFetchMock({
      "/api/auth/me": jsonResponse(principal),
      "/api/auth/logout": [logoutResult, new Response(null, { status: 204 })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/files?from=logout-failure#target";

    renderApp(requestedPath);
    await expectAuthenticatedShell("/files");
    fireEvent.click(within(openLogoutDialog()).getByRole("button", { name: "退出" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(currentLocation()).toBe(requestedPath);
    expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(within(openLogoutDialog()).getByRole("button", { name: "退出" }));
    await expectLoginAt(requestedPath);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
