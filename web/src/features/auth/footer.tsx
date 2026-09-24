import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../ui/index.js";
import { useAuth } from "./provider.js";

export function AuthFooter() {
  const { logout, logoutError, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 关闭时刻（Radix onCloseAutoFocus）才读取：trigger 可用则回 trigger，pending 禁用时回侧栏当前页链接。
  const returnFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        const trigger = triggerRef.current;
        if (!trigger) return null;
        return trigger.disabled
          ? (trigger.closest("aside")?.querySelector<HTMLAnchorElement>("a[aria-current=page]") ??
              null)
          : trigger;
      },
    }),
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
    <footer className="account-footer">
      <div className="account-identity">
        <span aria-hidden="true" className="account-avatar">
          {principal.account.slice(0, 1).toUpperCase()}
        </span>
        <div className="account-copy">
          <p>{principal.account}</p>
          <p>{principal.role}</p>
        </div>
      </div>
      {logoutError ? (
        <p className="ui-alert" role="alert">
          {logoutError}
        </p>
      ) : null}
      <button
        className="ui-button"
        disabled={pending}
        onClick={() => setConfirming(true)}
        ref={triggerRef}
        type="button"
      >
        退出登录
      </button>
      {pending ? (
        <p className="ui-muted" role="status">
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
        returnFocus={returnFocus}
        title="退出登录？"
      >
        {pending ? <p className="ui-muted">退出请求已发送，关闭窗口不会撤销请求。</p> : null}
      </ConfirmDialog>
    </footer>
  );
}
