import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../src/features/theme/index.js";

type MediaChangeListener = (event: { matches: boolean }) => void;

type FakeMediaQuery = {
  addEventListener: ReturnType<typeof vi.fn>;
  emit(matches: boolean): void;
  removeEventListener: ReturnType<typeof vi.fn>;
  matches: boolean;
};

function createMediaQuery(initialMatches: boolean): FakeMediaQuery {
  const listeners = new Set<MediaChangeListener>();
  return {
    addEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === "change") {
        listeners.add(listener);
      }
    }),
    emit(matches: boolean) {
      this.matches = matches;
      for (const listener of listeners) {
        listener({ matches });
      }
    },
    removeEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === "change") {
        listeners.delete(listener);
      }
    }),
    matches: initialMatches,
  };
}

function ThemeProbe() {
  const { resolvedTheme, selectedTheme, setTheme } = useTheme();

  return (
    <div>
      <p>{`selected:${selectedTheme}`}</p>
      <p>{`resolved:${resolvedTheme}`}</p>
      <button onClick={() => setTheme("light")} type="button">
        light
      </button>
      <button onClick={() => setTheme("dark")} type="button">
        dark
      </button>
      <button onClick={() => setTheme("system")} type="button">
        system
      </button>
    </div>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

function expectTheme(selectedTheme: string, resolvedTheme: string) {
  expect(screen.getByText(`selected:${selectedTheme}`)).toBeTruthy();
  expect(screen.getByText(`resolved:${resolvedTheme}`)).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe(resolvedTheme);
}

function installMediaQuery(mediaQuery: FakeMediaQuery) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mediaQuery),
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeProvider initialization", () => {
  it("imports and renders without browser globals using system and light fallbacks", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    const { ThemeProvider: ServerThemeProvider, useTheme: useServerTheme } = await import(
      "../src/features/theme/index.js"
    );

    function ServerProbe() {
      const { resolvedTheme, selectedTheme } = useServerTheme();
      return <p>{`${selectedTheme}:${resolvedTheme}`}</p>;
    }

    expect(
      renderToString(
        <ServerThemeProvider>
          <ServerProbe />
        </ServerThemeProvider>,
      ),
    ).toContain("system:light");
  });

  it.each([
    ["an absent stored value", null],
    ["an unknown stored value", "sepia"],
  ])("uses system and the light fallback for %s", (_label, storedTheme) => {
    const mediaQuery = createMediaQuery(false);
    installMediaQuery(mediaQuery);
    vi.spyOn(Storage.prototype, "getItem").mockReturnValue(storedTheme);

    renderTheme();

    expectTheme("system", "light");
  });

  it("uses system when storage reads throw and resolves the current dark preference", () => {
    const mediaQuery = createMediaQuery(true);
    installMediaQuery(mediaQuery);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderTheme();

    expectTheme("system", "dark");
  });

  it.each([
    ["light", false, "light"],
    ["dark", false, "dark"],
    ["light", true, "light"],
    ["dark", true, "dark"],
  ])(
    "keeps fixed %s independent of the current system preference",
    (storedTheme, matches, expected) => {
      const mediaQuery = createMediaQuery(matches);
      installMediaQuery(mediaQuery);
      vi.spyOn(Storage.prototype, "getItem").mockReturnValue(storedTheme);

      renderTheme();

      expectTheme(storedTheme, expected);
    },
  );

  it("falls back to light without matchMedia", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });

    renderTheme();

    expectTheme("system", "light");
  });
});

describe("ThemeProvider selection and subscriptions", () => {
  it("immediately applies and best-effort persists each selected theme", () => {
    const mediaQuery = createMediaQuery(false);
    installMediaQuery(mediaQuery);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "light" }));

    expectTheme("light", "light");
    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "light");

    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expectTheme("dark", "dark");
    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "dark");

    fireEvent.click(screen.getByRole("button", { name: "system" }));

    expectTheme("system", "light");
    expect(setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "system");
  });

  it("retains its selected and resolved theme when storage writes throw", () => {
    const mediaQuery = createMediaQuery(false);
    installMediaQuery(mediaQuery);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "dark" }));

    expectTheme("dark", "dark");
  });

  it("tracks media changes only while system is selected and never rewrites system", () => {
    const mediaQuery = createMediaQuery(true);
    installMediaQuery(mediaQuery);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderTheme();
    expect(screen.getByText("resolved:dark")).toBeTruthy();
    act(() => {
      mediaQuery.emit(false);
    });

    expect(screen.getByText("resolved:light")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    mediaQuery.emit(false);

    expect(screen.getByText("selected:dark")).toBeTruthy();
    expect(screen.getByText("resolved:dark")).toBeTruthy();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("syncs only the production storage key without echoing remote values", () => {
    const mediaQuery = createMediaQuery(false);
    installMediaQuery(mediaQuery);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    renderTheme();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "another-key", newValue: "dark" }));
    });
    expect(screen.getByText("selected:system")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }),
      );
    });
    expect(screen.getByText("selected:dark")).toBeTruthy();
    expect(screen.getByText("resolved:dark")).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "light" }),
      );
    });
    expect(screen.getByText("selected:light")).toBeTruthy();
    expect(screen.getByText("resolved:light")).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "system" }),
      );
    });
    expect(screen.getByText("selected:system")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: null }));
    });
    expect(screen.getByText("selected:system")).toBeTruthy();
    expect(screen.getByText("resolved:light")).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "sepia" }),
      );
    });
    expect(screen.getByText("selected:system")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("removes browser listeners and ignores manually delivered late events after unmount", () => {
    const mediaQuery = createMediaQuery(false);
    installMediaQuery(mediaQuery);
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const view = renderTheme();
    const storageRegistration = addWindowListener.mock.calls.find(([type]) => type === "storage");
    const storageListener = storageRegistration?.[1] as EventListener | undefined;
    expect(storageListener).toBeTypeOf("function");
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    view.unmount();

    expect(removeWindowListener).toHaveBeenCalledWith("storage", storageListener);
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    act(() => {
      storageListener?.(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }));
      mediaQuery.emit(true);
    });
    expect(setItem).not.toHaveBeenCalled();
  });
});
