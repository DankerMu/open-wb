import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Outlet } from "react-router";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarSlotProvider } from "@/lib/sidebar-slot";
import { TopbarProvider } from "@/lib/topbar";
import { cn } from "@/lib/utils";
import { SHELL_NARROW_QUERY, useMediaQuery } from "@/lib/viewport";
import { useEscapeFallback } from "@/ui/index";
import { Sidebar, useSidebarCollapsed } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * 覆盖层的焦点归还：没有 Trigger 的 Radix Dialog 关闭后焦点落到 body，这里在打开时记下打开者
 * （FocusScope 先派发事件、再移动焦点，此刻活动元素必是打开者），关闭时还给它。
 * `preventScroll`：归还不滚动任何容器。
 *
 * 初始焦点：拷入的 Sheet 把 `关闭` 按钮渲染在内容末尾，FocusScope 默认聚焦第一个可聚焦元素
 * （会话列表区的按钮或 `用户菜单`，随路由而变）；这里拦下默认行为，固定落在 `关闭` 上。
 */
function useOpenerFocus(content: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      opener.current = document.activeElement as HTMLElement | null;
      // 按 Sheet 自己的标记找关闭控件，不按文本：覆盖层里还有会话列表等用户可控的文本。
      const close = content.current?.querySelector<HTMLElement>('[data-slot="sheet-close"]');
      // 找不到就不拦，交还 FocusScope 的默认聚焦，焦点不至于留在覆盖层外。
      if (!close) return;
      event.preventDefault();
      close.focus({ preventScroll: true });
    },
    onCloseAutoFocus(event: Event) {
      event.preventDefault();
      opener.current?.focus({ preventScroll: true });
    },
  };
}

/**
 * 窄屏导航覆盖层：左侧 Sheet（对话框名 `导航`），内含始终展开的侧栏。Toast 占住 Radix 层栈时
 * Escape 由 `useEscapeFallback` 兜底关闭；主体整体滚动，矮视口不裁掉用户区。
 */
function NavOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  const focus = useOpenerFocus(fallback.ref);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-w-[92vw] gap-0 border-sidebar-border data-[side=left]:w-72"
        onCloseAutoFocus={focus.onCloseAutoFocus}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        onOpenAutoFocus={focus.onOpenAutoFocus}
        ref={fallback.ref}
        side="left"
      >
        <SheetHeader>
          <SheetTitle>导航</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-3">
          <Sidebar onNavigate={close} variant="overlay" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 已认证外壳：侧栏 + 内容列（顶栏在 `main` 之外，页面经 Outlet 渲染进 `main`）。窄屏时侧栏不在
 * 文档流中，改由顶栏 `打开导航` 打开的覆盖层承载；覆盖层开合是瞬时状态，不碰折叠偏好。
 * 侧栏列表区经 SidebarSlotProvider 由页面上报（槽位 state 在 Provider 内，不随上报重渲染本组件）。
 *
 * 主区布局契约（会话页、文件页依赖）：`main` 是纵向 flex 容器、`min-height: 0`，直接子元素撑满；
 * 宽屏 `overflow: hidden`（页面各自滚动），窄屏外壳与 `main` 放开为 `overflow: visible`、由 body 滚动。
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
  return (
    <TopbarProvider>
      <SidebarSlotProvider>
        <div
          className={cn(
            "flex min-h-dvh w-full",
            narrow ? "h-auto overflow-visible" : "h-full overflow-hidden",
          )}
        >
          {narrow ? (
            <NavOverlay onOpenChange={setNavOpen} open={navOpen} />
          ) : (
            <Sidebar collapsed={collapsed} onToggle={toggle} />
          )}
          <div className="flex min-h-0 min-w-0 flex-auto flex-col">
            <Topbar onOpenNav={narrow ? openNav : undefined} />
            <main
              className={cn(
                "flex min-h-0 min-w-0 flex-auto flex-col *:min-h-0 *:min-w-0 *:flex-auto",
                narrow ? "overflow-visible" : "overflow-hidden",
              )}
            >
              <Outlet />
            </main>
          </div>
        </div>
      </SidebarSlotProvider>
    </TopbarProvider>
  );
}
