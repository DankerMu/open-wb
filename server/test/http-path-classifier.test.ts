import { describe, expect, it } from "vitest";
import { rewriteUntrustedUrl } from "../src/http/index.js";
import { classifyUrlPathname, MAX_PERCENT_DECODE_PASSES } from "../src/http/path-classifier.js";

/**
 * 共享 bounded classifier/rewrite 接缝（`http/path-classifier.ts` 为唯一 owner）的
 * 直接单测：real-app 侧的守卫/静态/fallback 终态在 `http-guard-paths.test.ts`。
 */
describe("shared path classifier", () => {
  /**
   * Phase-2 回归：percent-decode 产出路由分隔符 `?` 时，API namespace 必须按 **routed**
   * pathname（解码串中第一个 `?` 之前）判定，而 rewrite/router 消费的也正是这个身份。
   * 否则 classifier 看整串 `/api?x=1` 判 non-API，rewrite 却把请求路由到 exact `/api`，
   * 默认拒绝守卫随之失效。`pathname` 输出仍是完整规范化解码值（静态与 fallback 消费同一值），
   * decode 轮次与 unsafe 边界不变。`%23` 在受支持的 Node HTTP 栈上不是分隔符，故
   * `/api%23frag` 的 routed pathname 是 `/api#frag` → 仍非 API，不得扩大成语义片段处理。
   */
  it("decoded query delimiter 归属 routed pathname：1–4 轮 encoded exact /api?x=1 均为 API", () => {
    const INTERNAL_API_MISS = "/api/__workbuddy_not_found__";
    const DELIMITER_ROWS: ReadonlyArray<{
      input: string;
      decodePasses: number;
      pathname: string | undefined;
      isApiNamespace: boolean;
      rewrite: string;
    }> = [
      {
        input: "/api%3Fx=1",
        decodePasses: 1,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "/%61pi%3Fx=1",
        decodePasses: 1,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "/api%253Fx=1",
        decodePasses: 2,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "/api%25253Fx=1",
        decodePasses: 3,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "/api%2525253Fx=1",
        decodePasses: 4,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "%2Fapi%3Fx%3D1",
        decodePasses: 1,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "%252Fapi%253Fx%253D1",
        decodePasses: 2,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "%25252Fapi%25253Fx%25253D1",
        decodePasses: 3,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      {
        input: "%2525252Fapi%2525253Fx%2525253D1",
        decodePasses: 4,
        pathname: "/api?x=1",
        isApiNamespace: true,
        rewrite: INTERNAL_API_MISS,
      },
      // 超出有界解码：fail closed 到 internal API miss，绝不按层继续解。
      {
        input: "%252525252Fapi%252525253Fx%252525253D1",
        decodePasses: MAX_PERCENT_DECODE_PASSES,
        pathname: undefined,
        isApiNamespace: false,
        rewrite: INTERNAL_API_MISS,
      },
      // 非 API 兄弟身份：`#` 不是分隔符，encoded non-API query 保持一轮规范化 fallback。
      {
        input: "/api%23frag",
        decodePasses: 1,
        pathname: "/api#frag",
        isApiNamespace: false,
        rewrite: "/api#frag",
      },
      {
        input: "/files%3Ftab=1",
        decodePasses: 1,
        pathname: "/files?tab=1",
        isApiNamespace: false,
        rewrite: "/files?tab=1",
      },
      {
        input: "/assets/site%252Ecss",
        decodePasses: 2,
        pathname: "/assets/site.css",
        isApiNamespace: false,
        rewrite: INTERNAL_API_MISS,
      },
    ];

    for (const row of DELIMITER_ROWS) {
      const classification = classifyUrlPathname(row.input);
      expect(classification.decodePasses, row.input).toBe(row.decodePasses);
      expect(classification.isApiNamespace, row.input).toBe(row.isApiNamespace);
      expect(classification.pathname, row.input).toBe(row.pathname);
      expect(rewriteUntrustedUrl(row.input), row.input).toBe(row.rewrite);
    }

    // routed 身份与整串身份只在 query 处分歧：exact /api、尾斜杠与 lookalike 判定不变。
    expect(classifyUrlPathname("/api")).toMatchObject({ isApiNamespace: true });
    expect(classifyUrlPathname("/api/")).toMatchObject({ isApiNamespace: true });
    expect(classifyUrlPathname("/apiary")).toMatchObject({ isApiNamespace: false });
    expect(rewriteUntrustedUrl("/api%3Fx=1&y=2")).toBe(INTERNAL_API_MISS);
  });

  /** API 前缀 lookalike 与 non-API 兄弟绝不被判定吞掉：豁免扩张的唯一入口是 matched route 表。 */
  it("lookalike 与 non-API 兄弟始终 non-API", () => {
    for (const input of [
      "/apiary",
      "/api-thing",
      "/apifoo",
      "/apiX",
      "/apiX/y",
      "/api%23frag",
      "/not-an-api",
      "/files%3Ftab=1",
    ]) {
      expect(classifyUrlPathname(input).isApiNamespace, input).toBe(false);
    }
    expect(classifyUrlPathname("/api").isApiNamespace).toBe(true);
    expect(classifyUrlPathname("/api\\no-such").isApiNamespace).toBe(true);
  });
});
