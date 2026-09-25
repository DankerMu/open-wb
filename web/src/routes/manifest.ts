import type { IconName } from "../ui/index.js";

// 路由清单单独成文件：router.tsx 与 shell/sidebar.tsx 都读它，放在 router.tsx 会形成循环导入。
export type RouteDefinition = {
  path: "/" | "/files" | "/center" | "/settings";
  icon: IconName;
  label: string;
  subtitle?: string;
  title: string;
  description: string;
};

export const routeManifest: readonly RouteDefinition[] = [
  {
    path: "/",
    icon: "message-square",
    label: "会话",
    title: "会话",
    description: "会话列表、消息与输入",
  },
  {
    path: "/files",
    icon: "folder",
    label: "工作空间",
    subtitle: "文件·预览",
    title: "工作空间",
    description: "浏览、预览与管理工作空间文件",
  },
  {
    path: "/center",
    icon: "layout-grid",
    label: "中心",
    title: "中心",
    description: "中心暂不可用",
  },
  {
    path: "/settings",
    icon: "settings",
    label: "设置",
    title: "设置",
    description: "主题与服务信息",
  },
];
