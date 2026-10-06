import { describe, expect, it } from "vitest";
import { blocksNewSession } from "../src/features/chat/ownership.js";
import type { PendingCreateSend } from "../src/features/chat/types.js";
import type { ApiClient } from "../src/lib/api.js";

// 「新建会话」在首次发送的「创建—发送」交接尚未落定时不导航（fix-new-session-handoff 1.2，#872）。
// 判定只看登记本身，不看 prompt 请求是否已经发出。

const client = {} as ApiClient;
const otherClient = {} as ApiClient;
const CREATED = "d".repeat(32);
const OTHER = "a".repeat(32);

/** 欢迎态首次发送、创建已返回、prompt 尚未受理的登记。 */
function registration(overrides: Partial<PendingCreateSend> = {}): PendingCreateSend {
  return {
    accepted: false,
    client,
    generation: 1,
    originSessionId: null,
    prompt: "你好",
    sessionId: CREATED,
    ...overrides,
  };
}

describe("新建会话 是否被未落定的交接拦住", () => {
  it.each<[string, PendingCreateSend | null, ApiClient, string | null, boolean]>([
    ["无登记", null, client, CREATED, false],
    [
      "创建在途（会话 id 为空，页面仍在欢迎态）",
      registration({ sessionId: null }),
      client,
      null,
      false,
    ],
    ["创建已返回、prompt 未派发", registration(), client, CREATED, true],
    // 派发不改登记：与上一行是同一份登记，判定不因 prompt 请求是否已发出而不同。
    ["prompt 已派发、未受理", registration({ generation: 2 }), client, CREATED, true],
    ["prompt 已受理", registration({ accepted: true }), client, CREATED, false],
    ["登记属于另一个 client", registration(), otherClient, CREATED, false],
    ["页面选中的是另一个会话", registration(), client, OTHER, false],
    ["页面在欢迎态而登记已有会话 id", registration(), client, null, false],
    [
      "既有会话上的发送（originSessionId 非空）",
      registration({ originSessionId: CREATED }),
      client,
      CREATED,
      false,
    ],
  ])("%s", (_state, pending, pageClient, sessionId, blocked) => {
    expect(blocksNewSession(pending, pageClient, sessionId)).toBe(blocked);
  });
});
