import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadTheme,
  normalizeTheme,
  type ResolvedTheme,
  resolveTheme,
  type Theme,
} from "../../lib/theme.js";

export const THEME_STORAGE_KEY = "workbuddy-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

type ThemeState = {
  selectedTheme: Theme;
  resolvedTheme: ResolvedTheme;
};

export type ThemeContextValue = ThemeState & {
  setTheme(theme: Theme): void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }

  try {
    return window.matchMedia(SYSTEM_THEME_QUERY);
  } catch {
    return null;
  }
}

function resolveBrowserTheme(theme: Theme): ResolvedTheme {
  return resolveTheme(theme, (query) => {
    if (query !== SYSTEM_THEME_QUERY) {
      return { matches: false };
    }

    return { matches: getMediaQuery()?.matches ?? false };
  });
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return loadTheme();
  }

  return loadTheme(() => window.localStorage.getItem(THEME_STORAGE_KEY));
}

function applyResolvedTheme(theme: ResolvedTheme) {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = theme;
  }
}

function persistTheme(theme: Theme) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage failures must not rollback the current visual selection.
  }
}

function initialThemeState(): ThemeState {
  const selectedTheme = readStoredTheme();
  return { selectedTheme, resolvedTheme: resolveBrowserTheme(selectedTheme) };
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [themeState, setThemeState] = useState<ThemeState>(initialThemeState);
  const selectedThemeRef = useRef(themeState.selectedTheme);

  useLayoutEffect(() => {
    applyResolvedTheme(themeState.resolvedTheme);
  }, [themeState.resolvedTheme]);

  const setTheme = useCallback((theme: Theme) => {
    const selectedTheme = normalizeTheme(theme);
    const resolvedTheme = resolveBrowserTheme(selectedTheme);
    selectedThemeRef.current = selectedTheme;
    setThemeState({ selectedTheme, resolvedTheme });
    applyResolvedTheme(resolvedTheme);
    persistTheme(selectedTheme);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let active = true;
    const mediaQuery = getMediaQuery();
    const onMediaChange = (event: MediaQueryListEvent) => {
      if (!active || selectedThemeRef.current !== "system") {
        return;
      }

      const resolvedTheme: ResolvedTheme = event.matches ? "dark" : "light";
      applyResolvedTheme(resolvedTheme);
      setThemeState((current) =>
        current.selectedTheme === "system" ? { ...current, resolvedTheme } : current,
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (!active || event.key !== THEME_STORAGE_KEY) {
        return;
      }

      const selectedTheme = normalizeTheme(event.newValue);
      const resolvedTheme = resolveBrowserTheme(selectedTheme);
      selectedThemeRef.current = selectedTheme;
      applyResolvedTheme(resolvedTheme);
      setThemeState({ selectedTheme, resolvedTheme });
    };

    mediaQuery?.addEventListener("change", onMediaChange);
    window.addEventListener("storage", onStorage);

    return () => {
      active = false;
      mediaQuery?.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...themeState, setTheme }),
    [setTheme, themeState],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
