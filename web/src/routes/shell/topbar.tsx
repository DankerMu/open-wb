import { useLocation } from "react-router";
import { type TopbarAction, useTopbarActions, useTopbarBreadcrumb } from "../../lib/topbar.js";
import { Button, Icon, Tooltip } from "../../ui/index.js";
import { routeManifest } from "../manifest.js";

type TopbarProps = {
  /** 窄屏时由外壳传入：顶栏最左渲染 `打开导航`（三态都有，欢迎态只含它）。 */
  onOpenNav?: (() => void) | undefined;
};

/**
 * 页面经 `useTopbar({ actions })` 注入的按钮，按数组顺序渲染；shell 不规定内容。按钮在 h1 之外，
 * 不进入 heading 的 accessible name；`expanded` 未提供时不带 `aria-expanded`。
 */
function TopbarActions({ actions }: { actions: readonly TopbarAction[] }) {
  return (
    <div className="topbar-actions">
      {actions.map((action) => (
        <Tooltip key={action.key} label={action.label}>
          <Button
            aria-expanded={action.expanded}
            aria-label={action.label}
            onClick={(event) => action.onSelect(event.currentTarget)}
            size="icon"
            variant="ghost"
          >
            <Icon name={action.icon} size={16} />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * 顶栏三态：`/` 无会话时宽屏不渲染、窄屏只渲染含 `打开导航` 的窄条；`/` 有会话显示面包屑
 * `我的工作 / <标题>`；其它路由显示页面标题。`打开导航` 恒为 header 首子节点，三态间只有标题槽
 * 变化，路由切换不重挂按钮（覆盖层关闭后焦点归还依赖它仍在文档中）。
 * 页面上报的 actions 只在有标题的两态渲染于 h1 之后，未上报时不渲染容器。
 * `<header>` 位于 `main` 之外即隐式 banner，故不写显式 role。
 */
export function Topbar({ onOpenNav }: TopbarProps) {
  const { pathname } = useLocation();
  const breadcrumb = useTopbarBreadcrumb();
  const actions = useTopbarActions();
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
      {title !== null && actions.length > 0 ? <TopbarActions actions={actions} /> : null}
    </header>
  );
}
