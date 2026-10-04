import { type ReactElement, useCallback, useRef, useState } from "react";
import { NavLink } from "react-router";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AuthFooter } from "@/features/auth/index";
import { SidebarNavigateProvider, useSidebarSlotContent } from "@/lib/sidebar-slot";
import { cn } from "@/lib/utils";
import { BrandMark, Icon } from "@/ui/index";
import { routeManifest } from "../manifest";

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

/** 文档流变体（宽屏，可折叠）或覆盖层变体（窄屏，始终展开、选路由即关闭）。 */
type SidebarProps =
  | { variant?: "inline"; collapsed: boolean; onToggle: () => void }
  | { variant: "overlay"; onNavigate: () => void };

/**
 * 列表区：渲染页面经槽位上报的节点（目前只有会话页）。单独成组件，每次上报只重渲染这里而非
 * 整个侧栏；覆盖层把关闭回调经 context 交给列表。占据主导航与用户区之间的剩余高度，滚动由
 * 其中的列表自己承担。
 */
function SidebarListArea({
  onNavigate,
  overlay,
}: {
  onNavigate: (() => void) | undefined;
  overlay: boolean;
}) {
  const content = useSidebarSlotContent();
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", overlay ? "pt-2" : "px-3")}
      data-slot="sidebar-list"
    >
      <SidebarNavigateProvider onNavigate={onNavigate}>{content}</SidebarNavigateProvider>
    </div>
  );
}

/** 折叠态的导航项只剩图标，标签改由 Tooltip 显示（聚焦即显、悬停 300ms 后显）。 */
function CollapsedTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const LINK_CLASS =
  "flex items-center gap-2 rounded-lg text-sm leading-5 transition-colors hover:bg-sidebar-accent " +
  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold " +
  "[&_svg]:text-(--wb-icon-secondary) aria-[current=page]:[&_svg]:text-(--wb-icon-primary)";

function SidebarNav({
  collapsed,
  overlay,
  onNavigate,
}: {
  collapsed: boolean;
  overlay: boolean;
  onNavigate: (() => void) | undefined;
}) {
  return (
    <nav aria-label="主导航" className={cn(collapsed ? "px-1 py-2" : !overlay && "px-3 py-2")}>
      <ul className="flex flex-col gap-0.5">
        {routeManifest.map(({ icon, label, path, subtitle }) => {
          const link = (
            <NavLink
              {...(collapsed ? { "aria-label": label } : {})}
              className={cn(LINK_CLASS, collapsed ? "justify-center py-2" : "px-3 py-[5px]")}
              end
              onClick={onNavigate}
              to={path}
            >
              <Icon name={icon} size={16} />
              {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
              {collapsed || !subtitle ? null : (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {subtitle}
                </span>
              )}
            </NavLink>
          );
          return (
            <li key={path}>
              {collapsed ? <CollapsedTip label={label}>{link}</CollapsedTip> : link}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * 外壳侧栏：品牌区 + 折叠按钮、主导航、列表区、用户区（AuthFooter）。折叠态只渲染图标，
 * 链接的可访问名改由 aria-label 提供，并以 Tooltip 显示标签，且不渲染列表区。
 * 覆盖层变体不渲染品牌区（覆盖层头部已有标题与关闭），也从不读写折叠偏好。
 * 类 `sidebar` 与 `data-variant` 是会话页样式的挂点（覆盖层内列表的滚动方式），不可去掉。
 */
export function Sidebar(props: SidebarProps) {
  const overlay = props.variant === "overlay";
  const collapsed = props.variant === "overlay" ? false : props.collapsed;
  const onNavigate = props.variant === "overlay" ? props.onNavigate : undefined;
  return (
    <aside
      aria-label="侧栏"
      className={cn(
        "sidebar flex flex-col",
        overlay
          ? "min-h-full w-full"
          : "h-full shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-250 ease-out",
        !overlay && (collapsed ? "w-12" : "w-72"),
      )}
      data-collapsed={collapsed ? "true" : "false"}
      data-variant={props.variant ?? "inline"}
    >
      {props.variant === "overlay" ? null : (
        <div
          className={cn(
            "flex items-center",
            collapsed
              ? "flex-col justify-center gap-1 px-1 py-2"
              : "h-10 justify-between gap-2 pr-2 pl-3",
          )}
        >
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
      <TooltipProvider delayDuration={300} disableHoverableContent>
        <SidebarNav collapsed={collapsed} onNavigate={onNavigate} overlay={overlay} />
      </TooltipProvider>
      {collapsed ? null : <SidebarListArea onNavigate={onNavigate} overlay={overlay} />}
      <AuthFooter />
    </aside>
  );
}
