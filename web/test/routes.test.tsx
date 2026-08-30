import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
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

let router: ReturnType<typeof createAppRouter> | undefined;

function setBrowserPath(path: string) {
  window.history.replaceState(null, "", path);
}

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
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
    router = createAppRouter();
    render(<RouterProvider router={router} />);

    const sidebar = screen.getByRole("complementary", { name: "侧栏" });
    const navigation = within(sidebar).getByRole("navigation", { name: "主导航" });
    const workspaceLink = within(navigation).getByText("工作空间", { exact: true }).closest("a");
    expect(workspaceLink).toBeTruthy();
    fireEvent.click(workspaceLink as HTMLAnchorElement);

    expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(window.location.pathname).toBe("/files");
    expect(screen.getByText("S1a 将接入工作空间与文件", { exact: true })).toBeTruthy();

    const links = within(navigation).getAllByRole("link");
    const currentLinks = links.filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(
      within(currentLinks[0] as HTMLElement).getByText("工作空间", { exact: true }),
    ).toBeTruthy();
    expect(
      within(navigation).getByRole("link", { name: "会话" }).hasAttribute("aria-current"),
    ).toBe(false);
  });

  it.each(expectedPages)(
    "renders the $path shell",
    async ({ path, title, description, currentLabel }) => {
      setBrowserPath(path);
      router = createAppRouter();
      render(<RouterProvider router={router} />);

      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
      expect(screen.getByText(description, { exact: true })).toBeTruthy();

      const sidebar = screen.getByRole("complementary", { name: "侧栏" });
      const navigation = within(sidebar).getByRole("navigation", { name: "主导航" });
      const links = within(navigation).getAllByRole("link");

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

      const currentLinks = links.filter((link) => link.getAttribute("aria-current") === "page");
      expect(currentLinks).toHaveLength(1);
      expect(links.filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
      expect(
        within(currentLinks[0] as HTMLElement).getByText(currentLabel, { exact: true }),
      ).toBeTruthy();
    },
  );
});
