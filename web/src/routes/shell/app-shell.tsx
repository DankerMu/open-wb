import { Outlet } from "react-router";
import { TopbarProvider } from "../../lib/topbar.js";
import { Sidebar, useSidebarCollapsed } from "./sidebar.js";
import { Topbar } from "./topbar.js";

/** 已认证外壳：侧栏 + 内容列（顶栏在 `main` 之外，页面经 Outlet 渲染进 `main`）。 */
export function AppShell() {
  const [collapsed, toggle] = useSidebarCollapsed();
  return (
    <TopbarProvider>
      <div className="app-shell">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <div className="app-content">
          <Topbar />
          <main>
            <Outlet />
          </main>
        </div>
      </div>
    </TopbarProvider>
  );
}
