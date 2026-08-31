import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { createAppRouter } from "../src/routes/index.js";

const principal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

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
  [
    "/FILES?from=mixed-files-exact#target",
    "/files?from=mixed-files-exact#target",
    "工作空间",
    "工作空间",
  ],
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

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function observedJsonResponse(body: unknown, status = 200) {
  const json = vi.fn().mockResolvedValue(body);
  const response = {
    ok: status >= 200 && status < 300,
    status,
    json,
  } as unknown as Response;

  return { json, response };
}

async function requestSignal(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex: number,
): Promise<AbortSignal> {
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(callIndex + 1);
  });

  const request = fetchMock.mock.calls[callIndex];
  const signal = (request?.[1] as RequestInit | undefined)?.signal;
  if (!signal) {
    throw new Error(`expected fetch call ${callIndex + 1} to include an AbortSignal`);
  }

  return signal;
}

function unauthenticatedResponse(message = "登录已失效") {
  return jsonResponse({ error: { code: "unauthorized", message } }, 401);
}

function setBrowserPath(path: string) {
  window.history.replaceState(null, "", path);
}

function currentLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

type AuthStateSnapshot = Pick<ReturnType<typeof useAuth>, "error" | "principal" | "status"> & {
  exposesApiClient: boolean;
};

function AuthStateProbe({
  onReady,
  onState,
}: {
  onReady: (login: ReturnType<typeof useAuth>["login"]) => void;
  onState: (state: AuthStateSnapshot) => void;
}) {
  const auth = useAuth();
  onReady(auth.login);
  onState({
    error: auth.error,
    exposesApiClient: Object.hasOwn(auth, "apiClient"),
    principal: auth.principal,
    status: auth.status,
  });
  return null;
}

let router: ReturnType<typeof createAppRouter> | undefined;

function renderApp(path: string) {
  setBrowserPath(path);
  router = createAppRouter();
  return render(<RouterProvider router={router} />);
}

async function expectLogin() {
  expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
}

function getLoginForm() {
  const account = screen.getByLabelText("账号") as HTMLInputElement;
  const password = screen.getByLabelText("密码") as HTMLInputElement;
  const submit = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;
  return { account, password, submit };
}

function submitLogin(accountValue: string, passwordValue: string) {
  const { account, password, submit } = getLoginForm();
  fireEvent.change(account, { target: { value: accountValue } });
  fireEvent.change(password, { target: { value: passwordValue } });
  fireEvent.submit(submit.closest("form") as HTMLFormElement);
  return { account, password, submit };
}

async function expectAuthenticatedShell(title: string, currentLabel: string) {
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
  const sidebar = screen.getByRole("complementary", { name: "侧栏" });
  const current = within(sidebar).getByRole("link", { name: new RegExp(currentLabel) });
  const currentLinks = within(sidebar)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page");

  expect(current.getAttribute("aria-current")).toBe("page");
  expect(currentLinks).toHaveLength(1);
  expect(currentLinks[0]).toBe(current);
}

async function expectFilesShell() {
  await expectAuthenticatedShell("工作空间", "工作空间");
}

async function expectOnlyLoading() {
  expect((await screen.findByRole("status")).textContent).toBe("正在检查登录状态");
  expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
}

function expectMeRequest(fetchMock: ReturnType<typeof vi.fn>, callIndex = 1) {
  expect(fetchMock).toHaveBeenNthCalledWith(callIndex, "/api/auth/me", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: expect.any(AbortSignal),
  });
}

function expectProviderLoginRequest(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: '{"account":"zhangsan","password":"demo"}',
    signal: expect.any(AbortSignal),
  });
}

type AuthTransitionFixture = {
  fetchMock: ReturnType<typeof vi.fn>;
  login(): Promise<boolean>;
  originalPrincipal: NonNullable<AuthStateSnapshot["principal"]>;
  readState(): AuthStateSnapshot | undefined;
};

async function renderAuthenticatedProvider(
  loginResponse: Response,
  protectedChild?: ReactNode,
): Promise<AuthTransitionFixture> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(principal))
    .mockResolvedValueOnce(loginResponse);
  vi.stubGlobal("fetch", fetchMock);
  let login: ReturnType<typeof useAuth>["login"] | undefined;
  let state: AuthStateSnapshot | undefined;

  render(
    <AuthProvider>
      <AuthStateProbe
        onReady={(operation) => (login = operation)}
        onState={(next) => (state = next)}
      />
      {protectedChild ? <AuthGuard>{protectedChild}</AuthGuard> : null}
    </AuthProvider>,
  );

  await waitFor(() => {
    expect(state).toMatchObject({
      exposesApiClient: false,
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

async function submitProviderLogin(fixture: AuthTransitionFixture) {
  await expect(fixture.login()).resolves.toBe(false);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
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
      exposesApiClient: false,
      principal: null,
      status: "unauthenticated",
    });
    expect(screen.queryByText("受保护内容", { exact: true })).toBeNull();
    expect(currentLocation()).toBe(requestedPath);
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
      const fetchMock = vi.fn().mockReturnValue(pendingMe.promise);
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
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() =>
          meResult instanceof Error ? Promise.reject(meResult) : Promise.resolve(meResult),
        )
        .mockResolvedValueOnce(jsonResponse(principal));
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
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("renders the authenticated files shell with one current navigation link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");

    await expectFilesShell();
    expect(currentLocation()).toBe("/files");
  });

  it.each(canonicalLoginPaths)(
    "canonicalizes %s before auth and preserves search/hash through login",
    async (initialPath, canonicalPath, currentLabel, title) => {
      const meLocations: string[] = [];
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => {
          meLocations.push(currentLocation());
          return Promise.resolve(unauthenticatedResponse());
        })
        .mockResolvedValueOnce(jsonResponse(principal));
      vi.stubGlobal("fetch", fetchMock);

      renderApp(initialPath);

      await expectLogin();
      expect(currentLocation()).toBe(canonicalPath);
      expect(meLocations).toEqual([canonicalPath]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectMeRequest(fetchMock);

      submitLogin("zhangsan", "demo");

      await expectAuthenticatedShell(title, currentLabel);
      expect(currentLocation()).toBe(canonicalPath);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectProviderLoginRequest(fetchMock);
    },
  );

  it("preserves trailing-slash canonicalization after a successful me", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/center/?keep=1#target");

    await expectAuthenticatedShell("中心", "中心");
    expect(currentLocation()).toBe("/center?keep=1#target");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectMeRequest(fetchMock);
  });

  it("canonicalizes later repeated-slash navigation without remounting the provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectFilesShell();
    expectMeRequest(fetchMock);
    const initialMeSignal = await requestSignal(fetchMock, 0);

    window.history.pushState(null, "", "/C%45nTeR///?from=later#target");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await expectAuthenticatedShell("中心", "中心");
    expect(currentLocation()).toBe("/center?from=later#target");
    expect(initialMeSignal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unauthenticatedResponse())
        .mockReturnValueOnce(pendingLogin.promise);
      vi.stubGlobal("fetch", fetchMock);

      renderApp(requestedPath);
      await expectLogin();
      const { account, password, submit } = getLoginForm();
      fireEvent.change(account, { target: { value: "  ZhangSan " } });
      fireEvent.change(password, { target: { value: "demo" } });
      fireEvent.submit(submit.closest("form") as HTMLFormElement);
      fireEvent.submit(submit.closest("form") as HTMLFormElement);

      expect(submit.disabled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: '{"account":"  ZhangSan ","password":"demo"}',
        signal: expect.any(AbortSignal),
      });

      pendingLogin.resolve(jsonResponse(principal));

      await expectFilesShell();
      expect(currentLocation()).toBe(requestedPath);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("uses the native form submit seam for Enter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthenticatedResponse())
      .mockResolvedValueOnce(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectLogin();
    const { account, password } = getLoginForm();
    fireEvent.change(account, { target: { value: "zhangsan" } });
    fireEvent.change(password, { target: { value: "demo" } });
    fireEvent.keyDown(password, { key: "Enter", code: "Enter" });
    fireEvent.submit(password.closest("form") as HTMLFormElement);

    await expectFilesShell();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unauthenticatedResponse())
        .mockResolvedValueOnce(loginResponse);
      vi.stubGlobal("fetch", fetchMock);

      renderApp("/files");
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthenticatedResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
    await expectLogin();
    const { account, password, submit } = getLoginForm();
    account.value = "  Filled Account ";
    password.value = "filled-password";
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toBe("该账号已停用，请联系管理员");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"account":"  Filled Account ","password":"filled-password"}',
      signal: expect.any(AbortSignal),
    });
    expect(account.value).toBe("  Filled Account ");
    expect(password.value).toBe("");
    expect(submit.disabled).toBe(false);

    password.value = "retry-password";
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    await expectFilesShell();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"account":"  Filled Account ","password":"retry-password"}',
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a malformed login response", () => Promise.resolve(jsonResponse({ account: "zhangsan" }))],
    ["a network failure", () => Promise.reject(new Error("private transport failure"))],
  ])("shows the stable fallback for %s", async (_label, loginResult) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthenticatedResponse())
      .mockImplementationOnce(loginResult);
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/files");
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
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(pendingMe.promise)
        .mockResolvedValueOnce(jsonResponse(newerPrincipal));
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const staleSignal = await requestSignal(fetchMock, 0);
      expect(staleSignal.aborted).toBe(false);
      if (!login) {
        throw new Error("expected AuthProvider to expose login");
      }

      await expect(login({ account: "lisi", password: "demo" })).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(staleSignal.aborted).toBe(true);
      await waitFor(() => {
        expect(state).toMatchObject({ principal: newerPrincipal, status: "authenticated" });
      });
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
    const fixture = await renderAuthenticatedProvider(
      unauthenticatedResponse("会话已过期"),
      <p>受保护内容</p>,
    );

    await expectProviderOwnedLoginUnauthenticates(fixture, requestedPath, "会话已过期");
  });

  it("shows the stable fallback after a provider-owned login with a malformed 401 envelope", async () => {
    const requestedPath = "/center?from=provider-malformed#target";
    setBrowserPath(requestedPath);
    const fixture = await renderAuthenticatedProvider(
      jsonResponse({ error: { code: "unauthorized" } }, 401),
      <p>受保护内容</p>,
    );

    await expectProviderOwnedLoginUnauthenticates(fixture, requestedPath, "请求失败，请稍后重试");
  });

  it("preserves an authenticated Principal after a provider-owned login 403", async () => {
    const fixture = await renderAuthenticatedProvider(
      jsonResponse(
        { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
        403,
      ),
    );
    const { originalPrincipal: principal } = fixture;

    await submitProviderLogin(fixture);
    await waitFor(() => {
      expect(fixture.readState()).toMatchObject({
        error: null,
        exposesApiClient: false,
        status: "authenticated",
      });
      expect(fixture.readState()?.principal).toBe(principal);
    });
  });

  it("aborts pending authentication and suppresses its late 401 callback after unmount", async () => {
    const pendingMe = deferredResponse();
    const lateUnauthorized = observedJsonResponse(
      { error: { code: "unauthorized", message: "登录已失效" } },
      401,
    );
    const fetchMock = vi.fn().mockReturnValue(pendingMe.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectOnlyLoading();
    const signal = await requestSignal(fetchMock, 0);
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthenticatedResponse())
      .mockReturnValueOnce(pendingLogin.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderApp("/files");
    await expectLogin();
    submitLogin("zhangsan", "demo");
    const signal = await requestSignal(fetchMock, 1);
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthenticatedResponse())
      .mockReturnValueOnce(firstPendingLogin.promise)
      .mockResolvedValueOnce(unauthenticatedResponse());
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
