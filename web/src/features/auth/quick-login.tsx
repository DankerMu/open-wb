import { Fragment, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { createApiClient } from "@/lib/api";
import { DEV_ACCOUNTS, DEV_PASSWORD, DEV_STUB_PROVIDER } from "./dev-accounts";

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
      <CardContent>
        <p className="mt-3 text-center text-[11.5px] leading-[18px] text-(--wb-text-tertiary) [&_b]:font-semibold [&_b]:text-muted-foreground">
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
      </CardContent>
      {/* 分隔线是 CardFooter 自带的裸 border-t，颜色取 theme.css 的边框色基线。 */}
      <CardFooter className="mt-3.5 py-3">
        <ul aria-label="快捷登录" className="flex w-full flex-col gap-1.5">
          {DEV_ACCOUNTS.map(({ account, role }) => (
            <li key={account}>
              <Button
                className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 text-left hover:border-border"
                disabled={disabled}
                onClick={() => onPick(account)}
                type="button"
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-(--wb-brand-primary) text-xs font-bold text-(--wb-bg-primary)"
                >
                  {account.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] leading-[18px] font-medium">{account}</span>{" "}
                  <span className="text-[11px] leading-[15px] font-normal text-muted-foreground">
                    {role}
                  </span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </CardFooter>
    </>
  );
}
