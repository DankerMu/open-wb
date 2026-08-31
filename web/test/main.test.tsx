import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authenticatedPrincipal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

let disposeMain: (() => void) | undefined;

async function loadMain(path: "/" | "/files", fetchResult?: Promise<Response>) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(fetchResult ?? Promise.resolve(jsonResponse())));
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const main = await import("../src/main.js");
  disposeMain = main.disposeApp;
}

function jsonResponse() {
  return new Response(JSON.stringify(authenticatedPrincipal), {
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
    expect(await screen.findByRole("heading", { level: 1, name: "会话" })).toBeTruthy();
    expect(screen.getByText("S0b 将接入会话与 Agent 链路", { exact: true })).toBeTruthy();
    expect(screen.getByRole("link", { name: "会话" }).getAttribute("aria-current")).toBe("page");
  });

  it("renders the 工作空间 shell from the initial browser history", async () => {
    await loadMain("/files");

    expect(disposeMain).toBeTypeOf("function");
    expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(screen.getByText("S1a 将接入工作空间与文件", { exact: true })).toBeTruthy();
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
