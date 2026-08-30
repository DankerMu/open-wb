import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let disposeMain: (() => void) | undefined;

async function loadMain(path: "/" | "/files") {
  window.history.replaceState(null, "", path);
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const main = await import("../src/main.js");
  disposeMain = main.disposeApp;
}

afterEach(() => {
  act(() => {
    disposeMain?.();
  });
  disposeMain = undefined;
  cleanup();
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
});
