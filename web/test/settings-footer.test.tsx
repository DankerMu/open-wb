import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import "./dialog-platform.js";
import "./radix-platform.js";
import {
  authenticatedRoutes,
  createAuthenticatedFetch,
  expectAuthenticatedShell,
  expectLoginAt,
  getFooter,
  openLogoutDialog,
  renderApp,
  resetSettingsTestState,
} from "./settings-support.js";
import {
  createFetchMock,
  currentLocation,
  deferredResponse,
  expectPaths,
  jsonResponse,
  authenticatedPrincipal as principal,
  replaceFetchRoutes,
  requestOptionsAt,
  serviceInfo,
  unauthorizedResponseCases,
} from "./support.js";
import { readRepoFile } from "./ui-support.js";

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
  resetSettingsTestState();
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

  it("keeps a pending logout authoritative when settings requests service information", async () => {
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
    ).resolves.toBeNull();

    expect(logoutOptions?.signal?.aborted).toBe(false);
    expect(fixture.fetchMock.mock.calls.filter(([path]) => path === "/api/info")).toHaveLength(0);
    pendingLogout.resolve(new Response(null, { status: 204 }));
    await expect(logout).resolves.toBe(true);
    await waitFor(() => expect(fixture.getProbe()?.principal).toBeNull());
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
    const dialog = await openLogoutDialog();

    expect(within(dialog).getByRole("heading", { name: "退出登录？" })).toBeTruthy();
    expect(
      within(dialog).getByText("退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(within(dialog).queryByText("退出请求已发送，关闭窗口不会撤销请求。")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout")).toHaveLength(0);
    expect(currentLocation()).toBe("/files?from=cancel#target");
    expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
  });

  it("closes the logout confirmation on Escape and restores the trigger", async () => {
    const fetchMock = createAuthenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectAuthenticatedShell("/files");
    const trigger = within(getFooter()).getByRole("button", { name: "用户菜单", hidden: true });
    const dialog = await openLogoutDialog();

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("dismisses a pending logout without duplicating or cancelling the owned request", async () => {
    const pendingLogout = deferredResponse();
    const fetchMock = createFetchMock(
      authenticatedRoutes({ "/api/auth/logout": pendingLogout.promise }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectAuthenticatedShell("/files");
    const dialog = await openLogoutDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(within(dialog).getByText("退出请求已发送，关闭窗口不会撤销请求。")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout")).toHaveLength(1);
    const trigger = within(getFooter()).getByRole("button", { name: "用户菜单", hidden: true });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    pendingLogout.resolve(new Response(null, { status: 204 }));
    await expectLoginAt("/files");
  });

  it("admits one same-tick confirmation and returns to login after 204", async () => {
    const pendingLogout = deferredResponse();
    const fetchMock = createFetchMock(
      authenticatedRoutes({ "/api/auth/logout": pendingLogout.promise }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/files?from=logout#target";

    renderApp(requestedPath);
    await expectAuthenticatedShell("/files");
    const dialog = await openLogoutDialog();
    const confirm = within(dialog).getByRole("button", { name: "退出" }) as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(confirm.disabled).toBe(true);
    const trigger = within(getFooter()).getByRole("button", { name: "用户菜单", hidden: true });
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    const reopened = await openLogoutDialog();
    const reopenedConfirm = within(reopened).getByRole("button", { name: "退出" });
    expect((reopenedConfirm as HTMLButtonElement).disabled).toBe(true);
    expect(reopenedConfirm.getAttribute("aria-busy")).toBe("true");
    expect(within(reopened).getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    pendingLogout.resolve(new Response(null, { status: 204 }));

    await expectLoginAt(requestedPath);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("unmounts a pending footer logout without a late React warning", async () => {
    const pendingLogout = deferredResponse();
    const fetchMock = createFetchMock(
      authenticatedRoutes({ "/api/auth/logout": pendingLogout.promise }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectAuthenticatedShell("/files");
    fireEvent.click(within(await openLogoutDialog()).getByRole("button", { name: "退出" }));
    const logoutOptions = await requestOptionsAt(fetchMock, 2);
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
      fireEvent.click(within(await openLogoutDialog()).getByRole("button", { name: "退出" }));

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
    const fetchMock = createFetchMock(
      authenticatedRoutes({
        "/api/auth/logout": [logoutResult, new Response(null, { status: 204 })],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const requestedPath = "/files?from=logout-failure#target";

    renderApp(requestedPath);
    await expectAuthenticatedShell("/files");
    fireEvent.click(within(await openLogoutDialog()).getByRole("button", { name: "退出" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(currentLocation()).toBe(requestedPath);
    expect(screen.getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(within(await openLogoutDialog()).getByRole("button", { name: "退出" }));
    await expectLoginAt(requestedPath);
    await waitFor(() =>
      expectPaths(fetchMock, [
        "/api/auth/me",
        "/api/workspaces",
        "/api/auth/logout",
        "/api/auth/logout",
        "/api/info",
      ]),
    );
  });
});

describe("迁移静态契约", () => {
  it("auth 退出确认只经 ConfirmDialog，旧 <dialog> 与样式已移除", () => {
    const footer = readRepoFile("web/src/features/auth/footer.tsx");
    for (const legacy of ["lib/dialog", "<dialog", "showModal", "trapDialogFocus"]) {
      expect(footer).not.toContain(legacy);
    }
    expect(footer).toContain("ConfirmDialog");
    expect(footer).toContain("returnFocus");
    expect(footer).not.toContain("aria-current");
    expect(readRepoFile("web/src/styles.css")).not.toContain(".logout-dialog");
    for (const file of [
      "web/test/settings-footer.test.tsx",
      "web/test/settings-page.test.tsx",
      "web/test/render-app-router.tsx",
    ]) {
      expect(readRepoFile(file)).toMatch(/^import "\.\/radix-platform\.js";$/m);
    }
  });
});
