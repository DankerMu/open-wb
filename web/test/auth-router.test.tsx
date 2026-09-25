import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { createAppRouter } from "../src/routes/index.js";
import {
  anonymousGetInit,
  expectAuthenticatedShell,
  expectFilesShell,
  expectLastLoginRequest,
  expectLogin,
  getLoginForm,
  requestSignal,
  submitLogin,
  unauthenticatedResponse,
} from "./auth-router-support.js";
import "./dialog-platform.js";
import {
  allowWorkspaceListFetch,
  calls,
  createFetchMock,
  currentLocation,
  deferredResponse,
  expectPaths,
  type FetchMock,
  jsonResponse,
  lastCall,
  serviceInfo,
  setBrowserPath,
} from "./support.js";

const principal = { id: "user-1", account: "zhangsan", role: "member" };

const protectedPaths = ["/", "/files", "/center", "/settings"] as const;

const canonicalLoginPaths = [
  ["/files/?from=deep-link#target", "/files?from=deep-link#target", "工作空间", "工作空间"],
  ["/center/?from=deep-link#target", "/center?from=deep-link#target", "中心", "中心"],
  ["/settings/?from=deep-link#target", "/settings?from=deep-link#target", "设置", "设置"],
  [
    "/files//?from=repeated-files#target",
    "/files?from=repeated-files#target",
    "工作空间",
    "工作空间",
  ],
  ["/center///?from=repeated-center#target", "/center?from=repeated-center#target", "中心", "中心"],
  [
    "/settings////?from=repeated-settings#target",
    "/settings?from=repeated-settings#target",
    "设置",
    "设置",
  ],
  // biome-ignore format: compact fixture table
  ["/FILES?from=mixed-files-exact#target", "/files?from=mixed-files-exact#target", "工作空间", "工作空间"],
  [
    "/Files/?from=mixed-files-single#target",
    "/files?from=mixed-files-single#target",
    "工作空间",
    "工作空间",
  ],
  [
    "/FILES//?from=mixed-files-repeated#target",
    "/files?from=mixed-files-repeated#target",
    "工作空间",
    "工作空间",
  ],
  ["/CeNtEr///?from=mixed-center#target", "/center?from=mixed-center#target", "中心", "中心"],
  [
    "/SeTTings////?from=mixed-settings#target",
    "/settings?from=mixed-settings#target",
    "设置",
    "设置",
  ],
  [
    "/f%69les?from=encoded-files#target",
    "/files?from=encoded-files#target",
    "工作空间",
    "工作空间",
  ],
  ["/C%45NTER//?from=encoded-center#target", "/center?from=encoded-center#target", "中心", "中心"],
  [
    "/se%74tings///?from=encoded-settings#target",
    "/settings?from=encoded-settings#target",
    "设置",
    "设置",
  ],
] as const;
function observedJsonResponse(body: unknown, status = 200) {
  const json = vi.fn().mockResolvedValue(body);
  return {
    json,
    response: { ok: status >= 200 && status < 300, status, json } as unknown as Response,
  };
}

type AuthStateSnapshot = {
  error: string | null;
  principal: { account: string; id: string; role: string } | null;
  status: "loading" | "authenticated" | "unauthenticated";
};

function AuthStateProbe({
  onReady,
  onState,
}: {
  onReady: (
    login: (credentials: { account: string; password: string }) => Promise<boolean>,
  ) => void;
  onState: (state: AuthStateSnapshot) => void;
}) {
  const auth = useAuth();
  onReady(auth.login);
  onState({
    error: auth.error,
    principal: auth.principal,
    status: auth.status,
  });
  return null;
}

let router: ReturnType<typeof createAppRouter> | undefined;

function renderApp(path: string) {
  setBrowserPath(path);
  allowWorkspaceListFetch();
  router = createAppRouter();
  return render(<RouterProvider router={router} />);
}

async function expectOnlyLoading() {
  expect((await screen.findByRole("status")).textContent).toBe("正在检查登录状态");
  expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
}

/** 恰一个 `/api/auth/me` 请求，且为匿名 GET 形状。 */
function expectMeRequest(fetchMock: FetchMock) {
  expect(calls(fetchMock, "/api/auth/me")).toEqual([["/api/auth/me", anonymousGetInit]]);
}

function expectProviderLoginRequest(fetchMock: FetchMock) {
  expectLastLoginRequest(fetchMock, '{"account":"zhangsan","password":"demo"}');
}

type AuthTransitionFixture = {
  fetchMock: FetchMock;
  login(): Promise<boolean>;
  originalPrincipal: NonNullable<AuthStateSnapshot["principal"]>;
  readState(): AuthStateSnapshot | undefined;
};

async function renderAuthenticatedProvider(
  loginResponse: Response,
  protectedChild: ReactNode = <p>受保护内容</p>,
): Promise<AuthTransitionFixture> {
  const fetchMock = createFetchMock({
    "/api/auth/me": jsonResponse(principal),
    "/api/auth/login": loginResponse,
  });
  vi.stubGlobal("fetch", fetchMock);
  let login: ReturnType<typeof useAuth>["login"] | undefined;
  let state: AuthStateSnapshot | undefined;
  render(
    <AuthProvider>
      <AuthStateProbe
        onReady={(operation) => (login = operation)}
        onState={(next) => (state = next)}
      />
      <AuthGuard>{protectedChild}</AuthGuard>
    </AuthProvider>,
  );
  await waitFor(() => {
    expect(state).toMatchObject({
      principal,
      status: "authenticated",
    });
  });
  if (!login) {
    throw new Error("expected AuthProvider to expose login");
  }
  const providerLogin = login;
  const originalPrincipal = state?.principal;
  if (!originalPrincipal) {
    throw new Error("expected AuthProvider to retain the initial Principal");
  }

  return {
    fetchMock,
    login: () => providerLogin({ account: "zhangsan", password: "demo" }),
    originalPrincipal,
    readState: () => state,
  };
}

async function settleProviderLogin(operation: () => Promise<boolean>) {
  return await act(operation);
}

async function submitProviderLogin(fixture: AuthTransitionFixture) {
  expect(await settleProviderLogin(fixture.login)).toBe(false);
  expectProviderLoginRequest(fixture.fetchMock);
}

async function expectProviderOwnedLoginUnauthenticates(
  fixture: AuthTransitionFixture,
  requestedPath: string,
  message: string,
) {
  expect(await screen.findByText("受保护内容", { exact: true })).toBeTruthy();
  expect(currentLocation()).toBe(requestedPath);

  await submitProviderLogin(fixture);

  await expectLogin();
  await waitFor(() => {
    expect(fixture.readState()).toMatchObject({
      principal: null,
      status: "unauthenticated",
    });
    expect(screen.queryByText("受保护内容", { exact: true })).toBeNull();
    expect(currentLocation()).toBe(requestedPath);
    expectPaths(fixture.fetchMock, ["/api/auth/me", "/api/auth/login", "/api/info"]);
  });
  expect((await screen.findByRole("alert")).textContent).toBe(message);
}

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  setBrowserPath("/");
});

describe("route guard initial authentication", () => {
  it.each(protectedPaths)(
    "keeps %s unchanged while loading and after an unauthenticated me result",
    async (path) => {
      const pendingMe = deferredResponse();
      const fetchMock = createFetchMock({ "/api/auth/me": pendingMe.promise });
      vi.stubGlobal("fetch", fetchMock);
      const requestedPath = `${path}?from=deep-link#target`;

      renderApp(requestedPath);

      await expectOnlyLoading();
      expect(currentLocation()).toBe(requestedPath);
      await waitFor(() => {
        expectMeRequest(fetchMock);
      });

      pendingMe.resolve(unauthenticatedResponse());

      await expectLogin();
      expect(currentLocation()).toBe(requestedPath);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
    },
  );

  it.each([
    ["a 200 non-JSON response", new Response("private response body")],
    ["a fetch rejection", new Error("private transport failure")],
    ["a malformed 401 envelope", jsonResponse({ error: { code: "unauthorized" } }, 401)],
    ["a non-JSON 401 response", new Response("private response body", { status: 401 })],
  ])(
    "keeps the exact URL, shows stable fallback, and permits login after initial %s",
    async (_label, meResult) => {
      const fetchMock = createFetchMock({
        "/api/auth/me": meResult,
        "/api/auth/login": jsonResponse(principal),
      });
      vi.stubGlobal("fetch", fetchMock);
      const requestedPath = "/files?from=initial-failure#target";

      renderApp(requestedPath);

      await expectLogin();
      expect((await screen.findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
      expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
      expect(currentLocation()).toBe(requestedPath);

      submitLogin("zhangsan", "demo");

      await expectFilesShell();
      expect(currentLocation()).toBe(requestedPath);
      expectPaths(fetchMock, ["/api/auth/me", "/api/info", "/api/auth/login", "/api/workspaces"]);
    },
  );
  it("renders the authenticated files shell with one current navigation link", async () => {
    const fetchMock = createFetchMock({ "/api/auth/me": jsonResponse(principal) });
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");

    await expectFilesShell();
    expect(currentLocation()).toBe("/files");
  });

  it.each(canonicalLoginPaths)(
    "canonicalizes %s before auth and preserves search/hash through login",
    async (initialPath, canonicalPath, currentLabel, title) => {
      const meLocations: string[] = [];
      const fetchMock = createFetchMock({
        "/api/auth/me": () => {
          meLocations.push(currentLocation());
          return unauthenticatedResponse();
        },
        "/api/auth/login": jsonResponse(principal),
        "/api/workspaces": jsonResponse({ workspaces: [] }),
        "/api/info": () => jsonResponse(serviceInfo),
      });
      vi.stubGlobal("fetch", fetchMock);

      renderApp(initialPath);

      await expectLogin();
      expect(currentLocation()).toBe(canonicalPath);
      expect(meLocations).toEqual([canonicalPath]);
      await waitFor(() => expectPaths(fetchMock, ["/api/auth/me", "/api/info"]));
      expectMeRequest(fetchMock);

      submitLogin("zhangsan", "demo");

      await expectAuthenticatedShell(title, currentLabel);
      expect(currentLocation()).toBe(canonicalPath);
      const loginPaths = ["/api/auth/me", "/api/info", "/api/auth/login"];
      if (title === "设置") {
        await waitFor(() => expectPaths(fetchMock, [...loginPaths, "/api/info"]));
        expect(calls(fetchMock, "/api/info")).toHaveLength(2);
        expect(lastCall(fetchMock, "/api/info")).toEqual(["/api/info", anonymousGetInit]);
      } else {
        expectPaths(
          fetchMock,
          title === "工作空间" ? [...loginPaths, "/api/workspaces"] : loginPaths,
        );
      }
      expectProviderLoginRequest(fetchMock);
    },
  );

  it("preserves trailing-slash canonicalization after a successful me", async () => {
    const fetchMock = createFetchMock({ "/api/auth/me": jsonResponse(principal) });
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/center/?keep=1#target");

    await expectAuthenticatedShell("中心", "中心");
    expect(currentLocation()).toBe("/center?keep=1#target");
    expectPaths(fetchMock, ["/api/auth/me"]);
    expectMeRequest(fetchMock);
  });

  it("canonicalizes later repeated-slash navigation without remounting the provider", async () => {
    const fetchMock = createFetchMock({ "/api/auth/me": jsonResponse(principal) });
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectFilesShell();
    expectMeRequest(fetchMock);
    const initialMeSignal = await requestSignal(fetchMock, "/api/auth/me");

    window.history.pushState(null, "", "/C%45nTeR///?from=later#target");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await expectAuthenticatedShell("中心", "中心");
    expect(currentLocation()).toBe("/center?from=later#target");
    expect(initialMeSignal.aborted).toBe(false);
    expectPaths(fetchMock, ["/api/auth/me", "/api/workspaces"]);
  });
});

describe("auth transitions and lifecycle", () => {
  it.each([
    ["a Principal", () => observedJsonResponse(principal)],
    [
      "a valid 401",
      () => observedJsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    ],
  ])(
    "does not let stale me %s override a newer provider-owned login",
    async (_label, staleResponse) => {
      const pendingMe = deferredResponse();
      const stale = staleResponse();
      const newerPrincipal = { id: "user-2", account: "lisi", role: "admin" };
      const fetchMock = createFetchMock({
        "/api/auth/me": pendingMe.promise,
        "/api/auth/login": jsonResponse(newerPrincipal),
      });
      vi.stubGlobal("fetch", fetchMock);
      let login: ReturnType<typeof useAuth>["login"] | undefined;
      let state: AuthStateSnapshot | undefined;

      render(
        <AuthProvider>
          <AuthStateProbe
            onReady={(operation) => (login = operation)}
            onState={(next) => (state = next)}
          />
        </AuthProvider>,
      );

      await waitFor(() => {
        expectPaths(fetchMock, ["/api/auth/me"]);
      });
      const staleSignal = await requestSignal(fetchMock, "/api/auth/me");
      expect(staleSignal.aborted).toBe(false);
      if (!login) {
        throw new Error("expected AuthProvider to expose login");
      }

      const providerLogin = login;
      expect(
        await settleProviderLogin(() => providerLogin({ account: "lisi", password: "demo" })),
      ).toBe(true);
      expectPaths(fetchMock, ["/api/auth/me", "/api/auth/login"]);
      expect(staleSignal.aborted).toBe(true);
      expect(state).toMatchObject({ principal: newerPrincipal, status: "authenticated" });
      const currentPrincipal = state?.principal;
      if (!currentPrincipal) {
        throw new Error("expected newer login to set a Principal");
      }

      pendingMe.resolve(stale.response);

      await waitFor(() => {
        expect(stale.json).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({ principal: newerPrincipal, status: "authenticated" });
      });
      expect(state?.principal).toBe(currentPrincipal);
    },
  );

  it("renders login at the same location after a provider-owned login 401", async () => {
    const requestedPath = "/files?from=session#target";
    setBrowserPath(requestedPath);
    const fixture = await renderAuthenticatedProvider(unauthenticatedResponse("会话已过期"));

    await expectProviderOwnedLoginUnauthenticates(fixture, requestedPath, "会话已过期");
  });

  it("shows the stable fallback after a provider-owned login with a malformed 401 envelope", async () => {
    const requestedPath = "/center?from=provider-malformed#target";
    setBrowserPath(requestedPath);
    const fixture = await renderAuthenticatedProvider(
      jsonResponse({ error: { code: "unauthorized" } }, 401),
    );

    await expectProviderOwnedLoginUnauthenticates(fixture, requestedPath, "请求失败，请稍后重试");
  });

  it("preserves an authenticated Principal after a provider-owned login 403", async () => {
    const requestedPath = "/settings?from=provider-403#target";
    setBrowserPath(requestedPath);
    const fixture = await renderAuthenticatedProvider(
      jsonResponse(
        { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
        403,
      ),
    );
    const { originalPrincipal: principal } = fixture;

    expect(await screen.findByText("受保护内容", { exact: true })).toBeTruthy();
    expect(currentLocation()).toBe(requestedPath);

    await submitProviderLogin(fixture);
    expectPaths(fixture.fetchMock, ["/api/auth/me", "/api/auth/login"]);

    expect(fixture.readState()).toMatchObject({
      error: null,
      principal,
      status: "authenticated",
    });
    expect(fixture.readState()?.principal).toBe(principal);
    expect(screen.getByText("受保护内容", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(currentLocation()).toBe(requestedPath);
  });

  it("aborts pending authentication and suppresses its late 401 callback after unmount", async () => {
    const pendingMe = deferredResponse();
    const lateUnauthorized = observedJsonResponse(
      { error: { code: "unauthorized", message: "登录已失效" } },
      401,
    );
    const fetchMock = createFetchMock({ "/api/auth/me": pendingMe.promise });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectOnlyLoading();
    const signal = await requestSignal(fetchMock, "/api/auth/me");
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    pendingMe.resolve(lateUnauthorized.response);

    await waitFor(() => {
      expect(lateUnauthorized.json).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    });
    consoleError.mockRestore();
  });

  it("aborts pending login without a late state update", async () => {
    const pendingLogin = deferredResponse();
    const latePrincipal = observedJsonResponse(principal);
    const fetchMock = createFetchMock({
      "/api/auth/me": unauthenticatedResponse(),
      "/api/auth/login": pendingLogin.promise,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectLogin();
    submitLogin("zhangsan", "demo");
    const signal = await requestSignal(fetchMock, "/api/auth/login");
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    pendingLogin.resolve(latePrincipal.response);

    await waitFor(() => {
      expect(latePrincipal.json).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    });
    consoleError.mockRestore();
  });

  it("starts a fresh mount without an old Principal, error, or password", async () => {
    const firstPendingLogin = deferredResponse();
    const fetchMock = createFetchMock({
      "/api/auth/me": [unauthenticatedResponse(), unauthenticatedResponse()],
      "/api/auth/login": firstPendingLogin.promise,
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstView = renderApp("/files");
    await expectLogin();
    const firstForm = getLoginForm();
    fireEvent.change(firstForm.account, { target: { value: "zhangsan" } });
    fireEvent.change(firstForm.password, { target: { value: "demo" } });
    fireEvent.submit(firstForm.submit.closest("form") as HTMLFormElement);
    expect(firstForm.submit.disabled).toBe(true);
    firstView.unmount();
    router?.dispose();
    router = undefined;
    firstPendingLogin.resolve(jsonResponse(principal));

    renderApp("/files");
    await expectLogin();
    const freshForm = getLoginForm();
    expect(freshForm.account.value).toBe("");
    expect(freshForm.password.value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
  });
});
