import { useCallback, useRef, useState } from "react";
import { NavLink } from "react-router";
import { AuthFooter } from "../../features/auth/index.js";
import { BrandMark, Button, Icon, Tooltip } from "../../ui/index.js";
import { routeManifest } from "../manifest.js";

const STORAGE_KEY = "workbuddy-sidebar";

// 读失败（隐私模式、存储被禁用）按展开处理；值不合法同样按展开。
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // 写失败静默，内存状态已更新。
  }
}

/**
 * 侧栏折叠状态：初值读 localStorage，toggle 时写回。写入放在回调而非 updater 或 effect 里：
 * updater 在 StrictMode 下会双调，effect 会在挂载时多写一次；collapsedRef 与 state 同步推进。
 */
export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const collapsedRef = useRef(collapsed);
  const toggle = useCallback(() => {
    const next = !collapsedRef.current;
    collapsedRef.current = next;
    setCollapsed(next);
    writeCollapsed(next);
  }, []);
  return [collapsed, toggle] as const;
}

type SidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
};

/**
 * 外壳侧栏：品牌区 + 折叠按钮、主导航、用户区（AuthFooter）。折叠态只渲染图标，
 * 链接的可访问名改由 aria-label 提供，并以 Tooltip 显示标签。
 */
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside aria-label="侧栏" className="sidebar" data-collapsed={collapsed ? "true" : "false"}>
      <div className="sidebar-brand">
        <BrandMark size={24} wordmark={!collapsed} />
        <Button
          aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={onToggle}
          size="icon"
          variant="ghost"
        >
          <Icon name="panel-left" size={16} />
        </Button>
      </div>
      <nav aria-label="主导航">
        <ul>
          {routeManifest.map(({ icon, label, path, subtitle }) => {
            const link = (
              <NavLink
                {...(collapsed ? { "aria-label": label } : {})}
                className="sidebar-link"
                end
                to={path}
              >
                <Icon name={icon} size={16} />
                {collapsed ? null : <span className="sidebar-link-label">{label}</span>}
                {collapsed || !subtitle ? null : (
                  <span className="sidebar-link-sub">{subtitle}</span>
                )}
              </NavLink>
            );
            return (
              <li key={path}>
                {collapsed ? (
                  <Tooltip label={label} side="right">
                    {link}
                  </Tooltip>
                ) : (
                  link
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <AuthFooter />
    </aside>
  );
}
