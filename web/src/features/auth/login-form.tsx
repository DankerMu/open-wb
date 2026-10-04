import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark, Icon } from "@/ui/index";
import { DEV_PASSWORD } from "./dev-accounts";
import { useAuth } from "./provider";
import { QuickLogin } from "./quick-login";

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 账号框 mount 即聚焦（不用 JSX 自动聚焦属性：biome a11y/noAutofocus）。
  useEffect(() => {
    accountRef.current?.focus();
  }, []);

  /** 表单提交与快捷卡共用：同一把锁、同一错误行、同样回填账号并清空密码。 */
  async function performLogin(submittedAccount: string, password: string) {
    if (lockedRef.current) {
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

    await performLogin(submittedAccount, password);
  }

  return (
    // 可滚动容器 + 卡片 m-auto 居中：内容高于视口时顶部不被裁切。
    <main className="flex h-dvh overflow-y-auto bg-(--wb-home-bg-primary) px-4 py-6">
      <Card className="m-auto w-90 max-w-[calc(100vw-2rem)] gap-0 pt-7 shadow-(--wb-shadow-dialog) [--card-spacing:--spacing(6)] max-[760px]:[--card-spacing:--spacing(4)]">
        <CardHeader className="justify-items-center gap-0 text-center">
          <div className="mb-3.5 flex justify-center">
            <BrandMark size={26} wordmark />
          </div>
          <h1 className="text-lg leading-[26px] font-semibold">登录 WorkBuddy</h1>
          <p className="mt-1 text-xs text-(--wb-text-tertiary)">内网统一身份 · 本实例不出网</p>
        </CardHeader>
        <CardContent className="mt-4.5">
          <form className="flex flex-col gap-3.5" onSubmit={submit}>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[13px]" htmlFor={accountId}>
                账号
              </Label>
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
            <div className="flex flex-col gap-1.5">
              <Label className="text-[13px]" htmlFor={passwordId}>
                密码
              </Label>
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
              <p
                className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
                role="alert"
              >
                <Icon name="triangle-alert" size={12} />
                {error}
              </p>
            ) : null}
            <Button className="mt-1 w-full" disabled={submitting} size="lg" type="submit">
              {submitting ? "正在登录" : "登录"}
            </Button>
          </form>
        </CardContent>
        <QuickLogin
          disabled={submitting}
          onPick={(picked) => {
            void performLogin(picked, DEV_PASSWORD);
          }}
        />
      </Card>
    </main>
  );
}
