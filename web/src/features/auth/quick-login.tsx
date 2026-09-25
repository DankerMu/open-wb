import { Fragment, useEffect, useState } from "react";
import { createApiClient } from "../../lib/api.js";
import { DEV_ACCOUNTS, DEV_PASSWORD, DEV_STUB_PROVIDER } from "./dev-accounts.js";

const ADMIN_ROLE = "管理员";

type QuickLoginProps = {
  disabled: boolean;
  onPick: (account: string) => void;
};

/** 仅 dev-stub 下出现的演示账号快捷登录；info 读取匿名、每次 mount 一次、卸载即 abort，失败静默。 */
export function QuickLogin({ disabled, onPick }: QuickLoginProps) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    createApiClient()
      .getInfo({ signal: controller.signal })
      .then(
        (info) => {
          if (!controller.signal.aborted) {
            setAvailable(info.auth.provider === DEV_STUB_PROVIDER);
          }
        },
        // 失败、malformed、abort：不渲染、不重试、不报错。
        () => undefined,
      );
    return () => controller.abort();
  }, []);

  if (!available) {
    return null;
  }

  return (
    <>
      <p className="login-hint">
        演示账号：
        {DEV_ACCOUNTS.map(({ account, role }, index) => (
          <Fragment key={account}>
            {index > 0 ? " / " : null}
            <b>{account}</b>
            {role === ADMIN_ROLE ? `（${role}）` : null}
          </Fragment>
        ))}
        ，密码均为 <b>{DEV_PASSWORD}</b>
      </p>
      <ul aria-label="快捷登录" className="login-quick">
        {DEV_ACCOUNTS.map(({ account, role }) => (
          <li key={account}>
            <button
              className="login-quick-item"
              disabled={disabled}
              onClick={() => onPick(account)}
              type="button"
            >
              <span aria-hidden="true" className="login-quick-avatar">
                {account.slice(0, 1).toUpperCase()}
              </span>
              <span className="login-quick-copy">
                <span className="login-quick-account">{account}</span>{" "}
                <span className="login-quick-role">{role}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
