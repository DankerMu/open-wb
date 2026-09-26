import { describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY } from "../src/features/theme/index.js";
import { loadTheme, type MatchMedia, resolveTheme } from "../src/lib/theme.js";
import { createMediaQuery } from "./media-query-support.js";
import { readRepoFile } from "./ui-support.js";

// #429：web/index.html 的首帧前内联脚本须与 theme.ts（loadTheme + resolveTheme）逐输入一致。
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type StoredCase = { name: string; getItem: (key: string) => string | null };
type MediaCase = { name: string; matchMedia: MatchMedia | undefined };

const STORED: StoredCase[] = [
  ...["light", "dark", "system", "bogus", null].map((value) => ({
    name: `stored ${String(value)}`,
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  })),
  {
    name: "getItem throws",
    getItem: () => {
      throw new Error("storage unavailable");
    },
  },
];

const MEDIA: MediaCase[] = [
  { name: "system dark", matchMedia: (query) => createMediaQuery(query === SYSTEM_DARK_QUERY) },
  { name: "system light", matchMedia: () => createMediaQuery(false) },
  {
    name: "matchMedia throws",
    matchMedia: () => {
      throw new Error("matchMedia unavailable");
    },
  },
  { name: "matchMedia undefined", matchMedia: undefined },
];

function headDocument(): Document {
  return new DOMParser().parseFromString(readRepoFile("web/index.html"), "text/html");
}

const CLASSIC_INLINE_SCRIPT = "script:not([src]):not([type])";

function inlineScript(): string {
  const scripts = headDocument().head.querySelectorAll(CLASSIC_INLINE_SCRIPT);
  expect(scripts, "web/index.html <head> has exactly one classic inline script").toHaveLength(1);
  return scripts[0]?.textContent ?? "";
}

// provider.tsx resolveBrowserTheme/getMediaQuery：matchMedia 缺失或抛错按不匹配（浅色）。
function providerMatchMedia(matchMedia: MatchMedia | undefined): MatchMedia {
  return (query) => {
    try {
      return matchMedia ? matchMedia(query) : { matches: false };
    } catch {
      return { matches: false };
    }
  };
}

function runInlineScript(source: string, stored: StoredCase, media: MediaCase) {
  const localStorage = { getItem: stored.getItem };
  const window = { localStorage, matchMedia: media.matchMedia };
  const document = { documentElement: { dataset: {} as DOMStringMap } };
  new Function("window", "document", "localStorage", "matchMedia", source)(
    window,
    document,
    localStorage,
    media.matchMedia,
  );
  return document.documentElement.dataset.theme;
}

describe("首帧前主题内联脚本", () => {
  it("读取 ThemeProvider 的同一存储键（防键名漂移）", () => {
    expect(inlineScript()).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("是 <head> 内样式表 <link> 之前唯一的经典脚本", () => {
    inlineScript();
    const head = headDocument().head;
    const script = head.querySelector(CLASSIC_INLINE_SCRIPT);
    const link = head.querySelector('link[rel="stylesheet"]');
    expect(script).not.toBeNull();
    expect(link).not.toBeNull();
    if (!script || !link) return;
    expect(script.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const cases = STORED.flatMap((stored) => MEDIA.map((media) => ({ stored, media })));
  it.each(cases.map((entry) => [`${entry.stored.name} × ${entry.media.name}`, entry] as const))(
    "%s 与 loadTheme + resolveTheme 一致",
    (_name, { stored, media }) => {
      const expected = resolveTheme(
        loadTheme(() => stored.getItem(THEME_STORAGE_KEY)),
        providerMatchMedia(media.matchMedia),
      );
      const source = inlineScript();
      let actual: string | undefined;
      expect(() => {
        actual = runInlineScript(source, stored, media);
      }).not.toThrow();
      expect(actual).toBe(expected);
    },
  );
});
