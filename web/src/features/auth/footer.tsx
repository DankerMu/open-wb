import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Menu, type MenuItem } from "../../ui/index.js";
import { useAuth } from "./provider.js";

export function AuthFooter() {
  const { logout, logoutError, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
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

  if (!principal) {
    return null;
  }

  async function confirmLogout() {
    if (pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    setPending(true);
    try {
      const succeeded = await logout();
      if (!succeeded && mountedRef.current) {
        setConfirming(false);
        setPending(false);
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
          {logoutError}
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
