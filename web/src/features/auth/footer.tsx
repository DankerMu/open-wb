import { LoaderCircle } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, useEscapeFallback } from "@/ui/index";
import { useAuth } from "./provider";

/**
 * 忙碌上升沿的焦点救回：`pending` 由 false 变 true 的那次提交之后，若活动元素是确认框内已禁用的
 * 控件（jsdom 与延后 fixup 的环境：被禁用的 `退出` 仍持有焦点），或已被浏览器 focus fixup 到 body
 * （Chromium 在设置 `disabled` 的当下同步移走焦点），把焦点移到取消按钮。活动元素是确认框内可用
 * 控件、或在确认框外的其它元素时不动；`pending` 保持为 true 的后续渲染、以 `pending=true` 挂载都不触发。
 * 用 layout effect：与禁用同一次 commit，在绘制与下一次按键之前完成，焦点不会经键盘逃到背景。
 */
function usePendingFocusRescue(
  content: RefObject<HTMLElement | null>,
  cancel: RefObject<HTMLElement | null>,
  pending: boolean,
) {
  const wasPending = useRef(pending);
  useLayoutEffect(() => {
    const rising = pending && !wasPending.current;
    wasPending.current = pending;
    if (!rising) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      cancel.current?.focus();
      return;
    }
    const disabledInside =
      content.current?.contains(active) === true && (active as HTMLButtonElement).disabled === true;
    if (disabledInside) cancel.current?.focus();
  }, [pending, content, cancel]);
}

/** 悬浮形态：折叠态侧栏的用户区只有图标列宽，提示改为贴侧栏右侧浮出（`fixed` 脱离侧栏的裁剪）。 */
const NOTE_CLASS =
  "rounded-lg in-data-[collapsed=true]:fixed in-data-[collapsed=true]:bottom-4 in-data-[collapsed=true]:left-14 " +
  "in-data-[collapsed=true]:z-10 in-data-[collapsed=true]:w-60 in-data-[collapsed=true]:bg-card " +
  "in-data-[collapsed=true]:shadow-(--wb-shadow-popover)";

/**
 * 侧栏用户区：头像 + 账号/角色整块为 `用户菜单` 触发按钮，菜单只有 `退出登录`；退出先经确认框。
 * 退出在途标志与失败信息归 AuthProvider，故覆盖层关闭（本组件卸载）再重开不丢锁定态。
 */
export function AuthFooter() {
  const { dismissLogoutError, logout, logoutError, logoutPending: pending, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const mountedRef = useRef(true);
  // 退出在途标志归 Provider；这里只守同 tick 的重复点击（第二次不得再调 logout）。
  const pendingRef = useRef(false);
  // 用户菜单触发按钮始终可用（pending 期间也不禁用），确认框关闭后焦点直接回到它。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeConfirm = (open: boolean) => {
    if (!open) setConfirming(false);
  };
  // Toast 占住 Radix 层栈时确认框收不到 Escape，由兜底关闭（Escape 即取消）。
  const fallback = useEscapeFallback({ canClose: true, onOpenChange: closeConfirm });
  usePendingFocusRescue(fallback.ref, cancelRef, pending);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 失败即关确认框、露出错误；不依赖发起请求的实例仍挂载（窄屏覆盖层关闭即卸载用户区）。
  useEffect(() => {
    if (logoutError) setConfirming(false);
  }, [logoutError]);

  if (!principal) {
    return null;
  }

  async function confirmLogout() {
    if (pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    try {
      const succeeded = await logout();
      if (!succeeded && mountedRef.current) {
        setConfirming(false);
      }
    } finally {
      pendingRef.current = false;
    }
  }

  /**
   * 确认框由菜单项打开，没有 Radix Trigger，关闭后焦点默认落到 body：归还给 `用户菜单`；
   * 它不可用（被禁用）时退到侧栏里当前路由的导航链接。
   */
  function returnFocus(event: Event) {
    event.preventDefault();
    const trigger = triggerRef.current;
    const target =
      trigger && !trigger.disabled
        ? trigger
        : trigger?.closest("aside")?.querySelector<HTMLElement>('a[aria-current="page"]');
    target?.focus({ preventScroll: true });
  }

  return (
    <footer className="mt-auto flex flex-col gap-2 border-t border-sidebar-border p-3 in-data-[collapsed=true]:items-center in-data-[collapsed=true]:px-1 in-data-[variant=overlay]:px-0">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="用户菜单"
            className="flex w-full items-center gap-2 rounded-[10px] px-1 py-0.5 text-left hover:bg-sidebar-accent in-data-[collapsed=true]:justify-center in-data-[collapsed=true]:px-0"
            ref={triggerRef}
            type="button"
          >
            <span
              aria-hidden="true"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-(--wb-brand-primary) text-xs font-bold text-(--wb-bg-primary)"
            >
              {principal.account.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col in-data-[collapsed=true]:hidden">
              <span
                className="truncate text-[13px] leading-[18px] font-semibold"
                data-slot="sidebar-user-account"
              >
                {principal.account}
              </span>
              <span className="text-[11px] leading-[14px] text-muted-foreground">
                {principal.role}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={8} loop side="top" sideOffset={6}>
          <DropdownMenuItem onSelect={() => setConfirming(true)}>
            <Icon name="log-out" size={14} />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {logoutError ? (
        <div className={NOTE_CLASS}>
          <p
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
            role="alert"
          >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{logoutError}</span>
            <Button
              aria-label="关闭提示"
              className="text-inherit"
              onClick={() => {
                dismissLogoutError();
                // 按钮随提示卸载，焦点交给 用户菜单，不落回 body。
                triggerRef.current?.focus();
              }}
              size="icon-xs"
              variant="ghost"
            >
              <Icon name="x" />
            </Button>
          </p>
        </div>
      ) : null}
      {pending ? (
        <p
          className={`${NOTE_CLASS} text-[13px] text-muted-foreground in-data-[collapsed=true]:border in-data-[collapsed=true]:border-sidebar-border in-data-[collapsed=true]:px-2.5 in-data-[collapsed=true]:py-2`}
          role="status"
        >
          正在退出登录，可继续浏览或刷新确认登录状态。
        </p>
      ) : null}
      <AlertDialog onOpenChange={closeConfirm} open={confirming}>
        <AlertDialogContent
          aria-modal="true"
          onCloseAutoFocus={returnFocus}
          onEscapeKeyDown={fallback.onEscapeKeyDown}
          onKeyDown={fallback.onKeyDown}
          ref={fallback.ref}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>退出登录？</AlertDialogTitle>
            <AlertDialogDescription>
              退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <p className="text-sm text-muted-foreground">退出请求已发送，关闭窗口不会撤销请求。</p>
          ) : null}
          <AlertDialogFooter className="border-border">
            <AlertDialogCancel ref={cancelRef}>{pending ? "关闭" : "取消"}</AlertDialogCancel>
            <Button
              aria-busy={pending ? true : undefined}
              disabled={pending}
              onClick={() => {
                void confirmLogout();
              }}
              variant="destructive"
            >
              {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
              退出
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </footer>
  );
}
