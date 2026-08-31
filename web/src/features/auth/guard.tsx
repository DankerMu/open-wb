import type { PropsWithChildren } from "react";
import { LoginForm } from "./login-form.js";
import { useAuth } from "./provider.js";

export function AuthGuard({ children }: PropsWithChildren) {
  const { status } = useAuth();

  if (status === "loading") {
    return <p role="status">正在检查登录状态</p>;
  }

  if (status === "unauthenticated") {
    return <LoginForm />;
  }

  return children;
}
