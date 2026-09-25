import { useLocation } from "react-router";
import { useTopbarBreadcrumb } from "../../lib/topbar.js";
import { routeManifest } from "../manifest.js";

/**
 * 顶栏三态：`/` 无会话不渲染；`/` 有会话显示面包屑 `我的工作 / <标题>`；其它路由显示页面标题。
 * `<header>` 位于 `main` 之外即隐式 banner，故不写显式 role。
 */
export function Topbar() {
  const { pathname } = useLocation();
  const breadcrumb = useTopbarBreadcrumb();
  const canonical =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const route = routeManifest.find((entry) => entry.path === canonical);
  if (!route) return null;
  if (route.path === "/") {
    if (breadcrumb === null) return null;
    return (
      <header className="topbar">
        <h1 className="topbar-title topbar-crumbs">
          <span className="topbar-crumb-root">我的工作</span> /{" "}
          <span className="topbar-crumb-current">{breadcrumb}</span>
        </h1>
      </header>
    );
  }
  return (
    <header className="topbar">
      <h1 className="topbar-title">{route.title}</h1>
    </header>
  );
}
