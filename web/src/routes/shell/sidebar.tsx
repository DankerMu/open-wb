import { useCallback, useRef, useState } from "react";
import { NavLink } from "react-router";
import { AuthFooter } from "../../features/auth/index.js";
import { SidebarNavigateProvider, useSidebarSlotContent } from "../../lib/sidebar-slot.js";
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

/** 文档流变体（宽屏，可折叠）或 Drawer 内的覆盖层变体（窄屏，始终展开、选路由即关闭）。 */
type SidebarProps =
  | { variant?: "inline"; collapsed: boolean; onToggle: () => void }
  | { variant: "overlay"; onNavigate: () => void };

/**
 * 列表区（demo:274 .sidebar-main）：渲染页面经槽位上报的节点（目前只有会话页）。单独成组件，
 * 每次上报只重渲染这里而非整个侧栏；覆盖层把关闭回调经 context 交给列表。
 */
function SidebarListArea({ onNavigate }: { onNavigate: (() => void) | undefined }) {
  const content = useSidebarSlotContent();
  return (
    <div className="sidebar-main">
      <SidebarNavigateProvider onNavigate={onNavigate}>{content}</SidebarNavigateProvider>
    </div>
  );
}

/**
 * 外壳侧栏：品牌区 + 折叠按钮、主导航、列表区、用户区（AuthFooter）。折叠态只渲染图标，
 * 链接的可访问名改由 aria-label 提供，并以 Tooltip 显示标签，且不渲染列表区（demo:241）。
 * 覆盖层变体不渲染品牌区（Drawer 头部已有标题与关闭），也从不读写折叠偏好。
 */
export function Sidebar(props: SidebarProps) {
  const collapsed = props.variant === "overlay" ? false : props.collapsed;
  const onNavigate = props.variant === "overlay" ? props.onNavigate : undefined;
  return (
    <aside
      aria-label="侧栏"
      className="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      data-variant={props.variant ?? "inline"}
    >
      {props.variant === "overlay" ? null : (
        <div className="sidebar-brand">
          <BrandMark size={24} wordmark={!collapsed} />
          <Button
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            onClick={props.onToggle}
            size="icon"
            variant="ghost"
          >
            <Icon name="panel-left" size={16} />
          </Button>
        </div>
      )}
      <nav aria-label="主导航" className="sidebar-nav">
        <ul>
          {routeManifest.map(({ icon, label, path, subtitle }) => {
            const link = (
              <NavLink
                {...(collapsed ? { "aria-label": label } : {})}
                className="sidebar-link"
                end
                onClick={onNavigate}
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
      {collapsed ? null : <SidebarListArea onNavigate={onNavigate} />}
      <AuthFooter />
    </aside>
  );
}
