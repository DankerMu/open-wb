/* Static welcome content ported from resource/workbuddy-live-demo.html:1221-1239 (QUICK_PROMPTS, default 日常办公 scene), 2553-2561 (PLAYBOOKS), 2674 (card prompts). */
import type { IconName } from "../../ui/index.js";

export type WelcomePrompt = { label: string; icon: IconName; prompt: string };
export type Playbook = { title: string; desc: string; icon: IconName; prompt: string };

export const WELCOME_QUICK_PROMPTS: readonly WelcomePrompt[] = [
  { label: "文档处理", icon: "file-text", prompt: "把 Q3 经营数据做成 18 页分析 PPT" },
  { label: "内部汇报", icon: "zap", prompt: "汇总本季度部门进展并输出汇报材料" },
  {
    label: "数据分析及可视化",
    icon: "file-spreadsheet",
    prompt: "分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注",
  },
  { label: "资料归档", icon: "folder", prompt: "整理本地项目文档并建立分类索引" },
  { label: "幻灯片", icon: "file-chart-line", prompt: "帮我做一份项目评审 PPT 大纲" },
  { label: "产品需求", icon: "file-text", prompt: "帮我整理一份产品需求文档" },
];

export const PLAYBOOKS: readonly Playbook[] = [
  {
    title: "数据分析",
    desc: "清洗销售数据，生成周报与区域拆解看板",
    icon: "file-spreadsheet",
    prompt: "分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注",
  },
  {
    title: "内容创作",
    desc: "把经营数据做成 18 页分析 PPT",
    icon: "file-chart-line",
    prompt: "把 Q3 经营数据做成 18 页分析 PPT",
  },
  {
    title: "工程研发",
    desc: "重构模块并补齐回归测试",
    icon: "code",
    prompt: "帮我重构一个模块并补齐回归测试",
  },
  {
    title: "AI 应用",
    desc: "设计一个 Agent 应用的交互流程",
    icon: "sparkles",
    prompt: "帮我设计一个 Agent 应用的交互流程",
  },
  {
    title: "资料归档",
    desc: "整理本地项目文档并建立分类索引",
    icon: "search",
    prompt: "整理本地项目文档并建立分类索引",
  },
  {
    title: "视觉设计",
    desc: "为发布活动设计一张科技感海报",
    icon: "image",
    prompt: "帮我设计一张内部活动海报",
  },
  {
    title: "内部汇报",
    desc: "汇总部门进展并输出汇报材料",
    icon: "zap",
    prompt: "汇总本季度部门进展并输出汇报材料",
  },
];

export const PLAYBOOKS_SHOWN = 5;

/** Five playbooks starting at `start`, wrapping around the static set (demo:2563-2564). */
export function playbookWindow(start: number): readonly Playbook[] {
  const offset = start % PLAYBOOKS.length;
  return [...PLAYBOOKS.slice(offset), ...PLAYBOOKS.slice(0, offset)].slice(0, PLAYBOOKS_SHOWN);
}
