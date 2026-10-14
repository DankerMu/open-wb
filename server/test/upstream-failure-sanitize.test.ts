/**
 * Issue #909 task 1.2: core/upstream-failure.ts. Expected strings are the literals of
 * upstream-failure「上游原文净化」(its four scenarios verbatim), one case per sanitiser step, the
 * secret-list rules, and the byte-fixed envelopes of model-proxy「透传端点与 bearer 鉴权」.
 *
 * The three omp patterns below are copied verbatim from omp v18.0.10
 * (`resource/oh-my-pi/packages/ai/src/error/flags.ts`, commit 33cc6b9: `TIMEOUT_PATTERN` :154,
 * `TRANSIENT_TRANSPORT_PATTERN` :158-159, `AUTH_FAILURE_PATTERN` :160-161). omp's session layer
 * retries a failure whose text matches the first two (design D7); an omp upgrade re-checks them.
 */
import { describe, expect, it } from "vitest";
import {
  connectReply,
  gatewayReply,
  NO_CONNECT_REPLY,
  NO_RESPONSE_REPLY,
  sanitizeUpstreamText,
  statusReply,
  TRUNCATED_MARK,
  upstreamExcerpt,
  upstreamSecretList,
} from "../src/core/upstream-failure.js";

const TIMEOUT_PATTERN = /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i;
const TRANSIENT_TRANSPORT_PATTERN =
  /\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|provider.?returned.?error|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable.?to.?connect\.\s*is the computer able to access the url\?|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|nghttp2_(?:internal_error|refused_stream)|stream closed with error code nghttp2_(?:internal_error|refused_stream)|malformed.?function.?call/i;
const AUTH_FAILURE_PATTERN =
  /\b(?:401|403|unauthorized|forbidden|authentication|auth[_ ]?unavailable|no auth available|(?:invalid|no)[_ ]?api[_ ]?key)\b/i;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** How omp v18.0.10 spells a JSON error envelope in `errorMessage` (design D6, 实测 shape). */
function ompErrorMessage(status: number, body: string): string {
  const { error } = JSON.parse(body) as { error: { message: string; type: string; param: string } };
  return `${String(status)} ${error.message}\n${error.message} (type=${error.type} param=${error.param})`;
}

function points(text: string): number {
  return Array.from(text).length;
}

describe("upstream-failure「上游原文净化」scenarios", () => {
  it("去密钥与去路径", () => {
    const text =
      "401 bad key k-123\nAuthorization: Bearer abc.def\nuse sk-AAAAAAAAAAAAAAAAAAAA\nraw-http-request=/srv/state/xdg/state/omp/logs/http-400-requests/1.json\r\nend\u0007";
    expect(sanitizeUpstreamText(text, ["k-123"])).toBe(
      "401 bad key [已移除]\nAuthorization: Bearer [已移除]\nuse [已移除]\nend",
    );
  });

  it("被控制字符劈开的密钥", () => {
    expect(
      sanitizeUpstreamText("x k-\u0000123 y\nraw-\u0000http-request=/srv/a.json", ["k-123"]),
    ).toBe("x [已移除] y");
  });

  it("上游地址与服务器路径", () => {
    const secrets = upstreamSecretList({
      apiKey: "k-123",
      baseUrl: "https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001",
      paths: ["/srv/wb/state", "/data/wb/state", "/srv/wb/sandbox"],
    });
    const text =
      "GET https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001 failed; POST /tenant-0123456789/v1/chat/completions; p4ss-secret; tenant-0123456789; org=acme-0001; /srv/wb/state/omp/a.json; /data/wb/state/b; /srv/wb/sandbox/ws/c.txt; gw.example v1";
    expect(sanitizeUpstreamText(text, secrets)).toBe(
      "GET [已移除] failed; POST [已移除]/chat/completions; [已移除]; [已移除]; [已移除]; [已移除]/omp/a.json; [已移除]/b; [已移除]/ws/c.txt; gw.example v1",
    );
  });

  it("截断上限", () => {
    const exact = "字".repeat(2000);
    expect(sanitizeUpstreamText(exact, [])).toBe(exact);
    const over = "字".repeat(2001);
    const cut = sanitizeUpstreamText(over, []);
    expect(cut).toBe(`${"字".repeat(1994)}${TRUNCATED_MARK}`);
    expect(points(cut)).toBe(2000);
    // Code units 1994 and 1995 are the two halves of one astral character.
    const astral = `${"a".repeat(1993)}😀${"b".repeat(100)}`;
    const kept = sanitizeUpstreamText(astral, []);
    expect(kept).toBe(`${"a".repeat(1993)}😀${TRUNCATED_MARK}`);
    expect(LONE_SURROGATE.test(kept)).toBe(false);
  });
});

describe("sanitiser steps, one case each", () => {
  it("step 1 turns CRLF, CR, U+2028 and U+2029 into LF and deletes the controls, keeping tab", () => {
    const text = "a\r\nb\rc\u2028d\u2029e\u0000\u0008\u000b\u001f\u007ff\tg";
    expect(sanitizeUpstreamText(text, [])).toBe("a\nb\nc\nd\nef\tg");
  });

  it("step 2 deletes only lines that start with an omp dump key", () => {
    const text =
      "head\nraw-http-request=/p/1.json\nraw-http-request-save-failed=/p/2.json\nsee raw-http-request=/p/3.json\ntail";
    expect(sanitizeUpstreamText(text, [])).toBe("head\nsee raw-http-request=/p/3.json\ntail");
  });

  it("step 3 replaces every occurrence, longer secrets first, of whatever length", () => {
    expect(sanitizeUpstreamText("abcdef abc", ["abc", "abcdef"])).toBe("[已移除] [已移除]");
    // The test key `fake` also takes the word out of ordinary text (design D9 step 3).
    expect(sanitizeUpstreamText("fake upstream fakery", ["fake"])).toBe(
      "[已移除] upstream [已移除]ry",
    );
    // A secret is normalised by step 1 before it is looked for.
    expect(sanitizeUpstreamText("x\ny", ["x\r\ny"])).toBe("[已移除]");
    expect(sanitizeUpstreamText("abc", [""])).toBe("abc");
  });

  it("step 3 with an empty secret list still runs the other steps", () => {
    expect(sanitizeUpstreamText("ok\u0007 sk-0123456789abcdef \n", [])).toBe("ok [已移除]");
  });

  it("step 4 replaces any-case Bearer values and sk- keys of at least 16 characters", () => {
    expect(sanitizeUpstreamText("auth: bearer abc.def x", [])).toBe("auth: Bearer [已移除] x");
    expect(sanitizeUpstreamText("sk-0123456789abcde sk-0123456789abcdef_-", [])).toBe(
      "sk-0123456789abcde [已移除]",
    );
  });

  it("step 5 drops trailing whitespace", () => {
    expect(sanitizeUpstreamText("abc  \n\t \n", [])).toBe("abc");
  });
});

describe("upstreamSecretList", () => {
  it("lists userinfo without a password segment, and no pathname `/` or empty query", () => {
    expect(
      upstreamSecretList({ apiKey: "k", baseUrl: "https://tok-0123@gw.example/", paths: [] }),
    ).toEqual(["k", "https://tok-0123@gw.example/", "tok-0123"]);
  });

  it("lists a path given twice (a realpath equal to its original) once", () => {
    expect(upstreamSecretList({ paths: ["/srv/wb/state", "/srv/wb/state"] })).toEqual([
      "/srv/wb/state",
    ]);
  });

  it("lists the pathname and only its segments of at least 8 characters, never the host", () => {
    expect(
      upstreamSecretList({
        apiKey: "",
        baseUrl: "http://127.0.0.1:9/tenant-0123456789/v1",
        paths: [],
      }),
    ).toEqual([
      "http://127.0.0.1:9/tenant-0123456789/v1",
      "/tenant-0123456789/v1",
      "tenant-0123456789",
    ]);
  });
});

describe("failure envelopes", () => {
  it("answers the three 424 bodies byte for byte", () => {
    expect(NO_RESPONSE_REPLY).toEqual({
      status: 424,
      body: '{"error":{"message":"模型服务在 120 秒内没有返回响应","type":"wb_upstream","param":"no_response"}}',
    });
    expect(NO_CONNECT_REPLY).toEqual({
      status: 424,
      body: '{"error":{"message":"模型服务在 10 秒内没有建立连接","type":"wb_upstream","param":"no_connect"}}',
    });
    expect(gatewayReply(504)).toEqual({
      status: 424,
      body: '{"error":{"message":"模型服务的网关等待模型超时","type":"wb_upstream","param":"gateway_504"}}',
    });
    expect(gatewayReply(524).body).toBe(
      '{"error":{"message":"模型服务的网关等待模型超时","type":"wb_upstream","param":"gateway_524"}}',
    );
  });

  it("composes no 424 text that omp's session layer would retry or flag as auth", () => {
    for (const reply of [
      NO_RESPONSE_REPLY,
      NO_CONNECT_REPLY,
      gatewayReply(504),
      gatewayReply(524),
    ]) {
      const text = ompErrorMessage(reply.status, reply.body);
      expect(text).toMatch(
        /\(type=wb_upstream param=(?:no_response|no_connect|gateway_5[02]4)\)$/u,
      );
      expect(TRANSIENT_TRANSPORT_PATTERN.test(text)).toBe(false);
      expect(TIMEOUT_PATTERN.test(text)).toBe(false);
      expect(AUTH_FAILURE_PATTERN.test(text)).toBe(false);
    }
    // The copied patterns do bite: the names the design turned down would be retried.
    expect(TRANSIENT_TRANSPORT_PATTERN.test("param=connect_timeout")).toBe(true);
    expect(TRANSIENT_TRANSPORT_PATTERN.test("param=status.504")).toBe(true);
    expect(TRANSIENT_TRANSPORT_PATTERN.test(ompErrorMessage(502, statusReply(503, "").body))).toBe(
      true,
    );
  });

  it("spells the retryable 502 status and connect answers", () => {
    expect(statusReply(503, "busy")).toEqual({
      status: 502,
      body: '{"error":{"message":"模型服务返回 HTTP 503：busy","type":"wb_upstream","param":"status.503"}}',
    });
    expect(JSON.parse(statusReply(500, "").body).error.message).toBe("模型服务返回 HTTP 500");
    expect(connectReply("ECONNREFUSED")).toEqual({
      status: 502,
      body: '{"error":{"message":"无法连接模型服务（ECONNREFUSED）","type":"wb_upstream","param":"connect.ECONNREFUSED"}}',
    });
    expect(JSON.parse(connectReply("err-x.Y_1").body).error.param).toBe("connect.Y_1");
    expect(JSON.parse(connectReply(undefined).body).error.param).toBe("connect.UNKNOWN");
    expect(JSON.parse(connectReply("a-b").body).error.param).toBe("connect.UNKNOWN");
    expect(JSON.parse(connectReply("A".repeat(70)).body).error.param).toBe(
      `connect.${"A".repeat(64)}`,
    );
  });

  it("folds line feeds and tabs of the excerpt into one space and caps it at 1000 code points", () => {
    expect(upstreamExcerpt("a\n\n\tb\nc k-1", ["k-1"])).toBe("a b c [已移除]");
    const cut = upstreamExcerpt("字".repeat(1001), []);
    expect(cut).toBe(`${"字".repeat(994)}${TRUNCATED_MARK}`);
    expect(points(upstreamExcerpt("字".repeat(1000), []))).toBe(1000);
  });
});
