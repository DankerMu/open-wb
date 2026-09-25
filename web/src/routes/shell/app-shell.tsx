import { useCallback, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { TopbarProvider } from "../../lib/topbar.js";
import { SHELL_NARROW_QUERY, useMediaQuery } from "../../lib/viewport.js";
import { Drawer } from "../../ui/index.js";
import { Sidebar, useSidebarCollapsed } from "./sidebar.js";
import { Topbar } from "./topbar.js";

/**
 * 已认证外壳：侧栏 + 内容列（顶栏在 `main` 之外，页面经 Outlet 渲染进 `main`）。窄屏时侧栏不在
 * 文档流中，改由顶栏 `打开导航` 打开的 Drawer 覆盖层承载；覆盖层开合是瞬时状态，不碰折叠偏好。
 */
export function AppShell() {
  const [collapsed, toggle] = useSidebarCollapsed();
  const narrow = useMediaQuery(SHELL_NARROW_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  // 切回宽屏时复位，避免再次进入窄屏时覆盖层"复活"。
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);
  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  return (
    <TopbarProvider>
      <div className="app-shell">
        {narrow ? (
          <Drawer onOpenChange={setNavOpen} open={navOpen} side="left" title="导航" width={288}>
            <Sidebar onNavigate={closeNav} variant="overlay" />
          </Drawer>
        ) : (
          <Sidebar collapsed={collapsed} onToggle={toggle} />
        )}
        <div className="app-content">
          <Topbar onOpenNav={narrow ? openNav : undefined} />
          <main>
            <Outlet />
          </main>
        </div>
      </div>
    </TopbarProvider>
  );
}
