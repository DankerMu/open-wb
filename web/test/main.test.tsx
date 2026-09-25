import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./dialog-platform.js";

const authenticatedPrincipal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

let disposeMain: (() => void) | undefined;

async function loadMain(path: "/" | "/files", fetchResult?: Promise<Response>) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal(
    "fetch",
    vi.fn((requestPath: string) => {
      if (requestPath === "/api/auth/me") {
        return fetchResult ?? Promise.resolve(jsonResponse());
      }
      if (requestPath === "/api/workspaces") {
        return Promise.resolve(jsonResponse({ workspaces: [] }));
      }
      if (requestPath === "/api/sessions") {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }

      throw new Error(`unexpected request ${requestPath}`);
    }),
  );
  document.body.innerHTML = '<div id="root"></div>';
  // The entry owns a singleton root, so each test intentionally re-evaluates it after resetModules.
  vi.resetModules();
  const main = await import("../src/main.js");
  disposeMain = main.disposeApp;
}

function jsonResponse(body: unknown = authenticatedPrincipal) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  act(() => {
    disposeMain?.();
  });
  disposeMain = undefined;
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("SPA root entry", () => {
  it("renders the default route shell into the Vite root element", async () => {
    await loadMain("/");

    expect(disposeMain).toBeTypeOf("function");
    expect(
      await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "会话" }).getAttribute("aria-current")).toBe("page");
  });

  it("renders the 工作空间 page from the initial browser history", async () => {
    await loadMain("/files");

    expect(disposeMain).toBeTypeOf("function");
    expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(await screen.findByText("未选择工作空间", { exact: true })).toBeTruthy();
    expect(screen.getByText("工作空间目录", { exact: true })).toBeTruthy();
    expect(screen.getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(screen.getByRole("link", { name: /工作空间/ }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("unmounts before disposing the router while authentication is pending", async () => {
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loadMain("/files", pendingResponse);

    expect(await screen.findByRole("status")).toBeTruthy();
    act(() => {
      disposeMain?.();
    });
    resolveResponse(jsonResponse());

    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
