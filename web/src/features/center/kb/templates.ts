import type { BaseView } from "@/lib/api";

type Template = BaseView["template"];

/**
 * 十一种切片模板的中文名与说明（knowledge-bases「中心「知识库」tab」；s2a-kb-ragflow D9，grill #31）。说明照搬 demo
 * 的 `kbMethods`，次序同 demo，没有 demo 里的 `tag`。键集由 `BaseView["template"]` 约束为恰好这十一种。只有显示
 * 文案：RAPTOR 与知识图谱对十一种模板都一样，没有编译支持表。
 */
const TEMPLATE_TEXT: Readonly<Record<Template, { label: string; description: string }>> = {
  naive: { label: "通用", description: "通用文本，按标题与段落切分" },
  qa: { label: "问答", description: "问答对，一问一答成块" },
  manual: { label: "手册", description: "手册规范，尊重章节与步骤" },
  paper: { label: "论文", description: "论文，摘要/方法/结论分块" },
  book: { label: "书籍", description: "长文档书籍" },
  laws: { label: "法规", description: "法规条文，按条款切分" },
  presentation: { label: "演示文稿", description: "演示文稿，按页切分" },
  table: { label: "表格", description: "表格，按行列结构解析" },
  one: { label: "整篇", description: "整篇文档作为一个块" },
  picture: { label: "图片", description: "图片，走 OCR 与版面识别" },
  email: { label: "邮件", description: "邮件，按往来切分" },
};

/** 新建对话框的选项，按显示次序。 */
export const TEMPLATES = Object.entries(TEMPLATE_TEXT).map(([key, text]) => ({
  key: key as Template,
  ...text,
}));

/** 模板的中文名。 */
export function templateLabel(key: Template): string {
  return TEMPLATE_TEXT[key].label;
}
