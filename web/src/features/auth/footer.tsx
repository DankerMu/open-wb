import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, Icon, Menu, type MenuItem } from "../../ui/index.js";
import { useAuth } from "./provider.js";

export function AuthFooter() {
  const { dismissLogoutError, logout, logoutError, logoutPending: pending, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const mountedRef = useRef(true);
  // 退出在途标志归 Provider；这里只守同 tick 的重复点击（第二次不得再调 logout）。
  const pendingRef = useRef(false);
  // 用户菜单触发按钮始终可用（pending 期间也不禁用），确认框关闭后焦点直接回到它。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItems = useMemo<readonly MenuItem[]>(
    () => [{ icon: "log-out", label: "退出登录", onSelect: () => setConfirming(true) }],
    [],
  );

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

  return (
    <footer className="sidebar-footer">
      <Menu
        items={menuItems}
        trigger={
          <button aria-label="用户菜单" className="sidebar-user" ref={triggerRef} type="button">
            <span aria-hidden="true" className="sidebar-avatar">
              {principal.account.slice(0, 1).toUpperCase()}
            </span>
            <span className="sidebar-user-copy">
              <span className="sidebar-user-account">{principal.account}</span>
              <span className="sidebar-user-role">{principal.role}</span>
            </span>
          </button>
        }
      />
      {logoutError ? (
        <p className="ui-alert sidebar-footer-note" role="alert">
          <span className="sidebar-footer-note-text">{logoutError}</span>
          <Button
            aria-label="关闭提示"
            onClick={() => {
              dismissLogoutError();
              // 按钮随提示卸载，焦点交给 用户菜单，不落回 body。
              triggerRef.current?.focus();
            }}
            size="icon"
            variant="ghost"
          >
            <Icon name="x" />
          </Button>
        </p>
      ) : null}
      {pending ? (
        <p className="ui-muted sidebar-footer-note" role="status">
          正在退出登录，可继续浏览或刷新确认登录状态。
        </p>
      ) : null}
      <ConfirmDialog
        cancelText={pending ? "关闭" : "取消"}
        confirmText="退出"
        danger
        description="退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。"
        onConfirm={() => {
          void confirmLogout();
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
        pending={pending}
        returnFocus={triggerRef}
        title="退出登录？"
      >
        {pending ? <p className="ui-muted">退出请求已发送，关闭窗口不会撤销请求。</p> : null}
      </ConfirmDialog>
    </footer>
  );
}
