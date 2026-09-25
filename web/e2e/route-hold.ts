// Hold one browser request behind a Playwright route until the walk releases it.

import type { Page } from "@playwright/test";

export type RouteHold = {
  /** True once a request matching the pattern reached the handler and is being held. */
  held(): boolean;
  /** Forward the held request (if any), wait for that forward, then remove the route. */
  release(): Promise<void>;
};

export async function holdRoute(page: Page, pattern: string): Promise<RouteHold> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  // unroute 清空拦截模式会让挂起请求被自动放行，与处理器随后的 continue 竞争
  // （Route is already handled），所以放行时先等处理器转发的 continue 完成再 unroute。
  let forwarded: Promise<void> | undefined;
  await page.route(pattern, (route) => {
    forwarded = gate.then(() => route.continue());
    return forwarded;
  });
  return {
    held: () => forwarded !== undefined,
    async release() {
      open();
      await forwarded;
      await page.unroute(pattern);
    },
  };
}
