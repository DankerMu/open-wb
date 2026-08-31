import { useEffect, useRef, useState } from "react";
import { useAuth } from "./provider.js";

export function AuthFooter() {
  const { logout, logoutError, principal } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);

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
    <footer>
      <p>{principal.account}</p>
      <p>{principal.role}</p>
      {logoutError ? <p role="alert">{logoutError}</p> : null}
      <button disabled={pending} onClick={() => setConfirming(true)} type="button">
        退出登录
      </button>
      {confirming ? (
        <div
          aria-describedby="logout-description"
          aria-labelledby="logout-title"
          role="alertdialog"
        >
          <h2 id="logout-title">退出登录？</h2>
          <p id="logout-description">
            退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。
          </p>
          <button disabled={pending} onClick={() => setConfirming(false)} type="button">
            取消
          </button>
          <button disabled={pending} onClick={confirmLogout} type="button">
            退出
          </button>
        </div>
      ) : null}
    </footer>
  );
}
