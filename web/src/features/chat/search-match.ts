/**
 * 对话内搜索的匹配（issue 538）：按转录顺序返回 `content` 含 `query` 的消息 id。两侧各自
 * `toLowerCase()` 后做子串判断；`query` 按字面使用（不去首尾空白、不是正则），空串无匹配。
 * 只读 `id` 与 `content`：步骤、深度思考、审批与错误文案不参与。按消息计数，一条消息内出现
 * 多次也只返回一次。
 */
export function matchMessages(
  messages: readonly { id: number; content: string }[],
  query: string,
): number[] {
  if (query === "") return [];
  const needle = query.toLowerCase();
  return messages
    .filter((message) => message.content.toLowerCase().includes(needle))
    .map((message) => message.id);
}
