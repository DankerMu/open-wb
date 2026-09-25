import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { BrandMark, Button, Icon, Input } from "../../ui/index.js";
import { useAuth } from "./provider.js";

export function LoginForm() {
  const { error, login } = useAuth();
  const [account, setAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const accountRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const accountId = useId();
  const passwordId = useId();
  const lockedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // 账号框 mount 即聚焦（不用 JSX 自动聚焦属性：biome a11y/noAutofocus）。
  useEffect(() => {
    accountRef.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lockedRef.current) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const submittedAccount = formData.get("account");
    const password = formData.get("password");
    if (typeof submittedAccount !== "string" || typeof password !== "string") {
      return;
    }

    lockedRef.current = true;
    setAccount(submittedAccount);
    setSubmitting(true);
    try {
      await login({ account: submittedAccount, password });
    } finally {
      if (mountedRef.current) {
        const passwordInput = passwordRef.current;
        if (passwordInput) {
          passwordInput.value = "";
        }
        lockedRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <main className="login-root">
      <div className="login-card">
        <div className="login-brand">
          <BrandMark size={26} wordmark />
        </div>
        <h1 className="login-title">登录 WorkBuddy</h1>
        <p className="login-sub">内网统一身份 · 本实例不出网</p>
        <form className="login-form" onSubmit={submit}>
          <div className="login-field">
            <label className="login-label" htmlFor={accountId}>
              账号
            </label>
            <Input
              autoComplete="username"
              id={accountId}
              name="account"
              onChange={(event) => setAccount(event.currentTarget.value)}
              placeholder="域账号，如 zhangsan"
              ref={accountRef}
              required
              value={account}
            />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor={passwordId}>
              密码
            </label>
            <Input
              autoComplete="current-password"
              id={passwordId}
              name="password"
              placeholder="密码"
              ref={passwordRef}
              required
              type="password"
            />
          </div>
          {error ? (
            <p className="login-err" role="alert">
              <Icon name="triangle-alert" size={12} />
              {error}
            </p>
          ) : null}
          <Button className="login-btn" disabled={submitting} type="submit" variant="primary">
            {submitting ? "正在登录" : "登录"}
          </Button>
        </form>
      </div>
    </main>
  );
}
