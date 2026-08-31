export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export type ReadStoredTheme = () => string | null;
export type MatchMedia = (query: string) => { matches: boolean };

export function normalizeTheme(value: string | null): Theme {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }

  return "system";
}

export function loadTheme(readStoredTheme?: ReadStoredTheme): Theme {
  if (!readStoredTheme) {
    return "system";
  }

  try {
    return normalizeTheme(readStoredTheme());
  } catch {
    return "system";
  }
}

export function resolveTheme(theme: Theme, matchMedia: MatchMedia): ResolvedTheme {
  if (theme !== "system") {
    return theme;
  }

  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
