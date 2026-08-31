import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter, routeManifest } from "../src/routes/index.js";

const expectedPages = [
  {
    path: "/",
    title: "会话",
    description: "S0b 将接入会话与 Agent 链路",
    currentLabel: "会话",
  },
  {
    path: "/files",
    title: "工作空间",
    description: "S1a 将接入工作空间与文件",
    currentLabel: "工作空间",
  },
  {
    path: "/center",
    title: "中心",
    description: "S1d 将接入专家、技能、连接器、知识库、模型与权限",
    currentLabel: "中心",
  },
  {
    path: "/settings",
    title: "设置",
    description: "S0a 后续任务将接入外观与关于设置",
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
    description: "S1a 将接入工作空间与文件",
    currentLabel: "工作空间",
  },
  {
    path: "/center/",
    canonicalPath: "/center",
    title: "中心",
    description: "S1d 将接入专家、技能、连接器、知识库、模型与权限",
    currentLabel: "中心",
  },
  {
    path: "/settings/",
    canonicalPath: "/settings",
    title: "设置",
    description: "S0a 后续任务将接入外观与关于设置",
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
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(authenticatedPrincipal), {
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

async function expectRouteShell({
  title,
  description,
  currentLabel,
}: {
  title: string;
  description: string;
  currentLabel: string;
}) {
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  expect(screen.getByText(description, { exact: true })).toBeTruthy();

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
      description: "S1a 将接入工作空间与文件",
      currentLabel: "工作空间",
    });

    expect(
      within(updatedNavigation).getByRole("link", { name: "会话" }).hasAttribute("aria-current"),
    ).toBe(false);
  });

  it.each(expectedPages)(
    "renders the $path shell",
    async ({ path, title, description, currentLabel }) => {
      setBrowserPath(path);
      authenticateRouter();
      router = createAppRouter();
      render(<RouterProvider router={router} />);

      const { navigation, links } = await expectRouteShell({ title, description, currentLabel });

      expect(links).toHaveLength(4);
      expect(links.map((link) => link.getAttribute("href"))).toEqual(
        expectedSidebarLinks.map(({ path: expectedPath }) => expectedPath),
      );

      for (const expectedLink of expectedSidebarLinks) {
        const label = within(navigation).getByText(expectedLink.label, { exact: true });
        expect(label.closest("a")?.getAttribute("href")).toBe(expectedLink.path);
      }

      expect(within(navigation).getByText("文件·预览·挂载", { exact: true })).toBeTruthy();
      expect(
        within(navigation).getByText("专家·技能·知识库·模型·权限", { exact: true }),
      ).toBeTruthy();
    },
  );

  it.each(trailingSlashPages)(
    "canonicalizes $path to the $canonicalPath shell",
    async ({ path, canonicalPath, title, description, currentLabel }) => {
      setBrowserPath(path);
      authenticateRouter();
      router = createAppRouter();
      render(<RouterProvider router={router} />);

      await waitFor(() => {
        expect(window.location.pathname).toBe(canonicalPath);
      });
      await expectRouteShell({ title, description, currentLabel });
    },
  );
});
