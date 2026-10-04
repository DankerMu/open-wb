import { describe, expect, it } from "vitest";
import { readRepoFile } from "./ui-support";

/**
 * 功能验收清单的格式守卫（functional-acceptance「行格式可判定」）。
 * 判定写成对文本的纯函数：仓库文件此刻没有数据行，「合法行通过 / 各类违例被拒」只能靠注入样本自证。
 */

const CHECKLIST = "docs/acceptance/functional-checklist.md";
const REQUIRED_SECTIONS = ["登录", "外壳", "会话", "文件", "设置"];

const TABLE_HEADER = "| ID | 操作 | 期望 | 结论 |";
const TABLE_SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|){4}$/;
/** 页面节标题：`## 名称（前缀）`，前缀为两个以上大写字母。 */
const PAGE_HEADING = /^## (.+)（([A-Z]{2,})）$/;
const ID_PATTERN = /^[A-Z]{2,}-\d{2,}$/;
/** 全角冒号，说明非空。 */
const VERDICT_PATTERN = /^(待签|通过|不通过：\S.*)$/;
const DEMO_REF = /demo:/i;
/** `<数字>px`：`12px`、`0.5px`、`12 px`；`px` 后接字母（如单词的一部分）不算。 */
const PIXEL_VALUE = /\d\s?px(?![A-Za-z])/i;
/**
 * `.`/`#` 前缀的 CSS 选择器：记号出现在单元格开头，或紧跟空白、反引号、引号、括号、顿号/逗号之后，
 * 且 `.`/`#` 后是字母、下划线或连字符。于是 `/settings`、`/files#top`、`#643`、`0.5`、`styles.css`、`*.md`
 * 都不算（前一个字符是字母/数字/`*`，或后一个字符是数字）；裸写的 `.md` 与 `.btn` 无法从字面区分，一律按选择器拒绝，
 * 清单文件头要求扩展名写成 `*.md` 或完整文件名。
 */
const CSS_SELECTOR = /(?:^|[\s`'"“”‘’(（[【、，,：:])[.#][A-Za-z_-][\w-]*/;

type Section = { name: string; prefix: string | null; tableLines: number };

/** 按未转义的 `|` 切行；首尾必须是 `|`，否则返回 null。单元格内的竖线写成 `\|`。 */
function splitRow(line: string): string[] | null {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts.length < 3 || parts[0] !== "" || parts.at(-1) !== "") return null;
  return parts.slice(1, -1).map((cell) => cell.trim());
}

function cellErrors(label: string, column: string, cell: string): string[] {
  const errors: string[] = [];
  if (cell === "") errors.push(`${label}：「${column}」为空`);
  if (PIXEL_VALUE.test(cell)) errors.push(`${label}：「${column}」含像素值`);
  if (CSS_SELECTOR.test(cell)) errors.push(`${label}：「${column}」含 ./# 前缀的选择器`);
  return errors;
}

function rowErrors(line: string, label: string, section: Section, seen: Set<string>): string[] {
  const cells = splitRow(line);
  if (cells === null || cells.length !== 4) return [`${label}：不是恰好四列`];
  const [id = "", action = "", expected = "", verdict = ""] = cells;
  const errors: string[] = [];
  if (!ID_PATTERN.test(id)) errors.push(`${label}：ID「${id}」不是「前缀-序号」`);
  else if (!id.startsWith(`${section.prefix}-`))
    errors.push(`${label}：ID「${id}」不用本节前缀 ${section.prefix}`);
  if (seen.has(id)) errors.push(`${label}：ID「${id}」重复`);
  seen.add(id);
  errors.push(...cellErrors(label, "操作", action), ...cellErrors(label, "期望", expected));
  if (!VERDICT_PATTERN.test(verdict)) errors.push(`${label}：结论「${verdict}」不在三种取值内`);
  return errors;
}

/** 表格行在其所在节内的次序：第 1 行是表头，第 2 行是分隔行，其后是数据行。 */
function tableLineErrors(
  line: string,
  label: string,
  section: Section | null,
  seen: Set<string>,
): string[] {
  if (section === null || section.prefix === null) return [`${label}：表格不在页面节内`];
  section.tableLines += 1;
  if (section.tableLines === 1)
    return line.trim() === TABLE_HEADER ? [] : [`${label}：表头不是「${TABLE_HEADER}」`];
  if (section.tableLines === 2)
    return TABLE_SEPARATOR.test(line.trim()) ? [] : [`${label}：表头下缺分隔行`];
  return rowErrors(line, label, section, seen);
}

function sectionErrors(sections: Section[]): string[] {
  const pages = sections.filter((section) => section.prefix !== null);
  const errors = REQUIRED_SECTIONS.filter(
    (name) => !pages.some((section) => section.name === name),
  ).map((name) => `缺少页面节「${name}」`);
  for (const section of pages) {
    if (section.tableLines < 2) errors.push(`页面节「${section.name}」缺表头`);
    if (pages.filter((other) => other.prefix === section.prefix).length > 1)
      errors.push(`页面节「${section.name}」的前缀 ${section.prefix} 与其它节重复`);
  }
  return errors;
}

/** 返回全部格式违例（空数组即通过）。 */
function checklistErrors(text: string): string[] {
  const errors: string[] = [];
  const sections: Section[] = [];
  const seen = new Set<string>();
  let current: Section | null = null;
  text.split("\n").forEach((line, index) => {
    const label = `第 ${index + 1} 行`;
    if (DEMO_REF.test(line)) errors.push(`${label}：含 demo 行号引用`);
    if (line.startsWith("## ")) {
      const heading = PAGE_HEADING.exec(line.trim());
      current = { name: heading?.[1] ?? line, prefix: heading?.[2] ?? null, tableLines: 0 };
      sections.push(current);
    } else if (line.trimStart().startsWith("|")) {
      errors.push(...tableLineErrors(line, label, current, seen));
    }
  });
  return [...errors, ...sectionErrors(sections)];
}

/** 文件头：第一个页面节之前的全部文字。 */
function preamble(text: string): string {
  const first = text.split("\n").findIndex((line) => PAGE_HEADING.test(line.trim()));
  return text
    .split("\n")
    .slice(0, first < 0 ? undefined : first)
    .join("\n");
}

const SECTION_PREFIX: Record<string, string> = {
  登录: "LG",
  外壳: "SH",
  会话: "CH",
  文件: "FL",
  设置: "ST",
};

/** 五节骨架；`rows` 按节名注入数据行。 */
function sample(rows: Record<string, string[]> = {}, head = "# 功能验收清单"): string {
  const sections = REQUIRED_SECTIONS.map((name) =>
    [
      `## ${name}（${SECTION_PREFIX[name]}）`,
      "",
      TABLE_HEADER,
      "|---|---|---|---|",
      ...(rows[name] ?? []),
    ].join("\n"),
  );
  return `${[head, ...sections].join("\n\n")}\n`;
}

const row = (id: string, action: string, expected: string, verdict = "待签") =>
  `| ${id} | ${action} | ${expected} | ${verdict} |`;

/** 只在「外壳」节放这些行时的违例。 */
const shellErrors = (...rows: string[]) => checklistErrors(sample({ 外壳: rows }));

describe("功能验收清单格式（functional-acceptance「行格式可判定」）", () => {
  it("仓库文件：五个页面节齐全，全部行合规", () => {
    expect(checklistErrors(readRepoFile(CHECKLIST))).toEqual([]);
  });

  it("仓库文件头写明运行方式、三种结论与签收规则", () => {
    const head = preamble(readRepoFile(CHECKLIST));
    for (const phrase of [
      "## 运行方式",
      "由调用方启动的真实服务",
      "不依赖截图对比",
      "`待签`、`通过`、`不通过：<说明>`",
      "## 签收规则",
      "只有仓库所有者本人",
      "agent 不得代签",
      "Epic 在其新增行仍有 `待签` 时不关闭",
      "关联一个修复 issue",
    ]) {
      expect(head, phrase).toContain(phrase);
    }
  });

  it("自证：空骨架与带合法行的样本通过", () => {
    expect(checklistErrors(sample())).toEqual([]);
    expect(
      checklistErrors(
        sample({
          登录: [row("LG-01", "输入正确的账号密码后点「登录」", "进入会话页，地址栏为 `/`")],
          外壳: [
            row("SH-01", "点击侧栏底部的「设置」", "进入 `/settings`，标题为「设置」", "通过"),
            row("SH-02", "按 Esc", "菜单关闭，焦点回到触发按钮", "不通过：见 #643"),
            row("SH-10", "把窗口拖窄到手机宽度", "侧栏收起为抽屉"),
          ],
          文件: [row("FL-01", "上传 `notes.md`", "列表出现 notes.md，大小显示为 0.5 KB")],
        }),
      ),
    ).toEqual([]);
  });

  it("自证：重复 ID 被拒（同节与跨节）", () => {
    expect(shellErrors(row("SH-01", "点击甲", "看到乙"), row("SH-01", "点击丙", "看到丁"))).toEqual(
      ["第 13 行：ID「SH-01」重复"],
    );
    const crossed = checklistErrors(
      sample({
        登录: [row("LG-01", "点击甲", "看到乙")],
        外壳: [row("LG-01", "点击丙", "看到丁")],
      }),
    );
    expect(crossed).toContain("第 13 行：ID「LG-01」重复");
  });

  it("自证：ID 须为「前缀-序号」且用本节前缀", () => {
    for (const id of ["SH-1", "sh-01", "SH01", "S-01", "SH-01a", ""]) {
      expect(shellErrors(row(id, "点击甲", "看到乙")), id).toEqual([
        `第 12 行：ID「${id}」不是「前缀-序号」`,
      ]);
    }
    expect(shellErrors(row("ST-01", "点击甲", "看到乙"))).toEqual([
      "第 12 行：ID「ST-01」不用本节前缀 SH",
    ]);
  });

  it("自证：结论只取三种值，「不通过」须带全角冒号与非空说明", () => {
    for (const verdict of ["待签", "通过", "不通过：按钮无响应，见 #900"]) {
      expect(shellErrors(row("SH-01", "点击甲", "看到乙", verdict)), verdict).toEqual([]);
    }
    for (const verdict of [
      "暂缓",
      "已通过",
      "不通过",
      "不通过：",
      "不通过： ",
      "不通过:原因",
      "",
    ]) {
      expect(shellErrors(row("SH-01", "点击甲", "看到乙", verdict)), verdict).toEqual([
        `第 12 行：结论「${verdict.trim()}」不在三种取值内`,
      ]);
    }
  });

  it("自证：demo 行号引用在全文任何位置都被拒", () => {
    expect(shellErrors(row("SH-01", "点击甲", "与 demo:123 一致"))).toEqual([
      "第 12 行：含 demo 行号引用",
    ]);
    expect(checklistErrors(sample({}, "# 功能验收清单\n\n参照 demo:4567 的布局。"))).toEqual([
      "第 3 行：含 demo 行号引用",
    ]);
    expect(checklistErrors(sample({}, "# 功能验收清单\n\n取代 demo-parity 清单。"))).toEqual([]);
  });

  it("自证：数据行须恰好四列", () => {
    for (const line of [
      "| SH-01 | 点击甲 | 待签 |",
      "| SH-01 | 点击甲 | 看到乙 | 备注 | 待签 |",
      "| SH-01 | 输入 a|b | 看到乙 | 待签 |",
      "| SH-01 | 点击甲 | 看到乙 | 待签",
    ]) {
      expect(shellErrors(line), line).toEqual(["第 12 行：不是恰好四列"]);
    }
    expect(shellErrors(row("SH-01", "输入 a\\|b", "看到乙"))).toEqual([]);
    expect(shellErrors(row("SH-01", "", "看到乙"))).toEqual(["第 12 行：「操作」为空"]);
  });

  it("自证：操作/期望里的像素值被拒，不带单位的数字不受限", () => {
    for (const cell of ["间距为 12px", "宽 0.5px 的描边", "高度 48 px", "`240PX` 宽"]) {
      expect(shellErrors(row("SH-01", cell, "看到乙")), cell).toEqual([
        "第 12 行：「操作」含像素值",
      ]);
      expect(shellErrors(row("SH-01", "点击甲", cell)), cell).toEqual([
        "第 12 行：「期望」含像素值",
      ]);
    }
    for (const cell of ["列表显示 12 条", "透明度 0.5", "标题为「3pxl 相机」", "等待 2 秒"]) {
      expect(shellErrors(row("SH-01", "点击甲", cell)), cell).toEqual([]);
    }
  });

  it("自证：操作/期望里 ./# 前缀的选择器被拒", () => {
    for (const cell of [
      ".ui-btn 可点击",
      "点击 .sidebar-item",
      "点击 `#root` 内的按钮",
      "按钮（.primary）高亮",
      "容器为 #app",
      "焦点落在“.menu-trigger”",
      "裸写扩展名 .md",
    ]) {
      expect(shellErrors(row("SH-01", cell, "看到乙")), cell).toEqual([
        "第 12 行：「操作」含 ./# 前缀的选择器",
      ]);
      expect(shellErrors(row("SH-01", "点击甲", cell)), cell).toEqual([
        "第 12 行：「期望」含 ./# 前缀的选择器",
      ]);
    }
  });

  it("自证：路由、URL 片段、issue 编号、小数与文件名不算选择器", () => {
    for (const cell of [
      "进入 `/settings`",
      "地址栏为 /files#readme",
      "打开 http://127.0.0.1:3000/#/chat",
      "修复见 #643",
      "列表显示 0.5 MB",
      "打开 styles.css",
      "只列出 `*.md` 与 a.b.txt",
      "文件名为 .5 开头的不显示",
      "提示以句号结尾。再点一次",
      "显示省略号...后截断",
    ]) {
      expect(shellErrors(row("SH-01", cell, cell)), cell).toEqual([]);
    }
  });

  it("自证：表格结构——表头、分隔行、节归属、必备节与前缀唯一", () => {
    const base = sample();
    expect(checklistErrors(base.replace(TABLE_HEADER, "| ID | 操作 | 期望 | 状态 |"))).toEqual([
      `第 5 行：表头不是「${TABLE_HEADER}」`,
    ]);
    expect(checklistErrors(base.replace("|---|---|---|---|", "|---|---|---|"))).toEqual([
      "第 6 行：表头下缺分隔行",
    ]);
    expect(checklistErrors(base.replace("## 设置（ST）", "## 设置"))).toEqual([
      "第 25 行：表格不在页面节内",
      "第 26 行：表格不在页面节内",
      "缺少页面节「设置」",
    ]);
    expect(checklistErrors(base.replace("## 设置（ST）", "## 设置（SH）"))).toEqual([
      "页面节「外壳」的前缀 SH 与其它节重复",
      "页面节「设置」的前缀 SH 与其它节重复",
    ]);
    expect(checklistErrors(`${base}\n## 知识库（KB）\n`)).toEqual(["页面节「知识库」缺表头"]);
    expect(
      checklistErrors(`# 功能验收清单\n\n${row("SH-01", "点击甲", "看到乙")}\n\n${base}`),
    ).toEqual(["第 3 行：表格不在页面节内"]);
    const extra = `${base}\n## 知识库（KB）\n\n${TABLE_HEADER}\n|---|---|---|---|\n${row("KB-01", "点击甲", "看到乙")}\n`;
    expect(checklistErrors(extra)).toEqual([]);
  });
});
