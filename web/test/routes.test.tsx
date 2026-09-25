import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter, routeManifest } from "../src/routes/index.js";
import "./dialog-platform.js";

const expectedPages = [
  {
    path: "/",
    title: "WorkBuddy，我帮你",
    currentLabel: "会话",
  },
  {
    path: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/center",
    title: "中心",
    currentLabel: "中心",
  },
  {
    path: "/settings",
    title: "设置",
    currentLabel: "设置",
  },
] as const;

const expectedSidebarLinks = [
  { path: "/", label: "会话" },
  { path: "/files", label: "工作空间" },
  { path: "/center", label: "中心" },
  { path: "/settings", label: "设置" },
] as const;

const trailingSlashPages = [
  {
    path: "/files/",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/center/",
    canonicalPath: "/center",
    title: "中心",
    currentLabel: "中心",
  },
  {
    path: "/settings/",
    canonicalPath: "/settings",
    title: "设置",
    currentLabel: "设置",
  },
  {
    path: "/files//",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/center///",
    canonicalPath: "/center",
    title: "中心",
    currentLabel: "中心",
  },
  {
    path: "/settings////",
    canonicalPath: "/settings",
    title: "设置",
    currentLabel: "设置",
  },
  {
    path: "/FILES",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/Files/",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/FILES//",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/CeNtEr///",
    canonicalPath: "/center",
    title: "中心",
    currentLabel: "中心",
  },
  {
    path: "/SeTTings////",
    canonicalPath: "/settings",
    title: "设置",
    currentLabel: "设置",
  },
  {
    path: "/f%69les",
    canonicalPath: "/files",
    title: "工作空间",
    currentLabel: "工作空间",
  },
  {
    path: "/C%45NTER//",
    canonicalPath: "/center",
    title: "中心",
    currentLabel: "中心",
  },
  {
    path: "/se%74tings///",
    canonicalPath: "/settings",
    title: "设置",
    currentLabel: "设置",
  },
] as const;

const authenticatedPrincipal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

let router: ReturnType<typeof createAppRouter> | undefined;

function setBrowserPath(path: string) {
  window.history.replaceState(null, "", path);
}

function authenticateRouter() {
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.resolve(
          new Response(JSON.stringify(authenticatedPrincipal), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (path === "/api/workspaces") {
        return Promise.resolve(
          new Response(JSON.stringify({ workspaces: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (path === "/api/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessions: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (path === "/api/info") {
        return Promise.resolve(
          new Response(JSON.stringify({ name: "workbuddy-app-server", version: "0.0.0" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      throw new Error(`unexpected request ${path}`);
    }),
  );
}

async function expectRouteShell({ title, currentLabel }: { title: string; currentLabel: string }) {
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  if (title === "WorkBuddy，我帮你") {
    expect(screen.getByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeTruthy();
  }

  const sidebar = screen.getByRole("complementary", { name: "侧栏" });
  const navigation = within(sidebar).getByRole("navigation", { name: "主导航" });
  const links = within(navigation).getAllByRole("link");
  const currentLinks = links.filter((link) => link.getAttribute("aria-current") === "page");

  expect(currentLinks).toHaveLength(1);
  expect(links.filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
  expect(
    within(currentLinks[0] as HTMLElement).getByText(currentLabel, { exact: true }),
  ).toBeTruthy();

  return { navigation, links };
}

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  setBrowserPath("/");
});

describe("SPA route manifest", () => {
  it("contains only the four flat shell paths", () => {
    const paths: readonly string[] = routeManifest.map(({ path }) => path);

    expect(paths).toEqual(["/", "/files", "/center", "/settings"]);
    expect(paths).not.toContain("/tokens");
    expect(paths).not.toContain("*");
    expect(paths.some((path) => path.startsWith("/center/"))).toBe(false);
  });

  it("describes the delivered settings surface", () => {
    const settingsRoute = routeManifest.find(({ path }) => path === "/settings");

    expect(settingsRoute).toMatchObject({ description: "主题与服务信息" });
  });
});

describe("SPA shell routes", () => {
  it("navigates from 会话 to 工作空间", async () => {
    setBrowserPath("/");
    authenticateRouter();
    router = createAppRouter();
    render(<RouterProvider router={router} />);

    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });
    const navigation = within(sidebar).getByRole("navigation", { name: "主导航" });
    const workspaceLink = within(navigation).getByText("工作空间", { exact: true }).closest("a");
    expect(workspaceLink).toBeTruthy();
    fireEvent.click(workspaceLink as HTMLAnchorElement);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/files");
    });
    const { navigation: updatedNavigation } = await expectRouteShell({
      title: "工作空间",
      currentLabel: "工作空间",
    });

    expect(
      within(updatedNavigation).getByRole("link", { name: "会话" }).hasAttribute("aria-current"),
    ).toBe(false);
  });

  it.each(expectedPages)("renders the $path shell", async ({ path, title, currentLabel }) => {
    setBrowserPath(path);
    authenticateRouter();
    router = createAppRouter();
    render(<RouterProvider router={router} />);

    const { navigation, links } = await expectRouteShell({ title, currentLabel });

    expect(links).toHaveLength(4);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      expectedSidebarLinks.map(({ path: expectedPath }) => expectedPath),
    );

    for (const expectedLink of expectedSidebarLinks) {
      const label = within(navigation).getByText(expectedLink.label, { exact: true });
      expect(label.closest("a")?.getAttribute("href")).toBe(expectedLink.path);
    }
  });

  it.each(trailingSlashPages)(
    "canonicalizes $path to the $canonicalPath shell",
    async ({ path, canonicalPath, title, currentLabel }) => {
      setBrowserPath(path);
      authenticateRouter();
      router = createAppRouter();
      render(<RouterProvider router={router} />);

      await waitFor(() => {
        expect(window.location.pathname).toBe(canonicalPath);
      });
      await expectRouteShell({ title, currentLabel });
    },
  );
});
