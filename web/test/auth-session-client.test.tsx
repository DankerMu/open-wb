import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { FilesPage } from "../src/features/files/index.js";
import type { ApiClient, LoginCredentials, Principal, ServiceInfo } from "../src/lib/api.js";
import { authenticatedFilesRoutes, cleanupFilesFixture, workspace } from "./files-fixture.js";
import { createFetchMock, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const principal = { id: "user-1", account: "zhangsan", role: "member" };

type FetchHandler = (path: string, options?: RequestInit) => Promise<Response>;

type AuthProbeState = {
  createSessionClient(): ApiClient;
  loadServiceInfo(callerSignal: AbortSignal): Promise<ServiceInfo | null>;
  login(credentials: LoginCredentials): Promise<boolean>;
  principal: Principal | null;
  status: "loading" | "authenticated" | "unauthenticated";
};

function SessionClientProbe({ onState }: { onState(state: AuthProbeState): void }) {
  const auth = useAuth();
  onState({
    createSessionClient: auth.createSessionClient,
    loadServiceInfo: auth.loadServiceInfo,
    login: auth.login,
    principal: auth.principal,
    status: auth.status,
  });
  return null;
}

async function renderAuthenticatedProvider(handler: FetchHandler) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  let probe: AuthProbeState | undefined;
  const view = render(
    <AuthProvider>
      <SessionClientProbe onState={(state) => (probe = state)} />
      <AuthGuard>
        <p>受保护页面</p>
      </AuthGuard>
    </AuthProvider>,
  );

  await waitFor(() => {
    expect(probe).toMatchObject({ principal, status: "authenticated" });
  });
  const getProbe = () => {
    if (!probe) {
      throw new Error("expected an authenticated session client probe");
    }

    return probe;
  };
  return { fetchMock, getProbe, view };
}

afterEach(() => {
  cleanupFilesFixture();
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function expectProtectedSession(probe: AuthProbeState) {
  expect(screen.getByText("受保护页面", { exact: true })).toBeTruthy();
  expect(probe).toMatchObject({ principal, status: "authenticated" });
}

function startOldWorkspaceList(getProbe: () => AuthProbeState) {
  const oldClient = getProbe().createSessionClient();
  return oldClient.listWorkspaces().then(
    () => new Error("expected the old request to reject"),
    (error: unknown) => error,
  );
}

async function loginWhileAuthenticated(
  getProbe: () => AuthProbeState,
  credentials: { account: string; password: string } = { account: "zhangsan", password: "demo" },
) {
  await act(async () => {
    await expect(getProbe().login(credentials)).resolves.toBe(true);
  });
}

async function renderMountedFilesPage(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(authenticatedFilesRoutes([workspace], routes));
  vi.stubGlobal("fetch", fetchMock);
  let probe: AuthProbeState | undefined;
  const router = createMemoryRouter(
    [
      {
        path: "/files",
        element: (
          <AuthProvider>
            <SessionClientProbe onState={(state) => (probe = state)} />
            <AuthGuard>
              <FilesPage />
            </AuthGuard>
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: ["/files?ws=workspace-1"] },
  );
  const view = render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(probe).toMatchObject({ principal, status: "authenticated" });
  });
  const getProbe = () => {
    if (!probe) {
      throw new Error("expected an authenticated files-page probe");
    }

    return probe;
  };
  return { fetchMock, getProbe, view };
}

describe("provider session-bound file client", () => {
  it.each([
    [
      "a legal envelope",
      jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    ],
    ["a malformed envelope", jsonResponse({ error: { code: "unauthorized" } }, 401)],
    ["a non-JSON body", new Response("private response", { status: 401 })],
  ])("clears the current session for %s file 401", async (_label, response) => {
    const fixture = await renderAuthenticatedProvider((path) => {
      if (path === "/api/auth/me") {
        return Promise.resolve(jsonResponse(principal));
      }
      if (path === "/api/workspaces") {
        return Promise.resolve(response);
      }

      throw new Error(`unexpected request ${path}`);
    });
    const client = fixture.getProbe().createSessionClient();

    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(Error);
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(fixture.getProbe()).toMatchObject({ principal: null, status: "unauthenticated" });
  });

  it("ignores a caller-aborted current file 401", async () => {
    const late = deferredResponse();
    const fixture = await renderAuthenticatedProvider((path) => {
      if (path === "/api/auth/me") {
        return Promise.resolve(jsonResponse(principal));
      }
      if (path === "/api/workspaces") {
        return late.promise;
      }

      throw new Error(`unexpected request ${path}`);
    });
    const controller = new AbortController();
    const request = fixture
      .getProbe()
      .createSessionClient()
      .listWorkspaces({ signal: controller.signal })
      .then(
        () => new Error("expected the aborted request to reject"),
        (error: unknown) => error,
      );

    controller.abort();
    await act(async () => {
      late.resolve(jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401));
    });
    expect(await request).toBeInstanceOf(Error);
    expectProtectedSession(fixture.getProbe());
  });

  it("does not let an old same-account client 401 clear a renewed session", async () => {
    const late = deferredResponse();
    const fixture = await renderAuthenticatedProvider((path) => {
      if (path === "/api/auth/me") {
        return Promise.resolve(jsonResponse(principal));
      }
      if (path === "/api/auth/login") {
        return Promise.resolve(jsonResponse(principal));
      }
      if (path === "/api/workspaces") {
        return late.promise;
      }

      throw new Error(`unexpected request ${path}`);
    });
    const oldRequest = startOldWorkspaceList(fixture.getProbe);
    await loginWhileAuthenticated(fixture.getProbe);
    await act(async () => {
      late.resolve(jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401));
    });
    expect(await oldRequest).toBeInstanceOf(Error);
    expectProtectedSession(fixture.getProbe());
  });

  it("keeps file requests concurrent while an auth-slot service-info request is pending", async () => {
    const info = deferredResponse();
    const preview = deferredResponse();
    const tree = deferredResponse();
    const fixture = await renderAuthenticatedProvider((path) => {
      if (path === "/api/auth/me") {
        return Promise.resolve(jsonResponse(principal));
      }
      if (path === "/api/info") {
        return info.promise;
      }
      if (path === "/api/workspaces/workspace-1/tree?path=out") {
        return tree.promise;
      }
      if (path === "/api/workspaces/workspace-1/file?path=readme.md") {
        return preview.promise;
      }

      throw new Error(`unexpected request ${path}`);
    });
    const caller = new AbortController();
    const serviceInfo = fixture.getProbe().loadServiceInfo(caller.signal);
    const client = fixture.getProbe().createSessionClient();
    const treeRequest = client.listTree("workspace-1", "out");
    const previewRequest = client.fetchPreview("workspace-1", "readme.md");

    await waitFor(() => {
      expect(fixture.fetchMock).toHaveBeenCalledTimes(4);
    });
    expect(fixture.fetchMock.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/api/info",
        "/api/workspaces/workspace-1/tree?path=out",
        "/api/workspaces/workspace-1/file?path=readme.md",
      ]),
    );

    await act(async () => {
      info.resolve(jsonResponse({ name: "workbuddy-app-server", version: "0.0.0" }));
      tree.resolve(jsonResponse({ path: "out", entries: [] }));
      preview.resolve(textPreviewResponse("# readme"));
    });
    await expect(serviceInfo).resolves.toEqual({ name: "workbuddy-app-server", version: "0.0.0" });
    await expect(treeRequest).resolves.toEqual({ path: "out", entries: [] });
    await expect(previewRequest).resolves.toMatchObject({ kind: "text", text: "# readme" });
    expectProtectedSession(fixture.getProbe());
  });

  it("renews a mounted files page client so old 401s are ignored and new ones clear the session", async () => {
    const lateOldList = deferredResponse();
    let workspaceLists = 0;
    const fixture = await renderMountedFilesPage({
      "/api/auth/login": jsonResponse(principal),
      "/api/workspaces": (_path, options) => {
        if (options?.method === "POST") {
          throw new Error("unexpected workspace creation");
        }
        workspaceLists += 1;
        if (workspaceLists === 2) {
          return lateOldList.promise;
        }
        if (workspaceLists >= 3) {
          return jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401);
        }
        return jsonResponse({ workspaces: [workspace] });
      },
      "/api/workspaces/workspace-1/tree?path=": jsonResponse({
        path: "",
        entries: [{ name: "out", type: "dir", size: 0, mtime: 1 }],
      }),
      "/api/workspaces/workspace-1/tree?path=out": jsonResponse({ path: "out", entries: [] }),
    });

    await screen.findByRole("button", { name: "展开 out" });
    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    await screen.findByRole("button", { name: "折叠 out" });
    const firstWorkspaceLists = workspaceLists;
    const oldRequest = startOldWorkspaceList(fixture.getProbe);
    await loginWhileAuthenticated(fixture.getProbe);
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(fixture.getProbe()).toMatchObject({ principal: null, status: "unauthenticated" });
    expect(screen.queryByRole("heading", { level: 1, name: "工作空间" })).toBeNull();
    expect(workspaceLists).toBeGreaterThan(firstWorkspaceLists + 1);

    await act(async () => {
      lateOldList.resolve(
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
      );
    });
    expect(await oldRequest).toBeInstanceOf(Error);
    expect(fixture.getProbe()).toMatchObject({ principal: null, status: "unauthenticated" });
  });

  it("does not request the previous account workspace while the renewed list is pending", async () => {
    const otherPrincipal = { id: "user-2", account: "lisi", role: "member" };
    const otherWorkspace = {
      id: "workspace-b",
      name: "李四文档",
      dir: "lisi-docs",
      root: "/sandbox/user-2/lisi-docs",
      createdAt: 1_726_000_000_100,
    };
    const lateList = deferredResponse();
    let workspaceLists = 0;
    const fixture = await renderMountedFilesPage({
      "/api/auth/login": jsonResponse(otherPrincipal),
      "/api/workspaces": (_path, options) => {
        if (options?.method === "POST") {
          throw new Error("unexpected workspace creation");
        }
        workspaceLists += 1;
        if (workspaceLists === 1) {
          return jsonResponse({ workspaces: [workspace] });
        }
        return lateList.promise;
      },
      "/api/workspaces/workspace-1/tree?path=": jsonResponse({
        path: "",
        entries: [{ name: "secret.txt", type: "file", size: 1, mtime: 1 }],
      }),
      "/api/workspaces/workspace-b/tree?path=": jsonResponse({ path: "", entries: [] }),
    });

    await screen.findByRole("button", { name: "secret.txt" });
    const treeCallsBeforeRenewal = fixture.fetchMock.mock.calls.filter(
      ([path]) => path === "/api/workspaces/workspace-1/tree?path=",
    ).length;

    await act(async () => {
      await expect(fixture.getProbe().login({ account: "lisi", password: "demo" })).resolves.toBe(
        true,
      );
    });
    expect(await screen.findByText("正在读取工作空间", { exact: true })).toBeTruthy();
    expect(screen.queryByText("secret.txt", { exact: true })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "工作空间目录树" })).toBeNull();
    expect(
      fixture.fetchMock.mock.calls.filter(
        ([path]) => path === "/api/workspaces/workspace-1/tree?path=",
      ),
    ).toHaveLength(treeCallsBeforeRenewal);
    expect(
      fixture.fetchMock.mock.calls.filter(
        ([path]) => typeof path === "string" && path.startsWith("/api/workspaces/workspace-1/file"),
      ),
    ).toHaveLength(0);
    expect(
      fixture.fetchMock.mock.calls.filter(
        ([path]) => path === "/api/workspaces/workspace-b/tree?path=",
      ),
    ).toHaveLength(0);

    await act(async () => {
      lateList.resolve(jsonResponse({ workspaces: [otherWorkspace] }));
    });
    await waitFor(() => {
      expect(screen.getByText("李四文档", { exact: true })).toBeTruthy();
    });
    expect(screen.queryByText("secret.txt", { exact: true })).toBeNull();
    expect(
      fixture.fetchMock.mock.calls.filter(
        ([path]) => path === "/api/workspaces/workspace-b/tree?path=",
      ),
    ).not.toHaveLength(0);
    expect(fixture.getProbe()).toMatchObject({
      principal: otherPrincipal,
      status: "authenticated",
    });
  });
});
