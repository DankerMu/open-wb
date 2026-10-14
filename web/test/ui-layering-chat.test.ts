import { describe, expect, it } from "vitest";
import { CHAT_DIR, COPIED_DIRS, isUnder, type SourceFile } from "./ui-layering-support.js";
import { listRepoFiles, readRepoFile } from "./ui-support.js";

const SESSION_FILTER = `${CHAT_DIR}/session-filter.tsx`;

/**
 * 会话页迁移终态（纯函数）：`CHAT_DIR` 下（含子目录）不得有 `.css`，也不得有 `session-filter.tsx`。
 * 逐文件登记的已迁移清单已随旧基元层退役，这里不再对源文件记账。
 */
function chatEndStateViolations(paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (path.endsWith(".css")) return [`${path}: 会话页目录不得有 .css`];
    return path === SESSION_FILTER ? [`${path}: 会话页不得再有 session-filter.tsx`] : [];
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

  it('web/src 现状：除两个拷入目录之外的全部 .tsx 里带 list-none 的开标签都带 role="list"', () => {
    const paths = listRepoFiles("web/src", (file) => file.endsWith(".tsx")).filter(
      (file) => !COPIED_DIRS.some((dir) => isUnder(file, dir)),
    );
    // 范围是整个应用层，不是某份清单：会话页之外的目录也在扫描对象里，拷入层不在。
    expect(paths).toEqual(
      expect.arrayContaining(["web/src/main.tsx", "web/src/features/files/tree.tsx"]),
    );
    expect(paths.filter((file) => COPIED_DIRS.some((dir) => file.startsWith(dir)))).toEqual([]);
    const files = paths.map((file) => ({ path: file, text: readRepoFile(file) }));
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

  it("判定自证：目录下的 .css（含 chat.css 与子目录里的）、session-filter.tsx 各判失败，源文件不必登记", () => {
    const paths = ["page.tsx", "session-menu.tsx", "stream.ts", "extra.ts"].map(
      (name) => `${CHAT_DIR}/${name}`,
    );
    expect(chatEndStateViolations(paths)).toEqual([]);
    expect(chatEndStateViolations([`${CHAT_DIR}/parts/session-menu.tsx`])).toEqual([]);
    for (const css of [
      `${CHAT_DIR}/chat.css`,
      `${CHAT_DIR}/messages.css`,
      `${CHAT_DIR}/parts/x.css`,
    ]) {
      expect(chatEndStateViolations([...paths, css])).toEqual([`${css}: 会话页目录不得有 .css`]);
    }
    expect(chatEndStateViolations([...paths, SESSION_FILTER])).toEqual([
      `${SESSION_FILTER}: 会话页不得再有 session-filter.tsx`,
    ]);
    // 只认路径全等：名字相近的文件、别处的同名文件不归这条管。
    expect(
      chatEndStateViolations([
        `${CHAT_DIR}/session-filter.ts`,
        "web/src/features/files/session-filter.tsx",
      ]),
    ).toEqual([]);
  });

  it("web/src/features/chat 现状：没有 .css 与 session-filter.tsx，theme.css 不提会话页", () => {
    const paths = chatPaths();
    // 扫描没有放空：目录枚举坏掉（空表）时下面的「没有」不能悄悄通过。
    expect(paths).toContain(`${CHAT_DIR}/page.tsx`);
    expect(paths.filter((path) => path.endsWith(".css"))).toEqual([]);
    expect(paths).not.toContain(SESSION_FILTER);
    expect(chatEndStateViolations(paths)).toEqual([]);
    // 全局样式现在只在 theme.css：读到的确是那份文件（含 base 块的 `.ui-alert`），其中不导入、不提会话页。
    const theme = readRepoFile("web/src/styles/theme.css");
    expect(theme).toContain("  .ui-alert {");
    expect(theme).not.toContain("features/chat");
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
