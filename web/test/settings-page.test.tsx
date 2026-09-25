import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./dialog-platform.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import "./radix-platform.js";
import {
  createAuthenticatedFetch,
  currentRouter,
  disposeRouter,
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
  jsonResponse,
  authenticatedPrincipal as principal,
  requestOptionsAt,
  serviceInfo,
  unauthorizedResponseCases,
} from "./support.js";
import { blockBody, readRepoFile, stripComments } from "./ui-support.js";

afterEach(() => {
  resetSettingsTestState();
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
      within(group).getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("当前生效：浅色", { exact: true })).toBeTruthy();
    expect(await screen.findByText(serviceInfo.name, { exact: true })).toBeTruthy();
    expect(screen.getByText(`版本 ${serviceInfo.version}`, { exact: true })).toBeTruthy();
    expect(screen.queryByText("5.3.11", { exact: true })).toBeNull();
    const about = screen.getByRole("region", { name: "关于" });
    expect(about.textContent).not.toContain(serviceInfo.auth.provider);
  });

  it("uses the single theme context to update appearance controls and the root immediately", async () => {
    const fetchMock = createAuthenticatedFetch();
    vi.stubGlobal("fetch", fetchMock);

    renderApp("/settings");
    const group = await screen.findByRole("radiogroup", { name: "主题" });
    fireEvent.click(within(group).getByRole("radio", { name: "深色" }));

    expect(within(group).getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe(
      "true",
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
      await currentRouter()?.navigate("/files");
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

    fireEvent.click(within(await openLogoutDialog()).getByRole("button", { name: "退出" }));
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
      const about = screen.getByRole("region", { name: "关于" });
      expect(within(about).queryByText("正在读取服务信息", { exact: true })).toBeNull();
      expect(within(about).getByRole("alert").textContent).toBe("请求失败，请稍后重试");
    });

    await waitFor(() => {
      const about = screen.getByRole("region", { name: "关于" });
      expect(within(footer).getByRole("alert").textContent).toBe(logoutError);
      expect(within(about).getByRole("alert").textContent).toBe("请求失败，请稍后重试");
      expect(within(about).queryByText(serviceInfo.name, { exact: true })).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});

function ariaChecked(name: string) {
  return screen.getByRole("radio", { name }).getAttribute("aria-checked");
}

async function renderSettings() {
  vi.stubGlobal("fetch", createAuthenticatedFetch());
  renderApp("/settings");
  await expectAuthenticatedShell("/settings");
}

describe("settings appearance card", () => {
  it("S1 lays out the theme row with a SegmentedControl and the current-theme row", async () => {
    await renderSettings();

    const appearance = screen.getByRole("region", { name: "外观" });
    expect(within(appearance).getAllByRole("radiogroup")).toHaveLength(1);
    const group = within(appearance).getByRole("radiogroup", { name: "主题" });
    expect(group.className).toBe("ui-seg");
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((item) => item.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    expect(radios.map((item) => item.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(radios.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    for (const legacy of ['input[type="radio"]', "fieldset", ".theme-swatch"]) {
      expect(appearance.querySelector(legacy), legacy).toBeNull();
    }
    const titles = [...appearance.querySelectorAll(".settings-row-title")];
    expect(titles.map((title) => title.textContent)).toEqual(["主题", "当前生效"]);
    expect(
      within(appearance).getByText("浅色 / 深色 / 跟随系统 · 即时生效并持久保存", { exact: true }),
    ).toBeTruthy();

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["外观", "关于"]);
    expect(headings.map((heading) => heading.closest(".settings-card"))).toEqual([null, null]);

    const themeRow = titles[0]?.closest(".settings-row");
    expect(themeRow).toBeTruthy();
    expect(group.closest(".settings-row")).toBe(themeRow);
    const control = group.closest(".settings-row-control");
    const text = themeRow?.querySelector(".settings-row-text");
    expect(control).toBeTruthy();
    expect(text?.compareDocumentPosition(control as Element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const card = themeRow?.closest(".settings-card");
    expect(card).toBeTruthy();
    expect(titles[1]?.closest(".settings-row")?.closest(".settings-card")).toBe(card);
  });

  it("S2 keeps the visible and accessible current-theme text in step with the selection", async () => {
    window.localStorage.setItem("workbuddy-theme", "light");
    await renderSettings();

    const visible = screen.getByText("浅色 · 持久保存于 localStorage", { exact: true });
    const row = visible.closest(".settings-row") as HTMLElement;
    expect(visible.getAttribute("aria-hidden")).toBe("true");
    expect(within(row).getByText("当前生效", { exact: true }).getAttribute("aria-hidden")).toBe(
      "true",
    );
    const accessible = screen.getByText("当前生效：浅色", { exact: true });
    expect(accessible.className).toBe("ui-sr-only");
    expect(accessible.closest(".settings-row")).toBe(row);

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    expect(ariaChecked("深色")).toBe("true");
    expect(ariaChecked("浅色")).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("workbuddy-theme")).toBe("dark");
    expect(screen.getByText("当前生效：深色", { exact: true })).toBeTruthy();
    expect(screen.getByText("深色 · 持久保存于 localStorage", { exact: true })).toBeTruthy();
    expect(screen.queryByText("浅色 · 持久保存于 localStorage", { exact: true })).toBeNull();

    cleanup();
    disposeRouter();
    await renderSettings();

    expect(ariaChecked("深色")).toBe("true");
    expect(screen.getByText("当前生效：深色", { exact: true })).toBeTruthy();
  });
});

describe("settings follow-system theme", () => {
  afterEach(() => {
    uninstallMatchMedia();
  });

  it("S3 follows the system preference and keeps storing system", async () => {
    window.localStorage.setItem("workbuddy-theme", "light");
    const dark = createMediaQuery(true);
    installMatchMedia((query) =>
      query === "(prefers-color-scheme: dark)" ? dark : createMediaQuery(false),
    );
    await renderSettings();

    expect(ariaChecked("浅色")).toBe("true");
    expect(screen.getByText("当前生效：浅色", { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "跟随系统" }));

    expect(ariaChecked("跟随系统")).toBe("true");
    expect(window.localStorage.getItem("workbuddy-theme")).toBe("system");
    expect(screen.getByText("当前生效：深色", { exact: true })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => {
      dark.emit(false);
    });

    expect(screen.getByText("当前生效：浅色", { exact: true })).toBeTruthy();
    expect(screen.getByText("浅色 · 持久保存于 localStorage", { exact: true })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("workbuddy-theme")).toBe("system");
  });
});

describe("settings about card", () => {
  it("S4 shows BrandMark, name and version in one row without provider or demo text", async () => {
    await renderSettings();

    const about = screen.getByRole("region", { name: "关于" });
    const name = await within(about).findByText(serviceInfo.name, { exact: true });
    const mark = within(about).getByRole("img", { name: "WorkBuddy" });
    expect(mark.tagName).toBe("svg");
    expect(about.querySelector("img")).toBeNull();
    const titles = [...about.querySelectorAll(".settings-row-title")];
    expect(titles.map((title) => title.textContent)).toEqual([serviceInfo.name]);
    expect(titles[0]).toBe(name);
    const version = within(about).getByText(`版本 ${serviceInfo.version}`, { exact: true });
    for (const hidden of [serviceInfo.auth.provider, "5.3.11", "Live Demo"]) {
      expect(about.textContent).not.toContain(hidden);
    }
    const row = mark.closest(".settings-row");
    expect(row).toBeTruthy();
    expect(name.closest(".settings-row")).toBe(row);
    expect(version.closest(".settings-row")).toBe(row);
    const text = row?.querySelector(".settings-row-text");
    expect(mark.compareDocumentPosition(text as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("S5 keeps BrandMark while loading", async () => {
    const pendingInfo = deferredResponse();
    vi.stubGlobal("fetch", createAuthenticatedFetch(pendingInfo.promise));
    renderApp("/settings");
    await expectAuthenticatedShell("/settings");

    const about = screen.getByRole("region", { name: "关于" });
    expect(within(about).getByText("正在读取服务信息", { exact: true })).toBeTruthy();
    expect(within(about).getByRole("img", { name: "WorkBuddy" })).toBeTruthy();
    pendingInfo.resolve(jsonResponse(serviceInfo));
    expect(await within(about).findByText(serviceInfo.name, { exact: true })).toBeTruthy();
  });

  it("S5 keeps BrandMark without name or version on a malformed success", async () => {
    const legacyInfo = { name: serviceInfo.name, version: serviceInfo.version };
    vi.stubGlobal("fetch", createAuthenticatedFetch(jsonResponse(legacyInfo)));
    renderApp("/settings");
    await expectAuthenticatedShell("/settings");

    const about = screen.getByRole("region", { name: "关于" });
    expect((await within(about).findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    expect(within(about).getByRole("img", { name: "WorkBuddy" })).toBeTruthy();
    expect(about.querySelector(".settings-row-title")).toBeNull();
    expect(about.textContent).not.toContain("版本");
  });
});

describe("settings static contract", () => {
  it("S6 page uses the primitives and drops the legacy radio markup", () => {
    const page = readRepoFile("web/src/features/settings/page.tsx");
    for (const token of ["SegmentedControl", "BrandMark", "ui-sr-only"]) {
      expect(page).toContain(token);
    }
    for (const legacy of ['type="radio"', "fieldset", "theme-swatch", "@radix-ui"]) {
      expect(page).not.toContain(legacy);
    }
  });

  it("S6 moves the settings rules out of styles.css into settings.css", () => {
    const styles = readRepoFile("web/src/styles.css");
    for (const legacy of [
      ".theme-option",
      ".theme-swatch",
      ".service-identity",
      ".settings-card",
      ".settings-page",
    ]) {
      expect(styles).not.toContain(legacy);
    }
    expect(styles).toContain('@import "./features/settings/settings.css";');

    const settings = readRepoFile("web/src/features/settings/settings.css");
    expect(settings).toContain("demo.html:818-824");
    expect(settings).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const rules = stripComments(settings);
    expect(blockBody(rules, /@media \(max-width: 760px\)/)).toContain("flex-wrap: wrap");
    expect(blockBody(rules, /^\.settings-row \{/m)).toContain("display: flex");
  });

  it("S6 keeps .ui-sr-only visually hidden without removing its geometry", () => {
    const rule = blockBody(stripComments(readRepoFile("web/src/ui/ui.css")), /\.ui-sr-only \{/);
    for (const declaration of ["position: absolute", "width: 1px", "clip: rect(0 0 0 0)"]) {
      expect(rule).toContain(declaration);
    }
    for (const hidden of ["display: none", "visibility: hidden"]) {
      expect(rule).not.toContain(hidden);
    }
  });
});

describe("settings route migration", () => {
  it("S7 keeps all eight migrated settings route declarations", () => {
    const source = readRepoFile("web/test/settings-page.test.tsx");
    const opener = `describe(${JSON.stringify("settings route")}, () => {`;
    const start = source.indexOf(opener);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.lastIndexOf(opener)).toBe(start);
    const end = source.indexOf("\ndescribe(", start);
    const block = source.slice(start, end === -1 ? undefined : end);
    const titles = [...block.matchAll(/\bit\(\s*"([^"]+)"|\)\(\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? match[2],
    );
    expect(titles.sort()).toEqual(
      [
        "mounts the theme owner before canonical navigation starts authentication",
        "renders only the appearance and about cards with the returned service identity",
        "uses the single theme context to update appearance controls and the root immediately",
        "shows loading until the Provider-owned info operation returns",
        "keeps the Principal and shell for %s",
        "transitions to login at the same URL for %s info 401",
        "aborts the exact info request on settings cleanup and suppresses its late response",
        "settles About after failed logout supersedes pending service information",
      ].sort(),
    );
    const footer = readRepoFile("web/test/settings-footer.test.tsx");
    expect(footer).not.toContain(opener);
    expect(footer).toMatch(/for \(const file of \[[^\]]*"web\/test\/settings-page\.test\.tsx"/);
  });
});
