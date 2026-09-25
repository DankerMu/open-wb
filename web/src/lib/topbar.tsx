import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type TopbarContextValue = {
  breadcrumb: string | null;
  setBreadcrumb: (next: string | null) => void;
};

const TopbarContext = createContext<TopbarContextValue | null>(null);

/** shell 持有的顶栏状态：页面经 `useTopbar` 上报，`Topbar` 经 `useTopbarBreadcrumb` 读取。 */
export function TopbarProvider({ children }: { children: ReactNode }) {
  const [breadcrumb, setBreadcrumb] = useState<string | null>(null);
  const value = useMemo(() => ({ breadcrumb, setBreadcrumb }), [breadcrumb]);
  return <TopbarContext.Provider value={value}>{children}</TopbarContext.Provider>;
}

/** 页面向 shell 上报面包屑；Provider 外 no-op。变更即更新，卸载或改为 undefined 时清空。 */
export function useTopbar({ breadcrumb }: { breadcrumb?: string | undefined }): void {
  const set = useContext(TopbarContext)?.setBreadcrumb;
  useEffect(() => {
    if (!set || breadcrumb === undefined) return;
    set(breadcrumb);
    return () => set(null);
  }, [set, breadcrumb]);
}

export function useTopbarBreadcrumb(): string | null {
  return useContext(TopbarContext)?.breadcrumb ?? null;
}
