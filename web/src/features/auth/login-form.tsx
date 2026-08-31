import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "./provider.js";

export function LoginForm() {
  const { error, login } = useAuth();
  const [account, setAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const lockedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

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
    <main>
      <h1>登录 WorkBuddy</h1>
      <form onSubmit={submit}>
        <p>
          <label>
            账号
            <input
              autoComplete="username"
              name="account"
              onChange={(event) => setAccount(event.currentTarget.value)}
              required
              value={account}
            />
          </label>
        </p>
        <p>
          <label>
            密码
            <input
              autoComplete="current-password"
              name="password"
              ref={passwordRef}
              required
              type="password"
            />
          </label>
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <button disabled={submitting} type="submit">
          登录
        </button>
      </form>
    </main>
  );
}
