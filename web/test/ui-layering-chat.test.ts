import { describe, expect, it } from "vitest";
import { CHAT_DIR, isUnder, MIGRATED_AREAS, type SourceFile } from "./ui-layering-support.js";
import { listRepoFiles, readRepoFile } from "./ui-support.js";

/**
 * 会话页迁移终态（纯函数）：`CHAT_DIR` 下的每个 `.ts`/`.tsx` 都逐个登记在已迁移清单里（按路径全等，
 * 不走前缀，没有豁免名单），目录里不得有 `.css`。
 */
function chatEndStateViolations(paths: string[], migrated: string[]): string[] {
  return paths.flatMap((path) => {
    if (path.endsWith(".css")) return [`${path}: 会话页目录不得有 .css`];
    if (!/\.tsx?$/.test(path)) return [];
    return migrated.includes(path) ? [] : [`${path}: 会话页文件未登记为已迁移`];
  });
}

/** 开标签：从 `<名字` 到第一个不属于 `=>` 的 `>`（跨行；属性表达式里的箭头函数不截断）。 */
const OPENING_TAG = /<[A-Za-z][\w.]*(?:=>|[^>])*>/g;

/**
 * 显式列表语义（纯函数）：开标签带 `list-none` 的也必须带 `role="list"`——去掉列表符号的样式会让
 * Safari 丢掉列表语义。返回缺角色的开标签；标签之外提到 `list-none` 的注释不算。
 */
function listRoleViolations(file: SourceFile): string[] {
  return (file.text.match(OPENING_TAG) ?? [])
    .filter((tag) => tag.includes("list-none") && !tag.includes('role="list"'))
    .map((tag) => `${file.path}: 带 list-none 的列表缺 role="list"（${tag.split("\n")[0]}）`);
}

describe("显式列表语义（session-todo「任务清单面板」；s1f-chat-followups 2.1）", () => {
  const path = `${CHAT_DIR}/todo-panel.tsx`;
  const violations = (text: string) => listRoleViolations({ path, text });

  it("判定自证：单行与跨行的缺角色各判失败，带角色、标签之外的注释与别的元素上的角色不误判", () => {
    expect(violations('<ul className="m-0 list-none p-0">')).toHaveLength(1);
    expect(
      violations('<ul\n  onClick={() => pick()}\n  className={`list-none`}\n  data-slot="x"\n>'),
    ).toHaveLength(1);
    expect(violations('<ul className="m-0 list-none p-0" role="list">')).toEqual([]);
    expect(
      violations('<ul\n  onClick={() => pick()}\n  className="list-none"\n  role="list"\n>'),
    ).toEqual([]);
    expect(violations('{/* list-none 的说明 */}\n<ul className="p-0">')).toEqual([]);
    // 角色写在子元素或相邻元素上不算数；`listbox` 不是 `list`。
    expect(violations('<ul className="list-none">\n  <li role="list">')).toHaveLength(1);
    expect(violations('<div role="list" />\n<ul className="list-none">')).toHaveLength(1);
    expect(violations('<ul className="list-none" role="listbox">')).toHaveLength(1);
    // 真实文件去掉角色判失败。
    const source = readRepoFile(path);
    expect(violations(source)).toEqual([]);
    expect(source).toContain('role="list"');
    expect(violations(source.replace(/\s*role="list"/, ""))).toHaveLength(1);
  });

  it('web/src 现状：已迁移区域的 .tsx 里带 list-none 的开标签都带 role="list"', () => {
    const files = listRepoFiles("web/src", (file) => file.endsWith(".tsx"))
      .filter((file) => MIGRATED_AREAS.some((area) => isUnder(file, area)))
      .map((file) => ({ path: file, text: readRepoFile(file) }));
    // 扫描没有放空：这四个文件确有带 list-none 的开标签。
    const withLists = files
      .filter((file) =>
        (file.text.match(OPENING_TAG) ?? []).some((tag) => tag.includes("list-none")),
      )
      .map((file) => file.path);
    expect(withLists).toEqual(
      expect.arrayContaining(
        ["capability-bar.tsx", "project-config.tsx", "todo-panel.tsx", "welcome.tsx"].map(
          (name) => `${CHAT_DIR}/${name}`,
        ),
      ),
    );
    expect(files.flatMap(listRoleViolations)).toEqual([]);
  });
});

describe("会话页迁移终态（ui-foundation「会话页迁移终态」）", () => {
  const chatPaths = () => listRepoFiles(CHAT_DIR, () => true);

  it("判定自证：未登记的文件、未登记的会话列表文件、目录下的 .css（含 chat.css）各判失败", () => {
    const paths = ["page.tsx", "session-menu.tsx", "stream.ts"].map(
      (name) => `${CHAT_DIR}/${name}`,
    );
    expect(chatEndStateViolations(paths, MIGRATED_AREAS)).toEqual([]);
    const extra = `${CHAT_DIR}/extra.ts`;
    expect(chatEndStateViolations([...paths, extra], MIGRATED_AREAS)).toEqual([
      `${extra}: 会话页文件未登记为已迁移`,
    ]);
    const nested = `${CHAT_DIR}/parts/session-menu.tsx`;
    expect(chatEndStateViolations([nested], MIGRATED_AREAS)).toHaveLength(1);
    for (const css of [`${CHAT_DIR}/chat.css`, `${CHAT_DIR}/messages.css`]) {
      expect(chatEndStateViolations([...paths, css], MIGRATED_AREAS)).toEqual([
        `${css}: 会话页目录不得有 .css`,
      ]);
    }
    // 没有豁免残留：页面文件与会话列表文件从清单里滤掉后都判失败。
    for (const path of [`${CHAT_DIR}/page.tsx`, `${CHAT_DIR}/session-menu.tsx`]) {
      expect(
        chatEndStateViolations(
          paths,
          MIGRATED_AREAS.filter((entry) => entry !== path),
        ),
      ).toEqual([`${path}: 会话页文件未登记为已迁移`]);
    }
    // 登记目录本身不算数：终态按路径全等，逐个文件登记。
    expect(chatEndStateViolations([`${CHAT_DIR}/page.tsx`], [CHAT_DIR])).toHaveLength(1);
  });

  it("web/src/features/chat 现状：每个 .ts/.tsx 都已登记，没有 .css 与 session-filter.tsx，legacy.css 不导入会话页", () => {
    const paths = chatPaths();
    expect(paths.filter((path) => path.endsWith(".css"))).toEqual([]);
    expect(paths).not.toContain(`${CHAT_DIR}/session-filter.tsx`);
    expect(readRepoFile("web/src/styles/legacy.css")).not.toContain("features/chat");
    expect(chatEndStateViolations(paths, MIGRATED_AREAS)).toEqual([]);
    // 反向：会话页的清单条目恰是目录里的源文件，不多不少。
    expect(MIGRATED_AREAS.filter((entry) => isUnder(entry, CHAT_DIR))).toEqual(
      paths.filter((path) => /\.tsx?$/.test(path)),
    );
  });

  it("web/src/components/assistant-ui 只有三个组件、它们的 registry 依赖与 styles.d.ts", () => {
    const dir = "web/src/components/assistant-ui";
    const files = listRepoFiles(dir, () => true);
    expect(files).toEqual([
      `${dir}/elements/markdown-text.tsx`,
      `${dir}/elements/reasoning.aui.tsx`,
      `${dir}/elements/reasoning.tsx`,
      `${dir}/elements/tool-group.aui.tsx`,
      `${dir}/elements/tooltip-icon-button.tsx`,
      `${dir}/hooks/use-copy-to-clipboard.ts`,
      `${dir}/styles.d.ts`,
    ]);
    expect(files.filter((path) => /\/(thread|tool-fallback)\b/.test(path))).toEqual([]);
  });
});
