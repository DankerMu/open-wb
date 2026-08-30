import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMain() {
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  await import("../src/main.js");
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("SPA root entry", () => {
  it("renders the minimal WorkBuddy root into the Vite root element", async () => {
    await loadMain();

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "WorkBuddy" }).textContent).toBe("WorkBuddy");
    });
  });
});
