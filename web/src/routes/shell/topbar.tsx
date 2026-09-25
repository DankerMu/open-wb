import { useLocation } from "react-router";
import { useTopbarBreadcrumb } from "../../lib/topbar.js";
import { Button, Icon } from "../../ui/index.js";
import { routeManifest } from "../manifest.js";

type TopbarProps = {
  /** 窄屏时由外壳传入：顶栏最左渲染 `打开导航`（三态都有，欢迎态只含它）。 */
  onOpenNav?: (() => void) | undefined;
};

/**
 * 顶栏三态：`/` 无会话时宽屏不渲染、窄屏只渲染含 `打开导航` 的窄条；`/` 有会话显示面包屑
 * `我的工作 / <标题>`；其它路由显示页面标题。`打开导航` 恒为 header 首子节点，三态间只有标题槽
 * 变化，路由切换不重挂按钮（覆盖层关闭后焦点归还依赖它仍在文档中）。
 * `<header>` 位于 `main` 之外即隐式 banner，故不写显式 role。
 */
export function Topbar({ onOpenNav }: TopbarProps) {
  const { pathname } = useLocation();
  const breadcrumb = useTopbarBreadcrumb();
  const canonical =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const route = routeManifest.find((entry) => entry.path === canonical);
  if (!route) return null;
  if (route.path === "/" && breadcrumb === null && !onOpenNav) return null;
  const navButton = onOpenNav ? (
    <Button
      aria-label="打开导航"
      className="topbar-nav"
      onClick={onOpenNav}
      size="icon"
      variant="ghost"
    >
      <Icon name="menu" size={16} />
    </Button>
  ) : null;
  const crumbs =
    breadcrumb === null ? null : (
      <h1 className="topbar-title topbar-crumbs">
        <span className="topbar-crumb-root">我的工作</span> /{" "}
        <span className="topbar-crumb-current">{breadcrumb}</span>
      </h1>
    );
  const title = route.path === "/" ? crumbs : <h1 className="topbar-title">{route.title}</h1>;
  return (
    <header className="topbar">
      {navButton}
      {title}
    </header>
  );
}
