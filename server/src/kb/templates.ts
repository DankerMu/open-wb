/**
 * 十一种切片模板（s2a-kb-ragflow D9，grill #31；knowledge-bases「迁移 050 知识库 schema」）：本地存模板名，发给 RAGFlow 的
 * 是 `parser_id`，`naive` 发 `general`（§4.3），其余同名。`tag` 回 `102` 不可建，`audio` 要语音模型、编译未测成，都不在表里。
 *
 * 后缀抄自实测记录表 C 末列，全部小写。它取自各模板 pipeline 的 Parser 节点，不是逐个上传验证的；入库的后缀判定在
 * 组 10（D10），实际不一致时由上传的 `code:500` 兜底。
 */
interface Template {
  /** 建数据集的 `parser_id`。 */
  parserId: string;
  /** 这个模板管的后缀，不带点。 */
  suffixes: ReadonlySet<string>;
}

const SUFFIXES = [
  [
    "naive",
    "doc docx htm html md markdown mdx pdf xls xlsx csv txt py js java c cpp h php go ts sh cs kt sql",
  ],
  ["book", "doc docx htm html pdf txt"],
  ["email", "eml"],
  ["laws", "doc docx htm html md markdown mdx pdf txt"],
  ["manual", "doc docx pdf"],
  ["one", "doc docx htm html md markdown mdx pdf xls xlsx txt"],
  ["paper", "pdf"],
  [
    "picture",
    "bmp gif jpeg jpg png svg tif tiff webp 3gp 3gpp avi flv mkv mov mp4 mpeg mpg webm wmv",
  ],
  ["presentation", "pdf pptx ppt"],
  ["qa", "docx md markdown mdx pdf xls xlsx csv txt"],
  ["table", "xls xlsx csv txt"],
] as const;

const TEMPLATES: ReadonlyMap<string, Template> = new Map(
  SUFFIXES.map(([name, suffixes]) => [
    name,
    { parserId: name === "naive" ? "general" : name, suffixes: new Set(suffixes.split(" ")) },
  ]),
);

/** 不是这十一种之一时为 `undefined`。 */
export function templateOf(name: string): Template | undefined {
  return TEMPLATES.get(name);
}
