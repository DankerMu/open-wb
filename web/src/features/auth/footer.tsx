import { useEffect, useRef, useState } from "react";
import { trapDialogFocus } from "../../lib/dialog.js";
import { useAuth } from "./provider.js";

export function AuthFooter() {
  const { logout, logoutError, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!confirming || !dialog) {
      return;
    }

    dialog.showModal();
    cancelRef.current?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
      if (mountedRef.current) {
        const trigger = triggerRef.current;
        if (trigger?.disabled) {
          trigger
            .closest("aside")
            ?.querySelector<HTMLAnchorElement>("a[aria-current=page]")
            ?.focus();
        } else {
          trigger?.focus();
        }
      }
    };
  }, [confirming]);

  if (!principal) {
    return null;
  }

  function dismissConfirm() {
    setConfirming(false);
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
      {confirming ? (
        <dialog
          aria-describedby="logout-description"
          aria-labelledby="logout-title"
          onKeyDown={trapDialogFocus}
          className="logout-dialog"
          onCancel={(event) => {
            event.preventDefault();
            dismissConfirm();
          }}
          ref={dialogRef}
          role="alertdialog"
        >
          <h2 id="logout-title">退出登录？</h2>
          <p id="logout-description">
            退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。
          </p>
          {pending ? <p className="ui-muted">退出请求已发送，关闭窗口不会撤销请求。</p> : null}
          <div className="logout-dialog-actions">
            <button className="ui-button" onClick={dismissConfirm} ref={cancelRef} type="button">
              {pending ? "关闭" : "取消"}
            </button>
            <button
              className="ui-button ui-button-danger"
              disabled={pending}
              onClick={confirmLogout}
              type="button"
            >
              退出
            </button>
          </div>
        </dialog>
      ) : null}
    </footer>
  );
}
