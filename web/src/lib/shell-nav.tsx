import { createContext, type ReactNode, useContext } from "react";

type RequestMainWidth = (needed: number) => void;

const NO_REQUEST: RequestMainWidth = () => {};

const ShellNavContext = createContext<RequestMainWidth>(NO_REQUEST);

/**
 * 外壳给页面的一个请求口（workspace-sidebar「布局与开合」）：页面说「主区至少要这么宽」（像素），
 * 外壳自己决定怎么腾——目前只有折叠外壳侧栏这一招。页面不知道外壳侧栏，外壳不知道是哪块面板在要。
 * `requestMainWidth` 须是稳定引用，否则每次外壳渲染都会重渲染读它的页面。
 */
export function ShellNavProvider({
  children,
  requestMainWidth,
}: {
  children: ReactNode;
  requestMainWidth: RequestMainWidth;
}) {
  return <ShellNavContext.Provider value={requestMainWidth}>{children}</ShellNavContext.Provider>;
}

/** 页面取请求口；Provider 外（单测里直接渲染页面或 hook）是 no-op。 */
export function useRequestMainWidth(): RequestMainWidth {
  return useContext(ShellNavContext);
}
